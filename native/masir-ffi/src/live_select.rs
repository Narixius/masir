//! A select prompt whose lines can change while it is open (e.g. latency
//! results arriving per proxy), with optional group header rows and
//! type-to-filter. The prompt owns the terminal on its own thread; the host
//! polls it and pushes per-row suffixes without blocking:
//!
//!   masir_prompt_live_select_start(msg, rows_json, default)  -> 0 | -2 | -3
//!   masir_prompt_live_select_set(row, text, loading)         -> 0 | -2
//!   masir_prompt_live_select_viewport(out)                   -> bytes of "3,4,5" (rows on screen) | -2 | -3
//!   masir_prompt_live_select_poll()                          -> PENDING | -1 | -2 | row index
//!
//! `rows_json` is `[{"label": "...", "header": false, "search": "..."}, ...]`.
//! Header rows are not selectable; ←/→ (or Tab) jump between groups. Typing
//! filters rows by `search` (default: the label without colors), so labels
//! that are display-reordered (RTL) still match what the user types. A row with
//! `loading` shows an animated spinner; otherwise `text` (may carry ANSI colors)
//! is appended to its label. `viewport` tells the host which rows are on screen,
//! so it can limit expensive work (latency tests) to those.
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
use serde::Deserialize;
use std::io::{self, IsTerminal, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::prompt::{BOLD, CYAN, GRAY, GREEN, RESET, RawGuard, clear_previous_lines, parse_str};

/// `poll` result while the user has not answered yet.
const PENDING: i32 = -100;
/// stdin is not a terminal: the host should fall back to its default choice.
const NOT_INTERACTIVE: i32 = -3;
const ERROR: i32 = -2;
const BUFFER_TOO_SMALL: i32 = -3;
const CANCELLED: i32 = -1;
const TICK: Duration = Duration::from_millis(80);
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/// Lines around the list: blank, message, two scroll markers, help, footer.
const CHROME_LINES: usize = 6;
const MIN_WINDOW: usize = 5;
const MAX_WINDOW: usize = 20;

#[derive(Deserialize)]
struct RowSpec {
    label: String,
    #[serde(default)]
    header: bool,
    #[serde(default)]
    search: Option<String>,
}

struct Row {
    label: String,
    header: bool,
    /// Lowercased text the filter matches against.
    search: String,
    suffix: String,
    loading: bool,
}

struct Session {
    rows: Vec<Row>,
    filter: String,
    /// Original indices of the rows on screen, updated on every draw.
    on_screen: Vec<usize>,
    /// Set by the prompt thread once it has released the terminal.
    result: Option<i32>,
    dirty: bool,
}

static SESSION: Mutex<Option<Arc<Mutex<Session>>>> = Mutex::new(None);

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

/// Draw the prompt in one write (less flicker on frequent redraws); returns the line count.
fn render(msg: &str, session: &Mutex<Session>, cur: Option<usize>, prev_count: usize, is_final: bool, frame: usize) -> usize {
    let size = window_size();
    let mut buf = String::new();
    let mut count = 0;
    {
        let Ok(mut s) = session.lock() else {
            return prev_count;
        };
        let visible = visible_rows(&s.rows, &s.filter);
        if is_final {
            let chosen = cur.map(|idx| row_line(&s.rows[idx], frame)).unwrap_or_default();
            buf.push_str(&format!("\r{GRAY}│{RESET}\r\n\r{GREEN}◇{RESET}  {msg}\r\n\r{GRAY}│{RESET}  {chosen}\r\n"));
            count = 3;
        } else {
            let pos = cur.and_then(|c| visible.iter().position(|&idx| idx == c)).unwrap_or(0);
            let start = window_start(pos, visible.len(), size);
            let end = (start + size).min(visible.len());
            s.on_screen = visible[start..end].to_vec();

            buf.push_str(&format!("\r{GRAY}│{RESET}\r\n\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}\r\n"));
            count += 2;
            if !s.filter.is_empty() {
                let matches = visible.iter().filter(|&&idx| !s.rows[idx].header).count();
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}filter:{RESET} {}{GRAY}▏ {matches} match{}{RESET}\r\n", s.filter, if matches == 1 { "" } else { "es" }));
                count += 1;
            }
            if start > 0 {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}↑ {start} more{RESET}\r\n"));
                count += 1;
            }
            for &idx in &visible[start..end] {
                let row = &s.rows[idx];
                let line = row_line(row, frame);
                if row.header {
                    buf.push_str(&format!("\r{CYAN}│{RESET}  {CYAN}▸{RESET} {line}\r\n"));
                } else if Some(idx) == cur {
                    buf.push_str(&format!("\r{CYAN}│{RESET}    {GREEN}●{RESET} {BOLD}{line}{RESET}\r\n"));
                } else {
                    buf.push_str(&format!("\r{CYAN}│{RESET}    {GRAY}○{RESET} {line}\r\n"));
                }
                count += 1;
            }
            if visible.is_empty() {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}no matches{RESET}\r\n"));
                count += 1;
            }
            if end < visible.len() {
                buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}↓ {} more{RESET}\r\n", visible.len() - end));
                count += 1;
            }
            let has_groups = s.rows.iter().any(|row| row.header);
            let help = if has_groups {
                "↑/↓ navigate • ←/→ group • type to filter • Enter: confirm"
            } else {
                "↑/↓ navigate • type to filter • Enter: confirm"
            };
            buf.push_str(&format!("\r{CYAN}│{RESET}  {GRAY}{help}{RESET}\r\n\r{CYAN}└{RESET}\r\n"));
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

