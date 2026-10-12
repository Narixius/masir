use crossterm::cursor;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{self, Clear, ClearType};
use std::collections::HashSet;
use std::io::{self, IsTerminal, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

pub(crate) const CYAN: &str = "\x1b[36m";
pub(crate) const GREEN: &str = "\x1b[32m";
pub(crate) const GRAY: &str = "\x1b[90m";
pub(crate) const BOLD: &str = "\x1b[1m";
pub(crate) const RESET: &str = "\x1b[0m";

pub(crate) const MAX_WINDOW_ITEMS: usize = 8;

pub(crate) struct RawGuard;

impl RawGuard {
    pub(crate) fn new() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, cursor::Hide)?;
        Ok(Self)
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        let _ = execute!(stdout, cursor::Show, cursor::MoveToColumn(0));
        let _ = terminal::disable_raw_mode();
    }
}

pub(crate) fn parse_str<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if len == 0 {
        return Some("");
    }
    if ptr.is_null() {
        return None;
    }
    let slice = unsafe { slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(slice).ok()
}

pub(crate) fn clear_previous_lines(count: usize) {
    if count == 0 {
        return;
    }
    let mut stdout = io::stdout();
    let _ = execute!(
        stdout,
        cursor::MoveToColumn(0),
        cursor::MoveUp(count as u16),
        Clear(ClearType::FromCursorDown)
    );
}

/// Prompt confirmation (Yes / No).
/// Clack UI:
/// │
/// ◆  Do you want to continue?
/// │  ● Yes  /  ○ No
/// └
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_confirm(
    msg: *const u8,
    msg_len: usize,
    default_val: u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let msg = match parse_str(msg, msg_len) {
            Some(s) => s,
            None => return -2,
        };

        if !io::stdin().is_terminal() {
            return if default_val != 0 { 1 } else { 0 };
        }

        let _guard = match RawGuard::new() {
            Ok(g) => g,
            Err(_) => return -2,
        };

        let mut value = default_val != 0;
        let mut prev_line_count;

        let render = |val: bool, prev_count: usize, is_final: bool| -> usize {
            clear_previous_lines(prev_count);
            let mut out = io::stdout();

            if is_final {
                let ans = if val { "Yes" } else { "No" };
                let _ = write!(out, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out, "\r{GREEN}◇{RESET}  {msg}\r\n");
                let _ = write!(out, "\r{GRAY}│{RESET}  {ans}\r\n");
                let _ = execute!(out, cursor::MoveToColumn(0));
                let _ = out.flush();
                3
            } else {
                let (yes_str, no_str) = if val {
                    (
                        format!("{GREEN}● Yes{RESET}"),
                        format!("{GRAY}○ No{RESET}"),
                    )
                } else {
                    (
                        format!("{GRAY}○ Yes{RESET}"),
                        format!("{GREEN}● No{RESET}"),
                    )
                };

                let _ = write!(out, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out, "\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}\r\n");
                let _ = write!(out, "\r{CYAN}│{RESET}  {yes_str}  {GRAY}/{RESET}  {no_str}\r\n");
                let _ = write!(out, "\r{CYAN}└{RESET}\r\n");
                let _ = execute!(out, cursor::MoveToColumn(0));
                let _ = out.flush();
                4
            }
        };

        prev_line_count = render(value, 0, false);

        loop {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    clear_previous_lines(prev_line_count);
                    return -1;
                }

                match key.code {
                    KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('y') | KeyCode::Char('Y') => {
                        value = true;
                        prev_line_count = render(value, prev_line_count, false);
                    }
                    KeyCode::Right | KeyCode::Char('l') | KeyCode::Char('n') | KeyCode::Char('N') => {
                        value = false;
                        prev_line_count = render(value, prev_line_count, false);
                    }
                    KeyCode::Enter => {
                        render(value, prev_line_count, true);
                        return if value { 1 } else { 0 };
                    }
                    KeyCode::Esc => {
                        clear_previous_lines(prev_line_count);
                        return -1;
                    }
                    _ => {}
                }
            }
        }
    }))
    .unwrap_or(-2)
}

