//! A select prompt whose lines can change while it is open (e.g. latency
//! results arriving per proxy), with optional group header rows,
//! type-to-filter, multi-select and typed custom values. The prompt owns the
//! terminal on its own thread; the host polls it and pushes per-row suffixes:
//!
//!   masir_prompt_live_select_start(msg, rows_json, default, flags)  -> 0 | -2 | -3
//!   masir_prompt_live_select_set(row, text, loading)                -> 0 | -2
//!   masir_prompt_live_select_viewport(out)                          -> bytes of "3,4,5" (rows on screen) | -2 | -3
//!   masir_prompt_live_select_poll()                                 -> PENDING | -1 | -2 | CUSTOM | row index | 0 (multi done)
//!   masir_prompt_live_select_selection(out)                         -> bytes of {"checked":[..],"custom":[..]} | -2 | -3
//!
//! `rows_json` is `[{"label", "header"?, "search"?, "checked"?}, ...]`.
//! `flags`: bit 0 = multi-select (Space toggles, Enter confirms), bit 1 =
//! allow typed values (a "+ add" row offers the filter text when nothing
//! matches it exactly). Header rows are not selectable; ←/→ (or Tab) jump
//! between groups. Typing filters rows by `search` (default: the label
//! without colors), so display-reordered (RTL) labels still match. A row with
//! `loading` shows a spinner; otherwise `text` (may carry ANSI colors) is
//! appended to its label. `viewport` tells the host which rows are on screen.
//! Clack UI:
//! │
//! ◆  Choose active outbound
//! │  ▸ work · 12 configs
//! │    ● 🇩🇪 Germany  212ms
//! │    ○ 🇳🇱 Netherlands  ⠋
//! │  ↑/↓ navigate • ←/→ group • type to filter • Enter: confirm
//! └