/// Navigation over the rows currently visible (original indices).
struct Nav<'a> {
    visible: &'a [usize],
    headers: &'a [bool],
}

impl Nav<'_> {
    fn items(&self) -> impl Iterator<Item = usize> + '_ {
        self.visible.iter().copied().filter(|&idx| !self.headers[idx])
    }

    fn position(&self, cur: usize) -> Option<usize> {
        self.visible.iter().position(|&idx| idx == cur)
    }

    /// Next/previous selectable row, wrapping.
    fn step(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let total = self.visible.len();
        if total == 0 {
            return None;
        }
        let mut pos = cur.and_then(|c| self.position(c)).unwrap_or(if forward { total - 1 } else { 0 });
        for _ in 0..total {
            pos = if forward { (pos + 1) % total } else { (pos + total - 1) % total };
            let idx = self.visible[pos];
            if !self.headers[idx] {
                return Some(idx);
            }
        }
        cur
    }

    /// First item of the next/previous group, wrapping.
    fn group(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let starts: Vec<usize> = (0..self.visible.len()).filter(|&pos| self.headers[self.visible[pos]]).collect();
        if starts.is_empty() {
            return cur;
        }
        let pos = cur.and_then(|c| self.position(c)).unwrap_or(0);
        let current = starts.iter().rposition(|&s| s < pos).unwrap_or(starts.len() - 1);
        let target = if forward { (current + 1) % starts.len() } else { (current + starts.len() - 1) % starts.len() };
        let first = starts[target] + 1;
        if first < self.visible.len() && !self.headers[self.visible[first]] { Some(self.visible[first]) } else { cur }
    }

    /// A page down/up, landing on a selectable row.
    fn page(&self, cur: Option<usize>, forward: bool) -> Option<usize> {
        let total = self.visible.len();
        let pos = cur.and_then(|c| self.position(c))?;
        let size = window_size();
        let target = if forward { (pos + size).min(total - 1) } else { pos.saturating_sub(size) };
        let mut candidates: Box<dyn Iterator<Item = usize>> =
            if forward { Box::new((target..total).chain((0..target).rev())) } else { Box::new((0..=target).rev().chain(target + 1..total)) };
        candidates.find(|&p| !self.headers[self.visible[p]]).map(|p| self.visible[p])
    }
}