/// Prompt single select.
/// Clack UI:
/// │
/// ◆  Pick a framework
/// │  ■ Next.js (React framework)
/// │  □ Astro (Content-focused)
/// │  □ SvelteKit (Compile-time framework)
/// └  ↑/↓ to navigate • Enter: confirm
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_select(
    msg: *const u8,
    msg_len: usize,
    options_json: *const u8,
    options_len: usize,
    default_idx: i32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let msg = match parse_str(msg, msg_len) {
            Some(s) => s,
            None => return -2,
        };
        let options_str = match parse_str(options_json, options_len) {
            Some(s) => s,
            None => return -2,
        };

        let options: Vec<String> = match serde_json::from_str(options_str) {
            Ok(opts) => opts,
            Err(_) => return -2,
        };

        if options.is_empty() {
            return -2;
        }

        if !io::stdin().is_terminal() {
            return if default_idx >= 0 && (default_idx as usize) < options.len() {
                default_idx
            } else {
                0
            };
        }

        let _guard = match RawGuard::new() {
            Ok(g) => g,
            Err(_) => return -2,
        };

        let total = options.len();
        let mut cursor = if default_idx >= 0 && (default_idx as usize) < total {
            default_idx as usize
        } else {
            0
        };

        let mut prev_line_count;

        let render = |cur: usize, prev_count: usize, is_final: bool| -> usize {
            clear_previous_lines(prev_count);
            let mut out = io::stdout();

            if is_final {
                let chosen = &options[cur];
                let _ = write!(out, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out, "\r{GREEN}◇{RESET}  {msg}\r\n");
                let _ = write!(out, "\r{GRAY}│{RESET}  {chosen}\r\n");
                let _ = execute!(out, cursor::MoveToColumn(0));
                let _ = out.flush();
                3
            } else {
                let visible_count = total.min(MAX_WINDOW_ITEMS);
                let start_index = if total > MAX_WINDOW_ITEMS {
                    let half = MAX_WINDOW_ITEMS / 2;
                    if cur <= half {
                        0
                    } else if cur + (MAX_WINDOW_ITEMS - half) >= total {
                        total - MAX_WINDOW_ITEMS
                    } else {
                        cur - half
                    }
                } else {
                    0
                };

                let mut lines = 0;
                let _ = write!(out, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out, "\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}\r\n");
                lines += 2;

                if start_index > 0 {
                    let _ = write!(out, "\r{CYAN}│{RESET}  {GRAY}↑ ...{RESET}\r\n");
                    lines += 1;
                }

                for i in 0..visible_count {
                    let idx = start_index + i;
                    let item = &options[idx];
                    let is_current = idx == cur;

                    if is_current {
                        let _ = write!(out, "\r{CYAN}│{RESET}  {GREEN}●{RESET} {BOLD}{item}{RESET}\r\n");
                    } else {
                        let _ = write!(out, "\r{CYAN}│{RESET}  {GRAY}○{RESET} {GRAY}{item}{RESET}\r\n");
                    }
                    lines += 1;
                }

                if start_index + visible_count < total {
                    let _ = write!(out, "\r{CYAN}│{RESET}  {GRAY}↓ ...{RESET}\r\n");
                    lines += 1;
                }

                let _ = write!(out, "\r{CYAN}│{RESET}  {GRAY}↑/↓ to navigate • Enter: confirm{RESET}\r\n");
                let _ = write!(out, "\r{CYAN}└{RESET}\r\n");
                lines += 2;
                let _ = execute!(out, cursor::MoveToColumn(0));
                let _ = out.flush();
                lines
            }
        };

        prev_line_count = render(cursor, 0, false);

        loop {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    clear_previous_lines(prev_line_count);
                    return -1;
                }

                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        cursor = (cursor + total - 1) % total;
                        prev_line_count = render(cursor, prev_line_count, false);
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        cursor = (cursor + 1) % total;
                        prev_line_count = render(cursor, prev_line_count, false);
                    }
                    KeyCode::Enter => {
                        render(cursor, prev_line_count, true);
                        return cursor as i32;
                    }
                    KeyCode::Esc => {
                        clear_previous_lines(prev_line_count);
                        return -1;
                    }
                    _ => {}
                }
            }
        }
    }))
    .unwrap_or(-2)
}