use crossterm::cursor;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal;
use serde::{Deserialize, Serialize};
use std::io::{self, IsTerminal, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::prompt::{BOLD, CYAN, GRAY, GREEN, RESET, RawGuard, clear_previous_lines, parse_str};

/// `poll` result while the user has not answered yet.
const PENDING: i32 = -100;
/// `poll` result in single-select mode when the user picked the typed value (read it with `selection`).
const CUSTOM_PICKED: i32 = -10;
/// stdin is not a terminal: the host should fall back to its default choice.
const NOT_INTERACTIVE: i32 = -3;
const ERROR: i32 = -2;
const BUFFER_TOO_SMALL: i32 = -3;
const CANCELLED: i32 = -1;
const MULTI_DONE: i32 = 0;
const FLAG_MULTI: u32 = 1;
const FLAG_CUSTOM: u32 = 2;
/// Cursor value of the "+ add" row (never a real row index).
const ADD_ROW: usize = usize::MAX;
const TICK: Duration = Duration::from_millis(80);
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/// Lines around the list: blank, message, filter, two scroll markers, help, footer.
const CHROME_LINES: usize = 7;
const MIN_WINDOW: usize = 5;
const MAX_WINDOW: usize = 20;
/// Selected values named in the final summary line before "+N more".
const SUMMARY_ITEMS: usize = 3;

#[derive(Deserialize)]
struct RowSpec {
    label: String,
    #[serde(default)]
    header: bool,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    checked: bool,
}

struct Row {
    label: String,
    header: bool,
    /// Lowercased text the filter matches against.
    search: String,
    checked: bool,
    suffix: String,
    loading: bool,
}

struct Session {
    rows: Vec<Row>,
    /// Rows from here on were typed in by the user (multi-select custom values).
    custom_start: usize,
    multi: bool,
    allow_custom: bool,
    filter: String,
    /// Original indices of the rows on screen, updated on every draw.
    on_screen: Vec<usize>,
    /// Set by the prompt thread once it has released the terminal.
    result: Option<i32>,
    /// The answer's details for `selection`, set with `result`.
    selection: Option<String>,
    dirty: bool,
}

#[derive(Serialize)]
struct Selection {
    checked: Vec<usize>,
    custom: Vec<String>,
}

static SESSION: Mutex<Option<Arc<Mutex<Session>>>> = Mutex::new(None);
/// The last finished prompt's selection (the session is gone once polled).
static LAST_SELECTION: Mutex<Option<String>> = Mutex::new(None);

/// Text without ANSI escape sequences (colors), for matching.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ ... final byte in @..~
            if chars.next() == Some('[') {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn row_line(row: &Row, frame: usize) -> String {
    if row.loading {
        format!("{}  {GRAY}{}{RESET}", row.label, SPINNER[frame % SPINNER.len()])
    } else if row.suffix.is_empty() {
        row.label.clone()
    } else {
        format!("{}  {}", row.label, row.suffix)
    }
}

/// Rows that pass the filter, in order: matching items, plus the header of any group with a match.
fn visible_rows(rows: &[Row], filter: &str) -> Vec<usize> {
    if filter.is_empty() {
        return (0..rows.len()).collect();
    }
    let needle = filter.to_lowercase();
    let mut visible = Vec::new();
    let mut pending_header: Option<usize> = None;
    for (idx, row) in rows.iter().enumerate() {
        if row.header {
            pending_header = Some(idx);
        } else if row.search.contains(&needle) {
            if let Some(header) = pending_header.take() {
                visible.push(header);
            }
            visible.push(idx);
        }
    }
    visible
}

impl Session {
    /// The typed text, if the "+ add" row should be offered for it.
    fn add_candidate(&self) -> Option<String> {
        let typed = self.filter.trim();
        if !self.allow_custom || typed.is_empty() {
            return None;
        }
        let needle = typed.to_lowercase();
        let exists = self.rows.iter().any(|row| !row.header && (row.search == needle || strip_ansi(&row.label).to_lowercase() == needle));
        (!exists).then(|| typed.to_owned())
    }

    /// Navigable entries in display order: the "+ add" row first when offered.
    fn entries(&self) -> Vec<usize> {
        let mut entries = Vec::new();
        if self.add_candidate().is_some() {
            entries.push(ADD_ROW);
        }
        entries.extend(visible_rows(&self.rows, &self.filter));
        entries
    }

    fn is_header(&self, idx: usize) -> bool {
        idx != ADD_ROW && self.rows[idx].header
    }

    /// Turn the typed text into a checked row of its own (multi-select).
    fn add_custom_row(&mut self) -> Option<usize> {
        let value = self.add_candidate()?;
        self.rows.push(Row { search: value.to_lowercase(), label: value, header: false, checked: true, suffix: String::new(), loading: false });
        self.filter.clear();
        Some(self.rows.len() - 1)
    }

    fn selection_json(&self, extra_custom: Option<String>) -> String {
        let mut selection = Selection { checked: Vec::new(), custom: Vec::new() };
        for (idx, row) in self.rows.iter().enumerate() {
            if row.checked {
                if idx >= self.custom_start {
                    selection.custom.push(row.label.clone());
                } else {
                    selection.checked.push(idx);
                }
            }
        }
        if let Some(value) = extra_custom {
            selection.custom.push(value);
        }
        serde_json::to_string(&selection).unwrap_or_default()
    }

    fn checked_labels(&self) -> Vec<String> {
        self.rows.iter().filter(|row| row.checked).map(|row| strip_ansi(&row.label)).collect()
    }
}

/// Rows that fit the terminal, so a long list scrolls instead of overflowing.
fn window_size() -> usize {
    let rows = terminal::size().map(|(_, h)| h as usize).unwrap_or(MIN_WINDOW + CHROME_LINES);
    rows.saturating_sub(CHROME_LINES).clamp(MIN_WINDOW, MAX_WINDOW)
}

/// First position of a window of `size` that keeps position `cur` visible, centred when possible.
fn window_start(cur: usize, total: usize, size: usize) -> usize {
    if total <= size {
        return 0;
    }
    let half = size / 2;
    if cur <= half {
        0
    } else if cur + (size - half) >= total {
        total - size
    } else {
        cur - half
    }
}

/// What the final (answered) frame shows under the message.
enum Answer {
    Row(usize),
    Typed(String),
    Many,
}

fn summary(labels: &[String]) -> String {
    if labels.is_empty() {
        return format!("{GRAY}nothing selected{RESET}");
    }
    let shown = labels.iter().take(SUMMARY_ITEMS).cloned().collect::<Vec<_>>().join(", ");
    if labels.len() > SUMMARY_ITEMS { format!("{shown} {GRAY}+{} more{RESET}", labels.len() - SUMMARY_ITEMS) } else { shown }
}

/// Draw the prompt in one write (less flicker on frequent redraws); returns the line count.
fn render(msg: &str, session: &Mutex<Session>, cur: Option<usize>, prev_count: usize, answer: Option<Answer>, frame: usize) -> usize {
    let size = window_size();
    let mut buf = String::new();
    let mut count = 0;
    {
        let Ok(mut s) = session.lock() else {
            return prev_count;
        };
        if let Some(answer) = answer {
            let chosen = match answer {
                Answer::Row(idx) => row_line(&s.rows[idx], frame),
                Answer::Typed(value) => value,
                Answer::Many => summary(&s.checked_labels()),
            };
            buf.push_str(&format!("\r{GRAY}│{RESET}\r\n\r{GREEN}◇{RESET}  {msg}\r\n\r{GRAY}│{RESET}  {chosen}\r\n"));
            count = 3;
        } else {
            let entries = s.entries();
            let pos = cur.and_then(|c| entries.iter().position(|&idx| idx == c)).unwrap_or(0);
            let start = window_start(pos, entries.len(), size);
            let end = (start + size).min(entries.len());
            s.on_screen = entries[start..end].iter().copied().filter(|&idx| idx != ADD_ROW).collect();

            let picked = if s.multi { format!(" {GRAY}· {} selected{RESET}", s.rows.iter().filter(|r| r.checked).count()) } else { String::new() };
            buf.push_str(&format!("\r{GRAY}│{RESET}\r\n\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}{picked}\r\n"));
            count += 2;
            if !s.filter.is_empty() {
                let matches = entries.iter().filter(|&&idx| idx != ADD_ROW && !s.rows[idx].header).count();
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}filter:{RESET} {}{GRAY}▏ {matches} match{}{RESET}\r\n", s.filter, if matches == 1 { "" } else { "es" }));
                count += 1;
            }
            if start > 0 {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}↑ {start} more{RESET}\r\n"));
                count += 1;
            }
            for &idx in &entries[start..end] {
                let selected = Some(idx) == cur;
                if idx == ADD_ROW {
                    let value = s.add_candidate().unwrap_or_default();
                    let marker = if selected { format!("{GREEN}+{RESET}") } else { format!("{GRAY}+{RESET}") };
                    buf.push_str(&format!("\r{CYAN}│{RESET}    {marker} {BOLD}add “{value}”{RESET}\r\n"));
                    count += 1;
                    continue;
                }
                let row = &s.rows[idx];
                let line = row_line(row, frame);
                if row.header {
                    buf.push_str(&format!("\r{CYAN}│{RESET}  {CYAN}▸{RESET} {line}\r\n"));
                } else if s.multi {
                    let box_ = if row.checked { format!("{GREEN}◼{RESET}") } else { format!("{GRAY}◻{RESET}") };
                    let text = if selected { format!("{BOLD}{line}{RESET}") } else { line };
                    let pointer = if selected { format!("{CYAN}›{RESET}") } else { " ".to_owned() };
                    buf.push_str(&format!("\r{CYAN}│{RESET}  {pointer} {box_} {text}\r\n"));
                } else if selected {
                    buf.push_str(&format!("\r{CYAN}│{RESET}    {GREEN}●{RESET} {BOLD}{line}{RESET}\r\n"));
                } else {
                    buf.push_str(&format!("\r{CYAN}│{RESET}    {GRAY}○{RESET} {line}\r\n"));
                }
                count += 1;
            }
            if entries.is_empty() {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}no matches{RESET}\r\n"));
                count += 1;
            }
            if end < entries.len() {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}↓ {} more{RESET}\r\n", entries.len() - end));
                count += 1;
            }
            let mut help = vec!["↑/↓ navigate"];
            if s.rows.iter().any(|row| row.header) {
                help.push("←/→ group");
            }
            if s.multi {
                help.push("space select");
            }
            help.push(if s.allow_custom { "type to filter or add" } else { "type to filter" });
            help.push("enter confirm");
            buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}{}{RESET}\r\n\r{CYAN}└{RESET}\r\n", help.join(" • ")));
            count += 2;
        }
    }

    clear_previous_lines(prev_count);
    let mut out = io::stdout();
    let _ = out.write_all(buf.as_bytes());
    let _ = execute!(out, cursor::MoveToColumn(0));
    let _ = out.flush();
    count
}

