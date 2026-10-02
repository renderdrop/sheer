//! `display_name` through the public API: what the status bar may learn about a file (docs/SECURITY.md I2).
//!
//! The unit tests in `documents` cover the happy paths, the directory prefix, the control and format characters
//! (Unicode categories Cc and Cf, except the two joiners) and the cap. These tests add the edges around them: the cap at exactly 255, the cap counting only what survives the
//! filter, names that filter down to nothing, both path separators, a trailing separator, bytes that are not UTF-8, and
//! a sweep over every Unicode scalar value for the characters the spec says must never reach the UI.
//!
//! The sweep does not hold a second copy of the table in `documents`: a copy shares its mistakes (a wrong source, a missed
//! range) and so proves little. Its oracle is made of three things that do not come from that table. The standard library
//! says which characters are printable text (and so must stay), a list of known Cf characters by name says which must go,
//! and the size of the category (170, from the Unicode database) catches a range that is missing or too wide.

use std::path::Path;

use sheer_lib::documents::display_name;
use sheer_lib::limits::MAX_DISPLAY_NAME_CHARS;

fn shown(name: &str) -> String {
    display_name(Path::new(name))
}

/// How many characters the Unicode general category Cf (format) has: 170 from Unicode 15.0 to 17.0
/// (`DerivedGeneralCategory.txt`). Two of them, the joiners, stay in a name; `display_name` removes all the others.
const FORMAT_CHARACTERS: usize = 170;
const KEPT_JOINERS: usize = 2;

/// Known Cf characters with their Unicode names: the first and the last of every block of the category, and the ones a name
/// is most likely to be attacked with (direction controls, zero-width and invisible characters, tags). Not a copy of the
/// table of `documents`; it only has to be right about characters one can look up. The count above covers the rest.
const KNOWN_FORMAT_CHARACTERS: [(char, &str); 50] = [
    ('\u{00AD}', "SOFT HYPHEN"),
    ('\u{0600}', "ARABIC NUMBER SIGN"),
    ('\u{0605}', "ARABIC NUMBER MARK ABOVE"),
    ('\u{061C}', "ARABIC LETTER MARK"),
    ('\u{06DD}', "ARABIC END OF AYAH"),
    ('\u{070F}', "SYRIAC ABBREVIATION MARK"),
    ('\u{0890}', "ARABIC POUND MARK ABOVE"),
    ('\u{0891}', "ARABIC PIASTRE MARK ABOVE"),
    ('\u{08E2}', "ARABIC DISPUTED END OF AYAH"),
    ('\u{180E}', "MONGOLIAN VOWEL SEPARATOR"),
    ('\u{200B}', "ZERO WIDTH SPACE"),
    ('\u{200E}', "LEFT-TO-RIGHT MARK"),
    ('\u{200F}', "RIGHT-TO-LEFT MARK"),
    ('\u{202A}', "LEFT-TO-RIGHT EMBEDDING"),
    ('\u{202B}', "RIGHT-TO-LEFT EMBEDDING"),
    ('\u{202C}', "POP DIRECTIONAL FORMATTING"),
    ('\u{202D}', "LEFT-TO-RIGHT OVERRIDE"),
    ('\u{202E}', "RIGHT-TO-LEFT OVERRIDE"),
    ('\u{2060}', "WORD JOINER"),
    ('\u{2061}', "FUNCTION APPLICATION"),
    ('\u{2064}', "INVISIBLE PLUS"),
    ('\u{2066}', "LEFT-TO-RIGHT ISOLATE"),
    ('\u{2067}', "RIGHT-TO-LEFT ISOLATE"),
    ('\u{2068}', "FIRST STRONG ISOLATE"),
    ('\u{2069}', "POP DIRECTIONAL ISOLATE"),
    ('\u{206A}', "INHIBIT SYMMETRIC SWAPPING"),
    ('\u{206F}', "NOMINAL DIGIT SHAPES"),
    ('\u{FEFF}', "ZERO WIDTH NO-BREAK SPACE"),
    ('\u{FFF9}', "INTERLINEAR ANNOTATION ANCHOR"),
    ('\u{FFFA}', "INTERLINEAR ANNOTATION SEPARATOR"),
    ('\u{FFFB}', "INTERLINEAR ANNOTATION TERMINATOR"),
    ('\u{110BD}', "KAITHI NUMBER SIGN"),
    ('\u{110CD}', "KAITHI NUMBER SIGN ABOVE"),
    ('\u{13430}', "EGYPTIAN HIEROGLYPH VERTICAL JOINER"),
    ('\u{13431}', "EGYPTIAN HIEROGLYPH HORIZONTAL JOINER"),
    ('\u{1343F}', "EGYPTIAN HIEROGLYPH END WALLED ENCLOSURE"),
    ('\u{1BCA0}', "SHORTHAND FORMAT LETTER OVERLAP"),
    ('\u{1BCA1}', "SHORTHAND FORMAT CONTINUING OVERLAP"),
    ('\u{1BCA2}', "SHORTHAND FORMAT DOWN STEP"),
    ('\u{1BCA3}', "SHORTHAND FORMAT UP STEP"),
    ('\u{1D173}', "MUSICAL SYMBOL BEGIN BEAM"),
    ('\u{1D174}', "MUSICAL SYMBOL END BEAM"),
    ('\u{1D17A}', "MUSICAL SYMBOL END PHRASE"),
    ('\u{E0001}', "LANGUAGE TAG"),
    ('\u{E0020}', "TAG SPACE"),
    ('\u{E0041}', "TAG LATIN CAPITAL LETTER A"),
    ('\u{E0061}', "TAG LATIN SMALL LETTER A"),
    ('\u{E0067}', "TAG LATIN SMALL LETTER G"),
    ('\u{E007E}', "TAG TILDE"),
    ('\u{E007F}', "CANCEL TAG"),
];