/// Prompt multi select.
/// Clack UI:
/// │
/// ◆  Select subscriptions to remove
/// │  ◼ Next.js (React framework)
/// │  ◻ Astro (Content-focused)
/// │  ↑/↓ to navigate • Space: select • a: all • Enter: confirm
/// └
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_multiselect(
    msg: *const u8,
    msg_len: usize,
    options_json: *const u8,
    options_len: usize,
    defaults_json: *const u8,
    defaults_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let msg = match parse_str(msg, msg_len) {
            Some(s) => s,
            None => return -2,
        };
        let options_str = match parse_str(options_json, options_len) {
            Some(s) => s,
            None => return -2,
        };

        let options: Vec<String> = match serde_json::from_str(options_str) {
            Ok(opts) => opts,
            Err(_) => return -2,
        };

        if options.is_empty() {
            return -2;
        }

        let mut selected: HashSet<usize> = if defaults_len > 0 {
            parse_str(defaults_json, defaults_len)
                .and_then(|s| serde_json::from_str::<Vec<usize>>(s).ok())
                .unwrap_or_default()
                .into_iter()
                .collect()
        } else {
            HashSet::new()
        };

        if !io::stdin().is_terminal() {
            let mut list: Vec<usize> = selected.into_iter().collect();
            list.sort_unstable();
            let json = serde_json::to_vec(&list).unwrap_or_default();
            if json.len() > out_len {
                return -2;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(json.as_ptr(), out, json.len());
            }
            return json.len() as i32;
        }

        let _guard = match RawGuard::new() {
            Ok(g) => g,
            Err(_) => return -2,
        };

        let total = options.len();
        let mut cursor = 0;
        let mut prev_line_count;

        let render = |cur: usize, sel: &HashSet<usize>, prev_count: usize, is_final: bool| -> usize {
            clear_previous_lines(prev_count);
            let mut out_io = io::stdout();

            if is_final {
                let _ = write!(out_io, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out_io, "\r{GREEN}◇{RESET}  {msg}\r\n");
                if sel.is_empty() {
                    let _ = write!(out_io, "\r{GRAY}│{RESET}  {GRAY}none{RESET}\r\n");
                } else if sel.len() == 1 {
                    let idx = sel.iter().next().unwrap();
                    let _ = write!(out_io, "\r{GRAY}│{RESET}  {GRAY}{}{RESET}\r\n", options[*idx]);
                } else {
                    let _ = write!(out_io, "\r{GRAY}│{RESET}  {GRAY}{} item(s) selected{RESET}\r\n", sel.len());
                }
                let _ = execute!(out_io, cursor::MoveToColumn(0));
                let _ = out_io.flush();
                3
            } else {
                let visible_count = total.min(MAX_WINDOW_ITEMS);
                let start_index = if total > MAX_WINDOW_ITEMS {
                    let half = MAX_WINDOW_ITEMS / 2;
                    if cur <= half {
                        0
                    } else if cur + (MAX_WINDOW_ITEMS - half) >= total {
                        total - MAX_WINDOW_ITEMS
                    } else {
                        cur - half
                    }
                } else {
                    0
                };

                let mut lines = 0;
                let _ = write!(out_io, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out_io, "\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}\r\n");
                lines += 2;

                if start_index > 0 {
                    let _ = write!(out_io, "\r{CYAN}│{RESET}  {GRAY}↑ ...{RESET}\r\n");
                    lines += 1;
                }

                for i in 0..visible_count {
                    let idx = start_index + i;
                    let item = &options[idx];
                    let is_current = idx == cur;
                    let is_checked = sel.contains(&idx);

                    let (marker, label) = match (is_current, is_checked) {
                        (true, true) => (format!("{GREEN}◼{RESET}"), format!("{BOLD}{item}{RESET}")),
                        (false, true) => (format!("{GREEN}◼{RESET}"), format!("{GRAY}{item}{RESET}")),
                        (true, false) => (format!("{CYAN}◻{RESET}"), format!("{BOLD}{item}{RESET}")),
                        (false, false) => (format!("{GRAY}◻{RESET}"), format!("{GRAY}{item}{RESET}")),
                    };

                    let _ = write!(out_io, "\r{CYAN}│{RESET}  {marker} {label}\r\n");
                    lines += 1;
                }

                if start_index + visible_count < total {
                    let _ = write!(out_io, "\r{CYAN}│{RESET}  {GRAY}↓ ...{RESET}\r\n");
                    lines += 1;
                }

                let _ = write!(out_io, "\r{CYAN}│{RESET}  {GRAY}↑/↓ to navigate • Space: select • a: all • Enter: confirm{RESET}\r\n");
                let _ = write!(out_io, "\r{CYAN}└{RESET}\r\n");
                lines += 2;
                let _ = execute!(out_io, cursor::MoveToColumn(0));
                let _ = out_io.flush();
                lines
            }
        };

        prev_line_count = render(cursor, &selected, 0, false);

        loop {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    clear_previous_lines(prev_line_count);
                    return -1;
                }

                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        cursor = (cursor + total - 1) % total;
                        prev_line_count = render(cursor, &selected, prev_line_count, false);
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        cursor = (cursor + 1) % total;
                        prev_line_count = render(cursor, &selected, prev_line_count, false);
                    }
                    KeyCode::Char(' ') => {
                        if selected.contains(&cursor) {
                            selected.remove(&cursor);
                        } else {
                            selected.insert(cursor);
                        }
                        prev_line_count = render(cursor, &selected, prev_line_count, false);
                    }
                    KeyCode::Char('a') | KeyCode::Char('A') => {
                        if selected.len() == total {
                            selected.clear();
                        } else {
                            selected = (0..total).collect();
                        }
                        prev_line_count = render(cursor, &selected, prev_line_count, false);
                    }
                    KeyCode::Enter => {
                        render(cursor, &selected, prev_line_count, true);
                        let mut list: Vec<usize> = selected.into_iter().collect();
                        list.sort_unstable();
                        let json = match serde_json::to_vec(&list) {
                            Ok(j) => j,
                            Err(_) => return -2,
                        };
                        if json.len() > out_len {
                            return -2;
                        }
                        unsafe {
                            std::ptr::copy_nonoverlapping(json.as_ptr(), out, json.len());
                        }
                        return json.len() as i32;
                    }
                    KeyCode::Esc => {
                        clear_previous_lines(prev_line_count);
                        return -1;
                    }
                    _ => {}
                }
            }
        }
    }))
    .unwrap_or(-2)
}