/// Navigation over the navigable entries (row indices, or `ADD_ROW`).
struct Nav<'a> {
    entries: &'a [usize],
    is_header: &'a dyn Fn(usize) -> bool,
}

impl Nav<'_> {
    fn items(&self) -> impl Iterator<Item = usize> + '_ {
        self.entries.iter().copied().filter(|&idx| !(self.is_header)(idx))
    }

    fn position(&self, cur: usize) -> Option<usize> {
        self.entries.iter().position(|&idx| idx == cur)
    }

    /// Next/previous selectable entry, wrapping.
    fn step(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let total = self.entries.len();
        if total == 0 {
            return None;
        }
        let mut pos = cur.and_then(|c| self.position(c)).unwrap_or(if forward { total - 1 } else { 0 });
        for _ in 0..total {
            pos = if forward { (pos + 1) % total } else { (pos + total - 1) % total };
            let idx = self.entries[pos];
            if !(self.is_header)(idx) {
                return Some(idx);
            }
        }
        cur
    }

    /// First item of the next/previous group, wrapping.
    fn group(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let starts: Vec<usize> = (0..self.entries.len()).filter(|&pos| (self.is_header)(self.entries[pos])).collect();
        if starts.is_empty() {
            return cur;
        }
        let pos = cur.and_then(|c| self.position(c)).unwrap_or(0);
        let current = starts.iter().rposition(|&s| s < pos).unwrap_or(starts.len() - 1);
        let target = if forward { (current + 1) % starts.len() } else { (current + starts.len() - 1) % starts.len() };
        let first = starts[target] + 1;
        if first < self.entries.len() && !(self.is_header)(self.entries[first]) { Some(self.entries[first]) } else { cur }
    }

    /// A page down/up, landing on a selectable entry.
    fn page(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let total = self.entries.len();
        let pos = cur.and_then(|c| self.position(c))?;
        let size = window_size();
        let target = if forward { (pos + size).min(total - 1) } else { pos.saturating_sub(size) };
        let mut candidates: Box<dyn Iterator<Item = usize>> =
            if forward { Box::new((target..total).chain((0..target).rev())) } else { Box::new((0..=target).rev().chain(target + 1..total)) };
        candidates.find(|&p| !(self.is_header)(self.entries[p])).map(|p| self.entries[p])
    }
}

