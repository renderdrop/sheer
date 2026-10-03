//! Finding text in the text of a page (ARCHITECTURE §5, `search`). Pure: it knows characters, not PDFium.
//!
//! PDFium has a search of its own, and it falls short in two ways that the people who search a document notice. It folds the case
//! of ASCII letters only (searching `MÜNCHEN` does not find `München`), and a word that a line break cut in two (`hyphen-` at the end
//! of a line, `ated` at the start of the next) is not found as `hyphenated`, because the hyphen it reads stays in the text. So the
//! app searches the text of the page itself, the very text the text layer shows (`engine::text`), where the hyphen is not and the
//! case is Unicode's: what can be selected is what can be found.
//!
//! The text is compared after it is normalized the same way as the query:
//!
//! - letters are lower-cased (`char::to_lowercase`, so `Ü` is `ü`; unless the search is case sensitive), and the ligatures `ﬀ ﬁ ﬂ ﬃ
//!   ﬄ ﬅ ﬆ` are the letters they stand for (a PDF often sets `fi` as one glyph, and nobody types it);
//! - a soft hyphen (U+00AD) is not there;
//! - every run of white space (a space, a line break the page's layout has, a no-break space) is one space, so a phrase is found
//!   across the end of a line; the query's own white space at its ends is dropped.
//!
//! `ß` is not `ss`: full case folding is not done, only lower-casing. The search is KMP, so a hostile page and a hostile query cannot
//! make it more than linear in the page's text.