/// Zero width non-joiner and joiner: Cf, but kept (scripts and emoji sequences need them).
fn is_kept_joiner(c: char) -> bool {
    c == '\u{200C}' || c == '\u{200D}'
}

/// Whether the standard library shows `c` as an escape (`\u{ad}`) when it is printed with `{:?}`. Its table of printable
/// characters comes from the Unicode database and leaves out the general categories Cc, Cf, Cs, Co, Cn, Zl, Zp and Zs (but
/// not the plain space), and `escape_debug` escapes the grapheme extenders (most combining marks) as well. So every Cf
/// character is escaped and no letter, digit, punctuation mark, symbol or plain space is: a name must keep all of the
/// latter, and may lose characters of the former only.
fn escaped_by_std(c: char) -> bool {
    let mut escape = c.escape_debug();
    escape.next() == Some('\\') && escape.next() == Some('u')
}

/// What a name never shows although it is not a format character: Cc (C0 and C1 controls, DEL), the line and paragraph
/// separators (Zl, Zp) and the object replacement character (a symbol, So).
fn is_hidden_without_being_format(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{FFFC}')
}

/// Private use (Co) and noncharacters (Cn): no Cf, so a name keeps them, although the standard library cannot print them.
fn is_private_use_or_noncharacter(c: char) -> bool {
    let code = u32::from(c);
    matches!(code, 0xE000..=0xF8FF | 0xF_0000..=0xF_FFFD | 0x10_0000..=0x10_FFFD | 0xFDD0..=0xFDEF)
        || code & 0xFFFE == 0xFFFE
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
fn the_two_joiners_stay() {
    assert_eq!(shown("a\u{200C}b\u{200D}c.pdf"), "a\u{200C}b\u{200D}c.pdf");
    assert_eq!(shown("\u{200D}"), "\u{200D}");
    assert_eq!(shown("\u{200C}"), "\u{200C}");
}

#[test]
fn every_known_format_character_is_removed() {
    for (c, name) in KNOWN_FORMAT_CHARACTERS {
        assert!(
            escaped_by_std(c),
            "{name} (U+{:04X}) is not Cf",
            u32::from(c)
        );
        assert!(!is_kept_joiner(c), "{name}");
        assert_eq!(
            shown(&format!("ab{c}b.pdf")),
            "abb.pdf",
            "{name} (U+{:04X})",
            u32::from(c)
        );
    }
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
    let mut removed_format_characters = Vec::new();
    for code in 0..=0x0010_FFFF_u32 {
        let Some(c) = char::from_u32(code) else {
            continue;
        };
        if c == '/' || c == '\\' {
            continue;
        }
        let result = shown(&format!("ab{c}b.pdf"));
        let removed = result == "abb.pdf";
        assert!(
            removed || result.chars().count() == 8,
            "U+{code:04X} changed more than itself: {result:?}"
        );

        if is_hidden_without_being_format(c) {
            assert!(removed, "U+{code:04X} (Cc, Zl, Zp or U+FFFC) is shown");
        } else if is_kept_joiner(c) || is_private_use_or_noncharacter(c) {
            assert!(!removed, "U+{code:04X} must be kept");
        } else if !escaped_by_std(c) {
            // Letters, digits, punctuation, symbols and the plain space: printable text is never touched.
            assert!(!removed, "U+{code:04X} is printable text and was removed");
        } else if removed {
            // Not printable, not a control, not a joiner: this can only be a format character. It must not be a
            // space-like or combining character the name needs, which `escaped_by_std` also catches.
            assert!(
                !c.is_whitespace(),
                "U+{code:04X} is white space and was removed"
            );
            removed_format_characters.push(code);
        }
    }

    // The size of the category: a range that is missing (a Cf character is shown) or too wide (something else is lost, an
    // unassigned code point or a combining mark) changes the count.
    assert_eq!(
        removed_format_characters.len(),
        FORMAT_CHARACTERS - KEPT_JOINERS,
        "display_name removes {} characters that are no control; Cf has {FORMAT_CHARACTERS} and two stay",
        removed_format_characters.len()
    );
    for (c, name) in KNOWN_FORMAT_CHARACTERS {
        assert!(
            removed_format_characters.contains(&u32::from(c)),
            "{name} is not among the removed format characters"
        );
    }
}