/// Outcome of one key press.
enum Step {
    Continue,
    Finish(i32, Answer),
    Cancel,
}

fn handle_key(s: &mut Session, code: KeyCode, modifiers: KeyModifiers, cur: &mut Option<usize>) -> Step {
    let entries = s.entries();
    let rows_ref: &Vec<Row> = &s.rows;
    let is_header = |idx: usize| idx != ADD_ROW && rows_ref[idx].header;
    let nav = Nav { entries: &entries, is_header: &is_header };
    let mut filter_changed = false;
    match code {
        KeyCode::Up => *cur = nav.step(*cur, false),
        KeyCode::Down => *cur = nav.step(*cur, true),
        KeyCode::Left | KeyCode::BackTab => *cur = nav.group(*cur, false),
        KeyCode::Right | KeyCode::Tab => *cur = nav.group(*cur, true),
        KeyCode::PageUp => *cur = nav.page(*cur, false).or(*cur),
        KeyCode::PageDown => *cur = nav.page(*cur, true).or(*cur),
        KeyCode::Home => *cur = nav.items().next().or(*cur),
        KeyCode::End => *cur = nav.items().last().or(*cur),
        KeyCode::Char(' ') if s.multi => {
            if *cur == Some(ADD_ROW) {
                *cur = s.add_custom_row();
            } else if let Some(idx) = cur.filter(|&c| c != ADD_ROW && !s.is_header(c)) {
                s.rows[idx].checked = !s.rows[idx].checked;
            }
        }
        KeyCode::Backspace => filter_changed = s.filter.pop().is_some(),
        KeyCode::Char(c) if !modifiers.contains(KeyModifiers::CONTROL) => {
            s.filter.push(c);
            filter_changed = true;
        }
        KeyCode::Esc if !s.filter.is_empty() => {
            s.filter.clear();
            filter_changed = true;
        }
        KeyCode::Esc => return Step::Cancel,
        KeyCode::Enter => {
            if *cur == Some(ADD_ROW) {
                if s.multi {
                    *cur = s.add_custom_row();
                } else if let Some(value) = s.add_candidate() {
                    s.selection = Some(s.selection_json(Some(value.clone())));
                    return Step::Finish(CUSTOM_PICKED, Answer::Typed(value));
                }
            } else if let Some(idx) = cur.filter(|c| entries.contains(c) && !s.is_header(*c)) {
                if s.multi {
                    // Enter with nothing ticked takes the row under the cursor.
                    if !s.rows.iter().any(|row| row.checked) {
                        s.rows[idx].checked = true;
                    }
                    s.selection = Some(s.selection_json(None));
                    return Step::Finish(MULTI_DONE, Answer::Many);
                }
                s.selection = Some(s.selection_json(None));
                return Step::Finish(idx as i32, Answer::Row(idx));
            }
        }
        _ => {}
    }
    if filter_changed {
        // Keep the cursor if its row still matches, else jump to the first match (or the "+ add" row).
        let entries = s.entries();
        if !cur.is_some_and(|c| entries.contains(&c)) {
            *cur = entries.iter().copied().find(|&idx| !s.is_header(idx));
        }
    }
    Step::Continue
}