/// The characters a normalized text is made of, and where in the page's text each came from.
struct Normalized {
    chars: Vec<char>,
    /// For each of `chars`, the position of the page character it came from (a collapsed run of white space: its first).
    origin: Vec<usize>,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Pushes what `c` is in a normalized text.
fn fold(c: char, match_case: bool, out: &mut Vec<char>) {
    match c {
        '\u{ad}' => {}
        '\u{fb00}' => out.extend(['f', 'f']),
        '\u{fb01}' => out.extend(['f', 'i']),
        '\u{fb02}' => out.extend(['f', 'l']),
        '\u{fb03}' => out.extend(['f', 'f', 'i']),
        '\u{fb04}' => out.extend(['f', 'f', 'l']),
        '\u{fb05}' | '\u{fb06}' => out.extend(['s', 't']),
        c if c.is_whitespace() => out.push(' '),
        c if match_case => out.push(c),
        c => out.extend(c.to_lowercase()),
    }
}

fn normalize(text: impl Iterator<Item = char>, match_case: bool) -> Normalized {
    let mut chars = Vec::new();
    let mut origin = Vec::new();
    let mut folded = Vec::new();
    for (position, c) in text.enumerate() {
        folded.clear();
        fold(c, match_case, &mut folded);
        for &f in &folded {
            // A run of white space is one space, at the position of its first character.
            if f == ' ' && chars.last() == Some(&' ') {
                continue;
            }
            chars.push(f);
            origin.push(position);
        }
    }
    Normalized { chars, origin }
}

/// The KMP failure table of `needle`: for each prefix, the length of its longest proper prefix that is also its suffix.
fn failure_table(needle: &[char]) -> Vec<usize> {
    let mut table = vec![0; needle.len()];
    let mut matched = 0;
    for at in 1..needle.len() {
        while matched > 0 && needle[at] != needle[matched] {
            matched = table[matched - 1];
        }
        if needle[at] == needle[matched] {
            matched += 1;
        }
        table[at] = matched;
    }
    table
}

/// The hits of `query` in `text`, at most `limit`, in order and without overlap: each as the first and the last position (both
/// included) in `text` of the characters it covers. A hit that starts or ends in the middle of a ligature covers the whole of it.
///
/// `whole_word`: the characters just outside a hit are not word characters wherever the hit's own edge is one (a query that begins
/// with a letter is not found inside a longer word, a query that begins with `(` is found next to a letter).
pub fn find(
    text: &[char],
    query: &str,
    match_case: bool,
    whole_word: bool,
    limit: usize,
) -> Vec<(usize, usize)> {
    let mut needle = normalize(query.chars(), match_case).chars;
    while needle.first() == Some(&' ') {
        needle.remove(0);
    }
    while needle.last() == Some(&' ') {
        needle.pop();
    }
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    let hay = normalize(text.iter().copied(), match_case);
    let table = failure_table(&needle);

    let mut hits = Vec::new();
    let mut matched = 0;
    for (at, &c) in hay.chars.iter().enumerate() {
        while matched > 0 && c != needle[matched] {
            matched = table[matched - 1];
        }
        if c == needle[matched] {
            matched += 1;
        }
        if matched < needle.len() {
            continue;
        }
        let (start, end) = (at + 1 - needle.len(), at);
        let before_is_word = start > 0 && is_word(hay.chars[start - 1]);
        let after_is_word = hay.chars.get(end + 1).is_some_and(|&c| is_word(c));
        let broken = whole_word
            && ((before_is_word && is_word(hay.chars[start]))
                || (after_is_word && is_word(hay.chars[end])));
        if broken {
            // Not a hit, but a hit may begin inside it.
            matched = table[matched - 1];
            continue;
        }
        // A hit: the next one has to begin after it. It covers the page characters its first and its last normalized character
        // came from (a ligature is several normalized characters of one page character, so it is covered whole).
        matched = 0;
        hits.push((hay.origin[start], hay.origin[end]));
        if hits.len() == limit {
            break;
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    /// The hits of `query` in `text`, as the text each covers.
    fn found(text: &str, query: &str, match_case: bool, whole_word: bool) -> Vec<String> {
        let all = chars(text);
        find(&all, query, match_case, whole_word, usize::MAX)
            .into_iter()
            .map(|(first, last)| all[first..=last].iter().collect())
            .collect()
    }

    fn any(text: &str, query: &str) -> Vec<String> {
        found(text, query, false, false)
    }

    #[test]
    fn plain_text_is_found_wherever_it_is_and_each_hit_is_its_own_text() {
        assert_eq!(any("The quick brown fox", "quick"), ["quick"]);
        assert_eq!(any("The quick brown fox", "The"), ["The"]);
        assert_eq!(any("The quick brown fox", "fox"), ["fox"]);
        assert!(any("The quick brown fox", "slow").is_empty());
        assert!(any("", "a").is_empty());
        assert!(any("abc", "").is_empty());
        assert!(any("abc", "   ").is_empty());
        // The query is longer than the text.
        assert!(any("ab", "abc").is_empty());
    }

    #[test]
    fn case_is_unicodes_not_ascii_only_unless_the_search_is_case_sensitive() {
        assert_eq!(any("Grüße aus München", "MÜNCHEN"), ["München"]);
        assert_eq!(any("Grüße aus München", "grüsse"), Vec::<String>::new());
        assert_eq!(
            any("ÉCOLE école École", "école"),
            ["ÉCOLE", "école", "École"]
        );
        assert_eq!(any("ΣΟΦΙΑ", "σοφια"), ["ΣΟΦΙΑ"]);
        assert_eq!(any("Привет мир", "ПРИВЕТ"), ["Привет"]);
        assert_eq!(
            found("Repeat repeat REPEAT", "repeat", true, false),
            ["repeat"]
        );
        assert_eq!(
            found("München münchen", "München", true, false),
            ["München"]
        );
        // `ß` is not `ss`: only lower-casing is done.
        assert!(any("Die Straße", "STRASSE").is_empty());
        assert_eq!(any("Die STRASSE", "strasse"), ["STRASSE"]);
        assert_eq!(any("STRAẞE", "straße"), ["STRAẞE"]);
    }

    #[test]
    fn a_word_that_a_line_break_cut_in_two_is_found_whole_because_the_hyphen_is_not_in_the_text() {
        // The text layer leaves the hyphen PDFium reads at the end of a line out, so the word is contiguous.
        assert_eq!(
            any("A word that is hyphenated across", "hyphenated"),
            ["hyphenated"]
        );
        // A soft hyphen that is in the text is not there for the search.
        assert_eq!(any("co\u{ad}operate", "cooperate"), ["co\u{ad}operate"]);
        assert_eq!(any("cooperate", "co\u{ad}operate"), ["cooperate"]);
    }

    #[test]
    fn white_space_is_one_space_so_a_phrase_is_found_across_a_line_break() {
        assert_eq!(any("over the lazy dog.\r\nA word", "dog. a"), ["dog.\r\nA"]);
        assert_eq!(any("a  b\t\tc", "a b c"), ["a  b\t\tc"]);
        assert_eq!(any("a\u{a0}b", "a b"), ["a\u{a0}b"]);
        // The query's white space at its ends does not count.
        assert_eq!(any("the fox runs", "  fox  "), ["fox"]);
        assert_eq!(any("the fox runs", "fox\r\n"), ["fox"]);
    }

    #[test]
    fn a_ligature_is_the_letters_it_stands_for_and_a_hit_covers_the_whole_glyph() {
        assert_eq!(any("o\u{fb03}ce and \u{fb01}sh", "office"), ["o\u{fb03}ce"]);
        assert_eq!(any("o\u{fb03}ce and \u{fb01}sh", "fish"), ["\u{fb01}sh"]);
        // A hit that ends inside a ligature ends with the ligature.
        assert_eq!(any("\u{fb01}sh", "f"), ["\u{fb01}"]);
        assert_eq!(any("\u{fb01}sh", "fi"), ["\u{fb01}"]);
        assert_eq!(any("\u{fb01}sh", "is"), ["\u{fb01}s"]);
    }

    #[test]
    fn whole_word_is_checked_where_the_hit_has_a_word_character_at_its_edge() {
        assert_eq!(
            found("cat concat cats cat.", "cat", false, true),
            ["cat", "cat"]
        );
        assert_eq!(found("cat concat cats cat.", "cat", false, false).len(), 4);
        // A hit that begins with a punctuation mark may follow a letter; one that begins with a letter may not.
        assert_eq!(found("a(x) b(x)", "(x)", false, true), ["(x)", "(x)"]);
        assert_eq!(found("under_score score", "score", false, true), ["score"]);
        assert_eq!(found("naïve naïvely", "naïve", false, true), ["naïve"]);
        // A word at either end of the text.
        assert_eq!(found("cat", "cat", false, true), ["cat"]);
        // A rejected candidate does not hide a hit that begins inside it.
        assert_eq!(found("aaa a", "aa", false, true), Vec::<String>::new());
        assert_eq!(found("xaa aa", "aa", false, true), ["aa"]);
    }

    #[test]
    fn hits_do_not_overlap_and_the_limit_stops_the_search() {
        assert_eq!(any("aaaaa", "aa").len(), 2);
        let all = chars("needle needle needle needle");
        let hits = find(&all, "needle", false, false, 3);
        assert_eq!(hits, [(0, 5), (7, 12), (14, 19)]);
        assert!(find(&all, "needle", false, false, 0).is_empty());
    }

    #[test]
    fn positions_are_those_of_the_pages_characters_not_of_the_normalized_text() {
        // Two spaces collapse into one, and the ligature is three letters: the positions still count the page's characters.
        let all = chars("a  \u{fb03}x");
        assert_eq!(find(&all, "ffix", false, false, 9), [(3, 4)]);
        assert_eq!(find(&all, "a ffi", false, false, 9), [(0, 3)]);
    }

    #[test]
    fn a_hostile_page_and_a_hostile_query_cannot_make_it_slow() {
        // The worst case for a naive search: a needle that matches almost everywhere and fails at its last character.
        let haystack: Vec<char> = std::iter::repeat_n('a', 1_000_000).collect();
        let query = format!("{}b", "a".repeat(511));
        let started = std::time::Instant::now();
        assert!(find(&haystack, &query, false, false, 10).is_empty());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
        );
    }
}
