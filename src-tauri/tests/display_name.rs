//! `display_name` through the public API: what the status bar may learn about a file (docs/SECURITY.md I2).
//!
//! The unit tests in `documents` cover the happy paths, the directory prefix, the control and format characters
//! (Unicode categories Cc and Cf, except the two joiners) and the cap. These tests add the edges around them: the cap at exactly 255, the cap counting only what survives the
//! filter, names that filter down to nothing, both path separators, a trailing separator, bytes that are not UTF-8, and
//! a sweep over every Unicode scalar value for the characters the spec says must never reach the UI.

use std::path::Path;

use sheer_lib::documents::display_name;
use sheer_lib::limits::MAX_DISPLAY_NAME_CHARS;

fn shown(name: &str) -> String {
    display_name(Path::new(name))
}

/// Every character of the Unicode general category Cf (format) as of Unicode 17, as `(first, last)` code points. An
/// independent copy of the list in `documents`, taken from the Unicode Character Database (`\p{Cf}`), so that the sweep
/// below fails when the implementation's table has a gap or an extra entry.
const GENERAL_CATEGORY_CF: [(u32, u32); 21] = [
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// Zero width non-joiner and joiner: Cf, but kept (scripts and emoji sequences need them).
fn is_kept_joiner(c: char) -> bool {
    c == '\u{200C}' || c == '\u{200D}'
}

/// Characters that can hide or reorder text, or break the layout: the general categories Cc (C0 and C1 controls, DEL) and
/// Cf (direction marks, embeddings, overrides and isolates, zero-width characters, invisible operators, the soft hyphen,
/// the byte order mark, tag characters ...) except the two joiners, the line and paragraph separators, and the object
/// replacement character.
fn must_never_be_shown(c: char) -> bool {
    let code = u32::from(c);
    let format = GENERAL_CATEGORY_CF
        .iter()
        .any(|&(first, last)| (first..=last).contains(&code));
    c.is_control()
        || (format && !is_kept_joiner(c))
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{FFFC}')
}

#[test]
fn the_cap_is_255_characters_and_exactly_255_is_kept_whole() {
    assert_eq!(MAX_DISPLAY_NAME_CHARS, 255);
    let exact = format!("{}.pdf", "n".repeat(MAX_DISPLAY_NAME_CHARS - 4));
    assert_eq!(exact.chars().count(), 255);
    assert_eq!(shown(&exact), exact);

    let one_over = format!("{exact}x");
    let cut = shown(&one_over);
    assert_eq!(cut.chars().count(), 255);
    assert_eq!(cut, exact);
}

#[test]
fn a_huge_name_is_cut_on_a_character_boundary_for_every_width_of_character() {
    // 1, 2, 3 and 4 bytes per character in UTF-8.
    for unit in ["x", "é", "日", "📄"] {
        let name = unit.repeat(10_000);
        let result = shown(&name);
        assert_eq!(result.chars().count(), MAX_DISPLAY_NAME_CHARS, "{unit}");
        assert_eq!(result, unit.repeat(MAX_DISPLAY_NAME_CHARS), "{unit}");
    }
}

#[test]
fn the_cap_counts_what_is_left_after_filtering_not_what_was_given() {
    // 100 invisible marks in front of 255 letters: the letters are all kept.
    let name = format!(
        "{}{}",
        "\u{200B}".repeat(100),
        "a".repeat(MAX_DISPLAY_NAME_CHARS)
    );
    assert_eq!(shown(&name), "a".repeat(MAX_DISPLAY_NAME_CHARS));
    // And the other way round: nothing of the 255 is lost to marks behind them.
    let name = format!(
        "{}{}",
        "a".repeat(MAX_DISPLAY_NAME_CHARS),
        "\u{202E}".repeat(100)
    );
    assert_eq!(shown(&name), "a".repeat(MAX_DISPLAY_NAME_CHARS));
}

#[test]
fn a_name_made_only_of_unsafe_characters_is_empty() {
    for name in [
        "\u{202E}",
        "\u{200B}\u{FEFF}",
        "\n\r\t",
        "\u{7F}",
        "\u{85}\u{9F}",
        "\u{2028}\u{2029}",
        "\u{AD}\u{FFFC}\u{E0067}\u{FFF9}",
    ] {
        assert_eq!(shown(name), "", "{name:?}");
    }
}

#[test]
fn the_two_joiners_are_the_only_format_characters_that_stay() {
    assert_eq!(shown("a\u{200C}b\u{200D}c.pdf"), "a\u{200C}b\u{200D}c.pdf");
    // Of every Cf character, as `display_name` really answers for it, exactly the two joiners come through.
    let kept: Vec<u32> = GENERAL_CATEGORY_CF
        .iter()
        .flat_map(|&(first, last)| first..=last)
        .filter(|&code| {
            char::from_u32(code).is_some_and(|c| shown(&format!("ab{c}b.pdf")).chars().count() == 8)
        })
        .collect();
    assert_eq!(kept, [0x200C, 0x200D]);
}

#[test]
fn delete_and_the_c1_controls_are_removed() {
    assert_eq!(shown("a\u{7F}b.pdf"), "ab.pdf");
    assert_eq!(shown("a\u{80}\u{9F}b.pdf"), "ab.pdf");
}

#[test]
fn a_directory_part_never_leaks_with_either_separator_or_a_trailing_one() {
    // `/` separates on every platform.
    assert_eq!(shown("some/dir/report.pdf"), "report.pdf");
    assert_eq!(shown("/abs/dir/report.pdf"), "report.pdf");
    assert_eq!(shown("some/dir/report.pdf/"), "report.pdf");
    assert_eq!(shown("a/./b/../report.pdf"), "report.pdf");
    for name in ["x/y/z.pdf", "x//y///z.pdf"] {
        assert!(!shown(name).contains('/'), "{name}");
    }
}

#[cfg(windows)]
#[test]
fn on_windows_both_separators_and_every_prefix_are_directory_not_name() {
    for (raw, name) in [
        (r"C:/Users\user/secret\a.pdf", "a.pdf"),
        (r"C:\Users\user\secret\a.pdf\", "a.pdf"),
        (r"\\server\share\dir\a.pdf", "a.pdf"),
        (r"\\?\UNC\server\share\a.pdf", "a.pdf"),
        (r"\\?\C:\Users\user\a.pdf", "a.pdf"),
        (r"C:a.pdf", "a.pdf"),
        (r"dir\sub/a.pdf", "a.pdf"),
    ] {
        let result = shown(raw);
        assert_eq!(result, name, "{raw}");
        assert!(!result.contains(['/', '\\']), "{raw}");
    }
    // A bare drive or share has no file name.
    assert_eq!(shown(r"C:\"), "");
    assert_eq!(shown(r"\\server\share\"), "");
}

#[cfg(windows)]
#[test]
fn on_windows_a_name_that_is_not_valid_utf16_shows_the_replacement_character() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    // 'a', a lone high surrogate, ".pdf"
    let wide = [0x61, 0xD800, 0x2E, 0x70, 0x64, 0x66];
    let path = OsString::from_wide(&wide);
    assert_eq!(display_name(Path::new(&path)), "a\u{FFFD}.pdf");
}

#[cfg(unix)]
#[test]
fn on_unix_a_name_that_is_not_valid_utf8_shows_the_replacement_character() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let path = Path::new(OsStr::from_bytes(b"dir/a\xFF.pdf"));
    assert_eq!(display_name(path), "a\u{FFFD}.pdf");
}

#[test]
fn no_scalar_value_the_spec_forbids_ever_reaches_the_ui() {
    // Every Unicode scalar value, placed between letters (two before it, so a colon is no drive prefix). The two
    // separators are skipped: they split a path, which the tests above cover.
    for code in 0..=0x0010_FFFF_u32 {
        let Some(c) = char::from_u32(code) else {
            continue;
        };
        if c == '/' || c == '\\' {
            continue;
        }
        let result = shown(&format!("ab{c}b.pdf"));
        if must_never_be_shown(c) {
            assert_eq!(result, "abb.pdf", "U+{code:04X}");
        } else {
            assert_eq!(result.chars().count(), 8, "U+{code:04X}");
        }
        assert!(!result.chars().any(must_never_be_shown), "U+{code:04X}");
    }
}
