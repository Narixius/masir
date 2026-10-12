//! Display text for terminals without BiDi support (Ghostty, iTerm2 by
//! default, WezTerm, kitty, Alacritty, xterm.js...). They draw characters in
//! logical order, left to right, so Persian/Arabic/Hebrew comes out mirrored.
//! We hand them text already in visual order:
//!
//! 1. Shape Arabic-script letters into their contextual presentation forms
//!    (in logical order, where the true neighbours are). After reordering, the
//!    terminal's own shaping would join letters from the wrong side.
//! 2. Run the Unicode Bidirectional Algorithm with a left-to-right base (our UI
//!    is LTR: bullets on the left), and reverse each right-to-left run,
//!    keeping combining marks on their base letter and mirroring brackets.
//!
//!   masir_text_visual(text, out) -> bytes written | -2 (bad input) | -3 (buffer too small)

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

use ar_reshaper::reshape_line;
use unicode_bidi::{BidiInfo, Level};

use crate::prompt::parse_str;

const ERROR: i32 = -2;
const BUFFER_TOO_SMALL: i32 = -3;

/// Marks that render on the preceding letter and must stay after it when a run is reversed.
fn is_combining(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0591..=0x05BD | 0x05BF | 0x05C1..=0x05C2 | 0x05C4..=0x05C5 | 0x05C7
        | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06DC | 0x06DF..=0x06E4
        | 0x06E7..=0x06E8 | 0x06EA..=0x06ED | 0x08D3..=0x08FF | 0xFE20..=0xFE2F)
}

/// Bidi-mirrored pairs that show up in proxy names.
fn mirror(c: char) -> char {
    match c {
        '(' => ')',
        ')' => '(',
        '[' => ']',
        ']' => '[',
        '{' => '}',
        '}' => '{',
        '<' => '>',
        '>' => '<',
        '«' => '»',
        '»' => '«',
        _ => c,
    }
}

/// Append `run` reversed, as clusters of base letter + its combining marks.
fn push_reversed(out: &mut String, run: &str) {
    let mut clusters: Vec<String> = Vec::new();
    for c in run.chars() {
        match clusters.last_mut() {
            Some(cluster) if is_combining(c) => cluster.push(c),
            _ => clusters.push(mirror(c).to_string()),
        }
    }
    for cluster in clusters.iter().rev() {
        out.push_str(cluster);
    }
}

/// Logical-order text to visual order with pre-shaped letters, for an LTR line.
pub fn to_visual(text: &str) -> String {
    let shaped = reshape_line(text);
    let info = BidiInfo::new(&shaped, Some(Level::ltr()));
    let mut out = String::with_capacity(shaped.len());
    for para in &info.paragraphs {
        let line = para.range.clone();
        let (levels, runs) = info.visual_runs(para, line);
        for run in runs {
            let piece = &shaped[run.clone()];
            if levels[run.start].is_rtl() {
                push_reversed(&mut out, piece);
            } else {
                out.push_str(piece);
            }
        }
    }
    out
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_text_visual(text: *const u8, text_len: usize, out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(text) = parse_str(text, text_len) else {
            return ERROR;
        };
        let visual = to_visual(text);
        if out.is_null() || visual.len() > out_len {
            return BUFFER_TOO_SMALL;
        }
        let dest = unsafe { slice::from_raw_parts_mut(out, out_len) };
        dest[..visual.len()].copy_from_slice(visual.as_bytes());
        visual.len() as i32
    }))
    .unwrap_or(ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_is_unchanged() {
        assert_eq!(to_visual("✅ admin - 611.14 GB"), "✅ admin - 611.14 GB");
    }

    #[test]
    fn rtl_word_is_shaped_and_reversed() {
        // "آلمان" (Germany): ﺁ ﻟ ﻤ ﺎ ﻥ in logical order, drawn right to left.
        let visual = to_visual("آلمان");
        assert_eq!(visual.chars().count(), 5);
        assert_eq!(visual.chars().next(), Some('\u{FEE5}'), "rightmost letter (final ن) comes first");
        assert_eq!(visual.chars().last(), Some('\u{FE81}'), "first letter (isolated آ) comes last");
    }

    #[test]
    fn ltr_parts_keep_their_place() {
        // Flag and Latin word stay where an LTR line puts them; only the Persian run flips.
        let visual = to_visual("🇩🇪 آلمان WARP");
        assert!(visual.starts_with("🇩🇪 "));
        assert!(visual.ends_with(" WARP"));
    }

    #[test]
    fn numbers_inside_rtl_stay_left_to_right() {
        let visual = to_visual("سرور 12");
        assert!(visual.contains("12"), "{visual}");
    }

    #[test]
    fn brackets_are_mirrored_in_rtl_runs() {
        let visual = to_visual("(تست)");
        assert!(visual.starts_with('(') && visual.ends_with(')'), "{visual}");
    }
}