/// Prompt single line text input.
#[unsafe(no_mangle)]
pub extern "C" fn masir_prompt_text(
    msg: *const u8,
    msg_len: usize,
    default_val: *const u8,
    default_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let msg = match parse_str(msg, msg_len) {
            Some(s) => s,
            None => return -2,
        };
        let default_str = parse_str(default_val, default_len).unwrap_or("");

        if !io::stdin().is_terminal() {
            let bytes = default_str.as_bytes();
            if bytes.len() > out_len {
                return -2;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
            }
            return bytes.len() as i32;
        }

        let _guard = match RawGuard::new() {
            Ok(g) => g,
            Err(_) => return -2,
        };

        let mut input = String::new();
        let mut prev_line_count;

        let render = |cur_input: &str, prev_count: usize, is_final: bool| -> usize {
            clear_previous_lines(prev_count);
            let mut out_io = io::stdout();

            if is_final {
                let display = if cur_input.is_empty() { default_str } else { cur_input };
                let _ = write!(out_io, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out_io, "\r{GREEN}◇{RESET}  {msg}\r\n");
                let _ = write!(out_io, "\r{GRAY}│{RESET}  {display}\r\n");
                let _ = execute!(out_io, cursor::MoveToColumn(0));
                let _ = out_io.flush();
                3
            } else {
                let placeholder = if cur_input.is_empty() && !default_str.is_empty() {
                    format!("{GRAY}(default: {default_str}){RESET}")
                } else {
                    String::new()
                };

                let _ = write!(out_io, "\r{GRAY}│{RESET}\r\n");
                let _ = write!(out_io, "\r{CYAN}◆{RESET}  {BOLD}{msg}{RESET}\r\n");
                let _ = write!(out_io, "\r{CYAN}└{RESET}  {cur_input}{placeholder}\r\n");
                let _ = execute!(out_io, cursor::MoveToColumn(0));
                let _ = out_io.flush();
                3
            }
        };

        prev_line_count = render(&input, 0, false);

        loop {
            if let Ok(Event::Key(key)) = event::read() {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    clear_previous_lines(prev_line_count);
                    return -1;
                }

                match key.code {
                    KeyCode::Char(c) => {
                        input.push(c);
                        prev_line_count = render(&input, prev_line_count, false);
                    }
                    KeyCode::Backspace => {
                        input.pop();
                        prev_line_count = render(&input, prev_line_count, false);
                    }
                    KeyCode::Enter => {
                        let final_val = if input.is_empty() { default_str } else { &input };
                        render(final_val, prev_line_count, true);
                        let bytes = final_val.as_bytes();
                        if bytes.len() > out_len {
                            return -2;
                        }
                        unsafe {
                            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
                        }
                        return bytes.len() as i32;
                    }
                    KeyCode::Esc => {
                        clear_previous_lines(prev_line_count);
                        return -1;
                    }
                    _ => {}
                }
            }
        }
    }))
    .unwrap_or(-2)
}

/// Width of the terminal on stdout in columns, or 0 when it isn't a terminal.
#[unsafe(no_mangle)]
pub extern "C" fn masir_terminal_columns() -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        if !io::stdout().is_terminal() {
            return 0;
        }
        terminal::size().map(|(cols, _)| i32::from(cols)).unwrap_or(0)
    }))
    .unwrap_or(0)
}