/// The prompt loop: keys, plus a redraw per tick while anything changed or spins.
fn run(msg: &str, session: &Mutex<Session>, start: usize) -> i32 {
    let _guard = match RawGuard::new() {
        Ok(g) => g,
        Err(_) => return ERROR,
    };
    let mut cur = Some(start);
    let mut frame = 0usize;
    let mut prev = render(msg, session, cur, 0, None, frame);

    loop {
        if event::poll(TICK).unwrap_or(false) {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    clear_previous_lines(prev);
                    return CANCELLED;
                }
                let step = match session.lock() {
                    Ok(mut s) => handle_key(&mut s, key.code, key.modifiers, &mut cur),
                    Err(_) => return ERROR,
                };
                match step {
                    Step::Continue => prev = render(msg, session, cur, prev, None, frame),
                    Step::Finish(code, answer) => {
                        render(msg, session, cur, prev, Some(answer), frame);
                        return code;
                    }
                    Step::Cancel => {
                        clear_previous_lines(prev);
                        return CANCELLED;
                    }
                }
                continue;
            }
        }
        frame = frame.wrapping_add(1);
        let needs_redraw = match session.lock() {
            Ok(mut s) => {
                let dirty = s.dirty;
                s.dirty = false;
                // Only on-screen spinners need animating.
                dirty || s.on_screen.iter().any(|&idx| s.rows[idx].loading)
            }
            Err(_) => return ERROR,
        };
        if needs_redraw {
            prev = render(msg, session, cur, prev, None, frame);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_live_select_start(
    msg: *const u8,
    msg_len: usize,
    rows_json: *const u8,
    rows_len: usize,
    default_idx: i32,
    flags: u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let (Some(msg), Some(rows_str)) = (parse_str(msg, msg_len), parse_str(rows_json, rows_len)) else {
            return ERROR;
        };
        let Ok(specs) = serde_json::from_str::<Vec<RowSpec>>(rows_str) else {
            return ERROR;
        };
        let allow_custom = flags & FLAG_CUSTOM != 0;
        if specs.iter().all(|spec| spec.header) && !allow_custom {
            return ERROR;
        }
        if !io::stdin().is_terminal() {
            return NOT_INTERACTIVE;
        }
        let Ok(mut slot) = SESSION.lock() else {
            return ERROR;
        };
        if slot.is_some() {
            return ERROR;
        }

        let rows: Vec<Row> = specs
            .into_iter()
            .map(|spec| Row {
                search: spec.search.unwrap_or_else(|| strip_ansi(&spec.label)).to_lowercase(),
                label: spec.label,
                header: spec.header,
                checked: spec.checked,
                suffix: String::new(),
                loading: false,
            })
            .collect();
        let custom_start = rows.len();
        let headers: Vec<bool> = rows.iter().map(|row| row.header).collect();
        let all: Vec<usize> = (0..rows.len()).collect();
        let is_header = |idx: usize| headers[idx];
        let nav = Nav { entries: &all, is_header: &is_header };
        let requested = usize::try_from(default_idx).ok().filter(|&i| i < rows.len());
        let cursor = match requested {
            Some(i) if !headers[i] => i,
            Some(i) => nav.step(Some(i), true).unwrap_or(0),
            None => nav.items().next().unwrap_or(0),
        };
        let session = Arc::new(Mutex::new(Session {
            allow_custom,
            custom_start,
            dirty: false,
            filter: String::new(),
            multi: flags & FLAG_MULTI != 0,
            on_screen: Vec::new(),
            result: None,
            rows,
            selection: None,
        }));
        *slot = Some(Arc::clone(&session));
        if let Ok(mut last) = LAST_SELECTION.lock() {
            *last = None;
        }

        let msg = msg.to_owned();
        thread::spawn(move || {
            // The guard inside `run` restores the terminal before the result is published.
            let result = catch_unwind(AssertUnwindSafe(|| run(&msg, &session, cursor))).unwrap_or(ERROR);
            if let Ok(mut s) = session.lock() {
                if let Ok(mut last) = LAST_SELECTION.lock() {
                    *last = s.selection.take();
                }
                s.result = Some(result);
            }
        });
        0
    }))
    .unwrap_or(ERROR)
}