/// The prompt loop: keys, plus a redraw per tick while anything changed or spins.
fn run(msg: &str, session: &Mutex<Session>, start: usize) -> i32 {
    let _guard = match RawGuard::new() {
        Ok(g) => g,
        Err(_) => return ERROR,
    };
    let headers: Vec<bool> = match session.lock() {
        Ok(s) => s.rows.iter().map(|row| row.header).collect(),
        Err(_) => return ERROR,
    };
    let mut cur = Some(start);
    let mut frame = 0usize;
    let mut prev = render(msg, session, cur, 0, false, frame);

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
                let Ok(mut s) = session.lock() else {
                    return ERROR;
                };
                let visible = visible_rows(&s.rows, &s.filter);
                let nav = Nav { visible: &visible, headers: &headers };
                let mut filter_changed = false;
                match key.code {
                    KeyCode::Up => cur = nav.step(cur, false),
                    KeyCode::Down => cur = nav.step(cur, true),
                    KeyCode::Left | KeyCode::BackTab => cur = nav.group(cur, false),
                    KeyCode::Right | KeyCode::Tab => cur = nav.group(cur, true),
                    KeyCode::PageUp => cur = nav.page(cur, false).or(cur),
                    KeyCode::PageDown => cur = nav.page(cur, true).or(cur),
                    KeyCode::Home => cur = nav.items().next().or(cur),
                    KeyCode::End => cur = nav.items().last().or(cur),
                    KeyCode::Backspace => filter_changed = s.filter.pop().is_some(),
                    KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                        s.filter.push(c);
                        filter_changed = true;
                    }
                    KeyCode::Esc if !s.filter.is_empty() => {
                        s.filter.clear();
                        filter_changed = true;
                    }
                    KeyCode::Esc => {
                        drop(s);
                        clear_previous_lines(prev);
                        return CANCELLED;
                    }
                    KeyCode::Enter => {
                        if let Some(chosen) = cur.filter(|c| visible.contains(c) && !headers[*c]) {
                            drop(s);
                            render(msg, session, Some(chosen), prev, true, frame);
                            return chosen as i32;
                        }
                    }
                    _ => {}
                }
                if filter_changed {
                    // Keep the cursor if its row still matches, else jump to the first match.
                    let visible = visible_rows(&s.rows, &s.filter);
                    let still_visible = cur.is_some_and(|c| visible.contains(&c));
                    if !still_visible {
                        cur = visible.iter().copied().find(|&idx| !headers[idx]);
                    }
                }
                drop(s);
                prev = render(msg, session, cur, prev, false, frame);
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
            prev = render(msg, session, cur, prev, false, frame);
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
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let (Some(msg), Some(rows_str)) = (parse_str(msg, msg_len), parse_str(rows_json, rows_len)) else {
            return ERROR;
        };
        let Ok(specs) = serde_json::from_str::<Vec<RowSpec>>(rows_str) else {
            return ERROR;
        };
        if specs.iter().all(|spec| spec.header) {
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
                suffix: String::new(),
                loading: false,
            })
            .collect();
        let headers: Vec<bool> = rows.iter().map(|row| row.header).collect();
        let all: Vec<usize> = (0..rows.len()).collect();
        let nav = Nav { visible: &all, headers: &headers };
        let requested = usize::try_from(default_idx).ok().filter(|&i| i < rows.len());
        let cursor = match requested {
            Some(i) if !headers[i] => i,
            Some(i) => nav.step(Some(i), true).unwrap_or(0),
            None => nav.items().next().unwrap_or(0),
        };
        let session = Arc::new(Mutex::new(Session { dirty: false, filter: String::new(), on_screen: Vec::new(), result: None, rows }));
        *slot = Some(Arc::clone(&session));

        let msg = msg.to_owned();
        thread::spawn(move || {
            // The guard inside `run` restores the terminal before the result is published.
            let result = catch_unwind(AssertUnwindSafe(|| run(&msg, &session, cursor))).unwrap_or(ERROR);
            if let Ok(mut s) = session.lock() {
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
        if out.is_null() || text.len() > out_len {
            return BUFFER_TOO_SMALL;
        }
        let dest = unsafe { slice::from_raw_parts_mut(out, out_len) };
        dest[..text.len()].copy_from_slice(text.as_bytes());
        text.len() as i32
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

    fn rows(specs: &[(&str, bool)]) -> Vec<Row> {
        specs
            .iter()
            .map(|(label, header)| Row { label: (*label).to_owned(), header: *header, search: label.to_lowercase(), suffix: String::new(), loading: false })
            .collect()
    }

    #[test]
    fn filter_keeps_headers_of_matching_groups_only() {
        let rows = rows(&[("work", true), ("Germany", false), ("Netherlands", false), ("home", true), ("USA", false)]);
        assert_eq!(visible_rows(&rows, ""), vec![0, 1, 2, 3, 4]);
        assert_eq!(visible_rows(&rows, "ger"), vec![0, 1]);
        assert_eq!(visible_rows(&rows, "a"), vec![0, 1, 2, 3, 4]);
        assert_eq!(visible_rows(&rows, "zzz"), Vec::<usize>::new());
    }

    #[test]
    fn strip_ansi_removes_colors() {
        assert_eq!(strip_ansi("\u{1b}[32m212ms\u{1b}[0m vless"), "212ms vless");
    }

    #[test]
    fn navigation_skips_headers() {
        let headers = [true, false, false, true, false];
        let visible: Vec<usize> = (0..5).collect();
        let nav = Nav { visible: &visible, headers: &headers };
        assert_eq!(nav.step(Some(2), true), Some(4));
        assert_eq!(nav.step(Some(4), true), Some(1));
        assert_eq!(nav.group(Some(1), true), Some(4));
        assert_eq!(nav.group(Some(4), true), Some(1));
    }
}