fn current_session() -> Option<Arc<Mutex<Session>>> {
    SESSION.lock().ok().and_then(|slot| slot.clone())
}

fn write_out(text: &str, out: *mut u8, out_len: usize) -> i32 {
    if out.is_null() || text.len() > out_len {
        return BUFFER_TOO_SMALL;
    }
    let dest = unsafe { slice::from_raw_parts_mut(out, out_len) };
    dest[..text.len()].copy_from_slice(text.as_bytes());
    text.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_live_select_set(idx: i32, text: *const u8, text_len: usize, loading: u32) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(text) = parse_str(text, text_len) else {
            return ERROR;
        };
        let Some(session) = current_session() else {
            return ERROR;
        };
        let Ok(mut s) = session.lock() else {
            return ERROR;
        };
        let Some(row) = usize::try_from(idx).ok().and_then(|i| s.rows.get_mut(i)) else {
            return ERROR;
        };
        row.suffix = text.to_owned();
        row.loading = loading != 0;
        s.dirty = true;
        0
    }))
    .unwrap_or(ERROR)
}

/// Write the original indices of the rows on screen as `"3,4,5"` into `out`.
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_live_select_viewport(out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(session) = current_session() else {
            return ERROR;
        };
        let text = match session.lock() {
            Ok(s) => s.on_screen.iter().map(usize::to_string).collect::<Vec<_>>().join(","),
            Err(_) => return ERROR,
        };
        write_out(&text, out, out_len)
    }))
    .unwrap_or(ERROR)
}

/// The finished prompt's answer: checked row indices and typed values, as JSON.
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_live_select_selection(out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(last) = LAST_SELECTION.lock() else {
            return ERROR;
        };
        match last.as_deref() {
            Some(text) => write_out(text, out, out_len),
            None => ERROR,
        }
    }))
    .unwrap_or(ERROR)
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_live_select_poll() -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(mut slot) = SESSION.lock() else {
            return ERROR;
        };
        let Some(session) = slot.clone() else {
            return ERROR;
        };
        let result = match session.lock() {
            Ok(s) => s.result,
            Err(_) => Some(ERROR),
        };
        match result {
            Some(r) => {
                *slot = None;
                r
            }
            None => PENDING,
        }
    }))
    .unwrap_or(ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(specs: &[(&str, bool)], multi: bool, allow_custom: bool) -> Session {
        let rows: Vec<Row> = specs
            .iter()
            .map(|(label, header)| Row {
                label: (*label).to_owned(),
                header: *header,
                search: label.to_lowercase(),
                checked: false,
                suffix: String::new(),
                loading: false,
            })
            .collect();
        Session {
            custom_start: rows.len(),
            rows,
            multi,
            allow_custom,
            filter: String::new(),
            on_screen: Vec::new(),
            result: None,
            selection: None,
            dirty: false,
        }
    }

    #[test]
    fn filter_keeps_headers_of_matching_groups_only() {
        let s = session(&[("work", true), ("Germany", false), ("Netherlands", false), ("home", true), ("USA", false)], false, false);
        assert_eq!(visible_rows(&s.rows, ""), vec![0, 1, 2, 3, 4]);
        assert_eq!(visible_rows(&s.rows, "ger"), vec![0, 1]);
        assert_eq!(visible_rows(&s.rows, "zzz"), Vec::<usize>::new());
    }

    #[test]
    fn strip_ansi_removes_colors() {
        assert_eq!(strip_ansi("\u{1b}[32m212ms\u{1b}[0m vless"), "212ms vless");
    }

    #[test]
    fn add_row_offered_only_for_new_text() {
        let mut s = session(&[("google.com", false), ("geosite:google", false)], true, true);
        s.filter = "google".into();
        assert_eq!(s.entries()[0], ADD_ROW, "partial match: typed text can still be added");
        s.filter = "google.com".into();
        assert!(s.add_candidate().is_none(), "exact match: no + add row");
    }

    #[test]
    fn multi_select_toggles_adds_and_reports_selection() {
        let mut s = session(&[("a.com", false), ("b.com", false)], true, true);
        let mut cur = Some(0);
        handle_key(&mut s, KeyCode::Char(' '), KeyModifiers::NONE, &mut cur);
        for c in "x.org".chars() {
            handle_key(&mut s, KeyCode::Char(c), KeyModifiers::NONE, &mut cur);
        }
        assert_eq!(cur, Some(ADD_ROW));
        handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE, &mut cur);
        assert!(matches!(handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE, &mut cur), Step::Finish(MULTI_DONE, _)));
        assert_eq!(s.selection.as_deref(), Some(r#"{"checked":[0],"custom":["x.org"]}"#));
    }

    #[test]
    fn single_select_can_pick_typed_value() {
        let mut s = session(&[("a.com", false)], false, true);
        let mut cur = Some(0);
        for c in "z.net".chars() {
            handle_key(&mut s, KeyCode::Char(c), KeyModifiers::NONE, &mut cur);
        }
        assert!(matches!(handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE, &mut cur), Step::Finish(CUSTOM_PICKED, _)));
        assert_eq!(s.selection.as_deref(), Some(r#"{"checked":[],"custom":["z.net"]}"#));
    }

    #[test]
    fn navigation_skips_headers() {
        let headers = [true, false, false, true, false];
        let entries: Vec<usize> = (0..5).collect();
        let is_header = |idx: usize| headers[idx];
        let nav = Nav { entries: &entries, is_header: &is_header };
        assert_eq!(nav.step(Some(2), true), Some(4));
        assert_eq!(nav.step(Some(4), true), Some(1));
        assert_eq!(nav.group(Some(1), true), Some(4));
        assert_eq!(nav.group(Some(4), true), Some(1));
    }
}
