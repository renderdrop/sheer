//! What the first pages and the imprint say about the work (F19.21): title, authors, year, edition, publisher, place, ISBN, DOI,
//! and the kind of document (book, article, report, official text, thesis). Pure functions over the lines `first_page` read, so the
//! rules are tested without PDFium.
//!
//! Ranking: the title is the largest-font run of the first three pages; authors are read from the lines next to the title; an
//! ISBN needs a valid checksum; edition, publisher and place come from the pages that look like an imprint (an "ISBN", a copyright
//! sign, "Impressum", "Verlag", ... in the first pages or the last two) before the front pages. Metadata (Info, XMP) still
//! outranks all of this in `model::bibliography::merge`. Official texts map to `Report` with the authority as author.
//!
//! Every page text is hostile: all outputs are cut to the record limits, nothing indexes by byte offset, nothing panics.

use super::first_page::{find_doi, find_title_at, find_year, Line};
use crate::documents::sanitize_text;
use crate::limits;
use crate::model::bibliography::{BibKind, FirstPageHints, Person};

/// The lines of one page (file order index).
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PageLines {
    pub index: usize,
    pub lines: Vec<Line>,
}

/// Most characters of one hint other than title/DOI.
const FIELD_MAX: usize = 120;

/// Words that mark an imprint page.
const IMPRINT_MARKERS: [&str; 12] = [
    "isbn",
    "\u{a9}",
    "copyright",
    "impressum",
    "alle rechte",
    "all rights reserved",
    "printed in",
    "verlag",
    "auflage",
    "edition",
    "publisher",
    "gedruckt",
];

/// Words that are no part of a person's name (lower case); a line with one is no author line.
const NOT_NAME: [&str; 40] = [
    "universität",
    "universitat",
    "university",
    "verlag",
    "press",
    "institut",
    "institute",
    "journal",
    "abstract",
    "department",
    "fakultät",
    "faculty",
    "band",
    "volume",
    "seminar",
    "thesis",
    "dissertation",
    "arbeit",
    "bericht",
    "report",
    "edition",
    "auflage",
    "isbn",
    "doi",
    "copyright",
    "and",
    "und",
    "the",
    "der",
    "die",
    "das",
    "of",
    "für",
    "in",
    "von",
    "zur",
    "über",
    "with",
    "mit",
    "einführung",
];

/// Lower-case name particles that may stand inside a name.
const PARTICLES: [&str; 13] = [
    "van", "von", "de", "der", "den", "la", "le", "di", "del", "zu", "zur", "ten", "dos",
];

const PUBLISHER_WORDS: [&str; 8] = [
    "verlag",
    "verlags",
    "verlagsgruppe",
    "verlagsgesellschaft",
    "press",
    "publishers",
    "publishing",
    "books",
];

const AUTHORITY_WORDS: [&str; 24] = [
    "universität",
    "hochschule",
    "stadt",
    "gemeinde",
    "landkreis",
    "ministerium",
    "bundesamt",
    "amt",
    "senat",
    "landtag",
    "bundestag",
    "kommission",
    "commission",
    "ministry",
    "department",
    "agency",
    "federal",
    "council",
    "bundesrepublik",
    "regierung",
    "republik",
    "parliament",
    "bundesanstalt",
    "behörde",
];

const OFFICIAL_WORDS: [&str; 11] = [
    "satzung",
    "verordnung",
    "gesetz",
    "amtsblatt",
    "bekanntmachung",
    "bundesgesetzblatt",
    "prüfungsordnung",
    "studienordnung",
    "richtlinie",
    "official journal",
    "directive",
];

const THESIS_WORDS: [&str; 7] = [
    "dissertation",
    "masterarbeit",
    "bachelorarbeit",
    "diplomarbeit",
    "doctoral thesis",
    "master's thesis",
    "master thesis",
];

const JOURNAL_WORDS: [&str; 9] = [
    "journal",
    "zeitschrift",
    "proceedings",
    "transactions",
    "review",
    "archiv",
    "annals",
    "letters",
    "jahrbuch",
];

/// Whitespace collapsed, unsafe characters dropped, cut to `max` characters; `None` if nothing is left.
fn tidy(text: &str, max: usize) -> Option<String> {
    let clean = sanitize_text(text, text.len().min(4 * max));
    let flat = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = flat.chars().take(max).collect();
    let cut = cut.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-' | '\u{b7}' | '|')
    });
    (!cut.is_empty()).then(|| cut.to_owned())
}

fn lower(text: &str) -> String {
    text.to_lowercase()
}

fn joined(page: &PageLines) -> String {
    page.lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

const SECTION_HEADINGS: [&str; 19] = [
    "abkürzungsverzeichnis",
    "symbolverzeichnis",
    "danksagung",
    "inhaltsübersicht",
    "kurzfassung",
    "inhaltsverzeichnis",
    "abbildungsverzeichnis",
    "tabellenverzeichnis",
    "literaturverzeichnis",
    "vorwort",
    "inhalt",
    "contents",
    "abstract",
    "preface",
    "introduction",
    "einleitung",
    "glossar",
    "zusammenfassung",
    "impressum",
];

/// A page that prints an ISBN or an edition: publisher lines on it are believed without a publisher word.
/// `text` with its first DOI blanked out (the digits of a DOI are no year).
fn without_doi(text: &str) -> String {
    match find_doi(text) {
        Some((_, span)) => format!(
            "{} {}",
            text.get(..span.start).unwrap_or(""),
            text.get(span.end..).unwrap_or("")
        ),
        None => text.to_owned(),
    }
}

/// The title of a text from a legal database: its header block ("Amtliche Abkürzung: ...", "Gliederungs-Nr: ...") comes first and the
/// title follows the last of its lines, in the same line or the next.
fn law_title(lines: &[Line]) -> Option<String> {
    let head = lines.iter().take(14);
    if !head
        .clone()
        .any(|l| lower(&l.text).starts_with("amtliche abkürzung"))
    {
        return None;
    }
    let (at, line) = lines
        .iter()
        .enumerate()
        .take(14)
        .find(|(_, l)| lower(&l.text).starts_with("gliederungs-nr"))?;
    let rest: Vec<&str> = line.text.split_whitespace().skip(2).collect();
    let text = if rest.is_empty() {
        lines.get(at + 1)?.text.clone()
    } else {
        rest.join(" ")
    };
    // A title that wraps continues with a bracketed short name ("(ThürBO)*").
    let follow = lines
        .get(at + if rest.is_empty() { 2 } else { 1 })
        .filter(|l| l.text.starts_with('('));
    let text = match follow {
        Some(l) => format!("{text} {}", l.text),
        None => text,
    };
    let text = text.trim().trim_end_matches(['*', ')']).trim();
    let text = if text.matches('(').count() > text.matches(')').count() {
        format!("{text})")
    } else {
        text.to_owned()
    };
    tidy(&text, limits::BIB_HEURISTIC_TITLE_MAX)
}

fn is_book_page(page: &PageLines) -> bool {
    let text = lower(&joined(page));
    text.contains("isbn") || text.contains("auflage") || text.contains("edition")
}

fn is_imprint(page: &PageLines) -> bool {
    let text = lower(&joined(page));
    IMPRINT_MARKERS.iter().any(|marker| text.contains(marker))
}

/// A word without the punctuation around it, lower case.
fn bare(word: &str) -> String {
    lower(word.trim_matches(|c: char| !c.is_alphanumeric()))
}

// --- ISBN ---

/// Whether `digits` (ten with a possible `X` last, or thirteen) is a valid ISBN by its check digit.
pub(super) fn isbn_valid(digits: &[u8]) -> bool {
    match digits.len() {
        13 => {
            let sum: u32 = digits
                .iter()
                .enumerate()
                .map(|(i, &d)| u32::from(d) * if i % 2 == 0 { 1 } else { 3 })
                .sum();
            digits.iter().all(|&d| d <= 9) && sum.is_multiple_of(10)
        }
        10 => {
            let mut sum = 0u32;
            for (i, &d) in digits.iter().enumerate() {
                // 10 stands for the X, which only the check digit may be.
                if d > 10 || (d == 10 && i != 9) {
                    return false;
                }
                sum += u32::from(d) * (10 - i as u32);
            }
            sum.is_multiple_of(11)
        }
        _ => false,
    }
}

/// The ISBN that starts at `chars[at]`: digits with hyphens or single spaces between (one kind of separator), a valid 13 or 10.
fn isbn_at(chars: &[char], at: usize) -> Option<String> {
    let mut digits: Vec<u8> = Vec::new();
    let mut separator: Option<char> = None;
    let mut i = at;
    while i < chars.len() && i < at + 30 && digits.len() < 20 {
        let c = chars[i];
        if let Some(d) = c.to_digit(10) {
            digits.push(d as u8);
        } else if (c == 'X' || c == 'x')
            && digits.len() == 9
            && !chars.get(i + 1).is_some_and(|n| n.is_alphanumeric())
        {
            digits.push(10);
            break;
        } else if (c == '-' || c == ' ' || c == '\u{2010}' || c == '\u{2013}')
            && separator.is_none_or(|s| s == c)
            && chars
                .get(i + 1)
                .is_some_and(|n| n.is_ascii_digit() || *n == 'X')
            && !digits.is_empty()
        {
            separator = Some(c);
        } else {
            break;
        }
        i += 1;
    }
    let before_ok = at == 0 || !chars[at - 1].is_alphanumeric();
    if !before_ok {
        return None;
    }
    for len in [13usize, 10] {
        if digits.len() >= len && isbn_valid(&digits[..len]) {
            let text: String = digits[..len]
                .iter()
                .map(|&d| if d == 10 { 'X' } else { char::from(b'0' + d) })
                .collect();
            return Some(text);
        }
    }
    None
}

/// The first valid ISBN of `text`: after the word "ISBN", or a bare 978/979 number.
pub(super) fn find_isbn(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let lowered: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    let same_length = lowered.len() == chars.len();
    let mut i = 0;
    while i < chars.len() {
        let is_word = same_length && lowered[i..].starts_with(&['i', 's', 'b', 'n']);
        if is_word {
            for skip in 4..16.min(chars.len() - i + 1) {
                let at = i + skip;
                if at < chars.len() && chars[at].is_ascii_digit() {
                    if let Some(found) = isbn_at(&chars, at) {
                        return Some(found);
                    }
                }
            }
        } else if chars[i] == '9'
            && chars.get(i + 1) == Some(&'7')
            && matches!(chars.get(i + 2), Some('8' | '9'))
        {
            if let Some(found) = isbn_at(&chars, i) {
                return Some(found);
            }
        }
        i += 1;
    }
    None
}

// --- edition ---

fn ordinal_word(word: &str) -> Option<u32> {
    Some(match word {
        "first" | "erste" => 1,
        "second" | "zweite" => 2,
        "third" | "dritte" => 3,
        "fourth" | "vierte" => 4,
        "fifth" | "fünfte" => 5,
        "sixth" | "sechste" => 6,
        "seventh" | "siebte" => 7,
        "eighth" | "achte" => 8,
        "ninth" | "neunte" => 9,
        "tenth" | "zehnte" => 10,
        _ => return None,
    })
}

fn small_number(word: &str) -> Option<u32> {
    let digits = word.trim_end_matches(|c: char| c.is_alphabetic() || c == '.' || c == ',');
    if digits.is_empty() || digits.len() > 2 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|n| (1..100).contains(n))
}

fn is_edition_word(word: &str) -> bool {
    word.starts_with("auflage") || word.starts_with("aufl") || word == "edition" || word == "ed"
}

/// The edition number: "3. Auflage", "Auflage 3", "2nd edition", "Second Edition", "Edition 4".
pub(super) fn find_edition(text: &str) -> Option<String> {
    let raw: Vec<String> = lower(text).split_whitespace().map(str::to_owned).collect();
    let words: Vec<String> = raw.iter().map(|w| bare(w)).collect();
    for (i, word) in words.iter().enumerate() {
        let ahead = || words.iter().skip(i + 1).take(4);
        let number = if let Some(n) = ordinal_word(word) {
            ahead()
                .any(|w| w == "edition" || w.starts_with("auflage"))
                .then_some(n)
        } else if raw[i].chars().next().is_some_and(|c| c.is_ascii_digit()) {
            let dotted = raw[i].ends_with('.') || raw[i].ends_with(".,");
            let ordinal = ["st", "nd", "rd", "th"].iter().any(|s| word.ends_with(s));
            small_number(&raw[i])
                .filter(|_| dotted || ordinal)
                .filter(|_| ahead().any(|w| is_edition_word(w)))
        } else if is_edition_word(word) && !word.starts_with("ed") || word == "edition" {
            words
                .get(i + 1)
                .and_then(|next| small_number(next))
                .filter(|_| {
                    raw.get(i + 1)
                        .is_some_and(|n| !n.contains('.') || n.ends_with('.'))
                })
        } else {
            None
        };
        if let Some(n) = number {
            return Some(n.to_string());
        }
    }
    None
}

// --- publisher and place ---

fn capitalized(word: &str) -> bool {
    word.chars().next().is_some_and(char::is_uppercase)
}

fn plain_year(text: &str) -> Option<String> {
    text.split(|c: char| !c.is_ascii_digit())
        .find(|part| {
            part.len() == 4
                && part
                    .parse::<u32>()
                    .is_ok_and(|y| (1900..=2100).contains(&y))
        })
        .map(str::to_owned)
}

const PLACE_PARTICLES: [&str; 9] = ["am", "an", "der", "upon", "on", "de", "la", "im", "ob"];
const NOT_PLACE: [&str; 22] = [
    "isbn",
    "doi",
    "preis",
    "auflage",
    "edition",
    "url",
    "tel",
    "fax",
    "online",
    "printed",
    "copyright",
    "published",
    "verlag",
    "press",
    "hinweis",
    "siehe",
    "see",
    "quelle",
    "source",
    "https",
    "stand",
    "autor",
];

/// "Ort: Verlag, Jahr" -> (place, publisher, year).
fn place_publisher(line: &str, book_page: bool) -> Option<(String, String, Option<String>)> {
    let (left, right) = line.split_once(':')?;
    let place_words: Vec<&str> = left.split_whitespace().collect();
    if place_words.is_empty() || place_words.len() > 4 || !capitalized(place_words[0]) {
        return None;
    }
    let place_ok = place_words.iter().all(|w| {
        (capitalized(w) || PLACE_PARTICLES.contains(&lower(w).as_str()))
            && w.chars()
                .all(|c| c.is_alphabetic() || matches!(c, '.' | '-'))
    });
    if !place_ok
        || place_words
            .iter()
            .any(|w| NOT_PLACE.contains(&bare(w).as_str()))
    {
        return None;
    }
    let (publisher_raw, rest) = right.split_once(',').unwrap_or((right, ""));
    let year = plain_year(rest).or_else(|| plain_year(publisher_raw));
    let publisher: String = publisher_raw
        .split_whitespace()
        .filter(|w| plain_year(w).is_none())
        .collect::<Vec<_>>()
        .join(" ");
    let publisher = publisher.trim().trim_end_matches('.').to_owned();
    let words = publisher.split_whitespace().count();
    let keyword = publisher
        .split_whitespace()
        .any(|w| PUBLISHER_WORDS.contains(&bare(w).as_str()));
    if words == 0 || words > 6 || !capitalized(&publisher) || publisher.contains(':') {
        return None;
    }
    if publisher.chars().any(|c| c.is_ascii_digit()) || (!keyword && !(book_page && year.is_some()))
    {
        return None;
    }
    Some((left.trim().to_owned(), publisher, year))
}

/// A line naming a publisher: after "Verlag:", "Published by", or a short line with "Verlag" / "Press" in it.
fn publisher_line(line: &str) -> Option<(String, Option<String>)> {
    let low = lower(line);
    for prefix in [
        "verlag:",
        "publisher:",
        "published by",
        "erschienen bei",
        "erschienen im",
        "lizenziert an",
        "licensed to",
    ] {
        if let Some(at) = low.find(prefix) {
            let tail = line.get(at + prefix.len()..)?;
            return split_publisher_place(tail);
        }
    }
    let words: Vec<&str> = line.split_whitespace().collect();
    let has_word = words
        .iter()
        .any(|w| PUBLISHER_WORDS.contains(&bare(w).as_str()) || bare(w).ends_with("verlag"));
    let noise = [
        "rechte",
        "rights",
        "reserved",
        "printed",
        "gedruckt",
        "druck",
        "alle",
        "vervielfält",
    ];
    if !has_word || words.len() > 7 || noise.iter().any(|n| low.contains(n)) {
        return None;
    }
    let kept: Vec<&str> = words
        .iter()
        .copied()
        .filter(|w| {
            let b = bare(w);
            plain_year(w).is_none()
                && !matches!(
                    b.as_str(),
                    "" | "copyright" | "c" | "published" | "by" | "im" | "erschienen" | "bei"
                )
                && !w.contains('\u{a9}')
        })
        .collect();
    split_publisher_place(&kept.join(" "))
}

/// "Springer, Berlin" -> ("Springer", Some("Berlin")).
fn split_publisher_place(text: &str) -> Option<(String, Option<String>)> {
    let text = text.trim().trim_end_matches('.');
    let (name, rest) = text.split_once(',').unwrap_or((text, ""));
    let name = name.trim();
    let place = rest
        .split(',')
        .next()
        .map(str::trim)
        .filter(|p| {
            let n = p.split_whitespace().count();
            (1..=3).contains(&n)
                && capitalized(p)
                && p.chars()
                    .all(|c| c.is_alphabetic() || matches!(c, ' ' | '.' | '-'))
                && plain_year(p).is_none()
        })
        .map(str::to_owned);
    let words = name.split_whitespace().count();
    ((1..=6).contains(&words) && capitalized(name) && !name.chars().any(|c| c.is_ascii_digit()))
        .then(|| (name.to_owned(), place))
}

// --- authors ---

fn name_token_ok(token: &str) -> bool {
    let core = token.trim_matches(|c: char| matches!(c, '.' | ','));
    let letters = core.chars().filter(|c| c.is_alphabetic()).count();
    if core.is_empty() || letters > 16 {
        return false;
    }
    // "Dt." is an abbreviation, "AI" an acronym, "Implementierung" a noun: none is a name.
    if letters >= 2 && token.trim_end_matches(',').ends_with('.') {
        return false;
    }
    if (2..=3).contains(&letters) && core.chars().all(char::is_uppercase) {
        return false;
    }
    let low = lower(core);
    if [
        "ung", "keit", "heit", "schaft", "tion", "ismus", "ität", "ment", "plan", "daten",
    ]
    .iter()
    .any(|s| low.ends_with(s))
    {
        return false;
    }
    if PARTICLES.contains(&lower(core).as_str()) {
        return true;
    }
    capitalized(core)
        && core
            .chars()
            .all(|c| c.is_alphabetic() || matches!(c, '.' | '-' | '\'' | '\u{2019}'))
}

const ACADEMIC: [&str; 16] = [
    "dr",
    "prof",
    "apl",
    "univ",
    "dipl",
    "ing",
    "mag",
    "habil",
    "rer",
    "nat",
    "phd",
    "msc",
    "bsc",
    "med",
    "jur",
    "professor",
];

/// "Dr.-Ing.", "Univ.-Prof.", "Dipl.-Ing." and the like.
fn is_academic_title(token: &str) -> bool {
    let low = lower(token.trim_matches(','));
    let parts: Vec<&str> = low.split(['.', '-']).filter(|p| !p.is_empty()).collect();
    !parts.is_empty() && parts.iter().all(|p| ACADEMIC.contains(p))
}

fn title_case(token: &str) -> String {
    let letters: Vec<char> = token.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        let mut out = String::new();
        let mut start = true;
        for c in token.chars() {
            if start && c.is_alphabetic() {
                out.extend(c.to_uppercase());
                start = false;
            } else {
                out.extend(c.to_lowercase());
                start = !c.is_alphabetic();
            }
        }
        out
    } else {
        token.to_owned()
    }
}

/// "Given Family" or "Family, Given" as a person; `None` if it does not look like a name.
fn one_person(text: &str) -> Option<Person> {
    let tokens: Vec<&str> = text
        .split_whitespace()
        .filter(|t| !is_academic_title(t))
        .collect();
    if tokens.len() < 2 || tokens.len() > 5 || !tokens.iter().all(|t| name_token_ok(t)) {
        return None;
    }
    let particle = |t: &str| PARTICLES.contains(&lower(t).as_str());
    if particle(tokens[0]) || particle(tokens[tokens.len() - 1]) {
        return None;
    }
    let foreign = |t: &str| {
        let word = bare(t);
        !PARTICLES.contains(&word.as_str())
            && (NOT_NAME.contains(&word.as_str())
                || AUTHORITY_WORDS.contains(&word.as_str())
                || matches!(word.as_str(), "stadt" | "gemeinde"))
    };
    if tokens.iter().any(|t| foreign(t)) {
        return None;
    }
    let tokens: Vec<String> = tokens.iter().map(|t| title_case(t)).collect();
    // The family name is the last word with the particles in front of it.
    let mut family_start = tokens.len() - 1;
    while family_start > 1 && PARTICLES.contains(&lower(&tokens[family_start - 1]).as_str()) {
        family_start -= 1;
    }
    let given = tokens[..family_start].join(" ");
    let family = tokens[family_start..].join(" ");
    Some(Person {
        family: family.chars().take(limits::BIB_PERSON_MAX).collect(),
        given: given.chars().take(limits::BIB_PERSON_MAX).collect(),
    })
}

/// The persons of one line ("A B, C D and E F" or "Family, Given"); every part must be a name.
fn parse_persons(line: &str) -> Option<Vec<Person>> {
    let mut text = line.trim().to_owned();
    for editor in ["(Hrsg.)", "(Hg.)", "(eds.)", "(Eds.)", "(ed.)", "(Ed.)"] {
        text = text.replace(editor, "");
    }
    let mut text = text.trim().to_owned();
    let low = lower(&text);
    for prefix in [
        "herausgegeben von",
        "hrsg. von",
        "edited by",
        "autor:",
        "autoren:",
        "author:",
        "authors:",
        "projektleitung:",
        "bearbeitung:",
        "bearbeiter:",
        "verfasser:",
        "von",
        "by",
    ] {
        if let Some(rest) = low.strip_prefix(prefix) {
            if rest.starts_with(|c: char| c.is_whitespace() || c == ':') || prefix.ends_with(':') {
                text = text
                    .get(low.len() - rest.len()..)
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                break;
            }
        }
    }
    if text.is_empty() || text.chars().count() > 300 || text.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let normalized = text
        .replace(" und ", ";")
        .replace(" and ", ";")
        .replace(" & ", ";")
        .replace(" / ", ";");
    let semicolons: Vec<&str> = normalized.split(';').collect();
    let mut persons = Vec::new();
    for part in semicolons {
        let commas: Vec<&str> = part.split(',').map(str::trim).collect();
        let family_given = commas.len() == 2
            && commas[0].split_whitespace().count() == 1
            && (1..=2).contains(&commas[1].split_whitespace().count())
            && !commas[1].is_empty();
        if family_given {
            let swapped = format!("{} {}", commas[1], commas[0]);
            persons.push(one_person(&swapped)?);
        } else {
            for piece in commas {
                persons.push(one_person(piece)?);
            }
        }
    }
    (!persons.is_empty() && persons.len() <= limits::BIB_AUTHORS_MAX).then_some(persons)
}

/// Splits "Title by Given Family and ..." into the title and its persons; `None` if no byline parses.
fn split_byline(title: &str) -> Option<(String, Vec<Person>)> {
    // ASCII lowercasing keeps every byte offset, and the markers start with an ASCII space.
    let low = title.to_ascii_lowercase();
    for marker in [
        " herausgegeben von ",
        " hrsg. von ",
        " edited by ",
        " von ",
        " by ",
    ] {
        let Some(at) = low.find(marker) else {
            continue;
        };
        let head = title.get(..at).unwrap_or("").trim();
        let rest = title.get(at + marker.len()..).unwrap_or("").trim();
        if head.chars().count() < 3 {
            continue;
        }
        if let Some(persons) = parse_persons(rest) {
            return Some((
                head.trim_end_matches([',', ':', '-']).trim().to_owned(),
                persons,
            ));
        }
    }
    None
}

/// The authors from the lines after (else before) the title.
fn find_authors(lines: &[Line], title_end: usize, title_start: usize) -> Vec<Person> {
    let mut found: Vec<Person> = Vec::new();
    let mut last_y = lines.get(title_end).map_or(0.0, |l| l.y);
    let reach = lines.get(title_end).map_or(0.0, |l| l.size as f32 * 4.0);
    for line in lines.iter().skip(title_end + 1).take(8) {
        if line.y - last_y > reach.max(60.0) {
            break;
        }
        last_y = line.y;
        match parse_persons(&line.text) {
            Some(mut persons) => found.append(&mut persons),
            None if !found.is_empty() => break,
            None => {}
        }
        if found.len() >= limits::BIB_AUTHORS_MAX {
            break;
        }
    }
    if found.is_empty() {
        for line in lines[..title_start.min(lines.len())].iter().rev().take(1) {
            if let Some(persons) = parse_persons(&line.text) {
                return persons;
            }
        }
    }
    found.truncate(limits::BIB_AUTHORS_MAX);
    found
}

// --- kind helpers ---

fn lines_with<'a>(lines: &'a [Line], words: &[&str]) -> Option<&'a Line> {
    lines.iter().find(|line| {
        let low = lower(&line.text);
        line.text.chars().count() <= 160 && words.iter().any(|w| low.contains(w))
    })
}

fn has_report_word(lines: &[Line]) -> bool {
    lines.iter().any(|line| {
        line.text.chars().count() <= 120
            && line.text.split_whitespace().any(|w| {
                let b = bare(w);
                matches!(
                    b.as_str(),
                    "report" | "bericht" | "gutachten" | "arbeitspapier" | "studie"
                ) || b.ends_with("bericht")
                    || b.ends_with("report")
                    || b == "working" && lower(&line.text).contains("working paper")
                    || lower(&line.text).contains("discussion paper")
                    || lower(&line.text).contains("white paper")
                    || lower(&line.text).contains("policy brief")
            })
    })
}

fn find_authority(lines: &[Line]) -> Option<String> {
    lines.iter().take(15).find_map(|l| authority_in(&l.text))
}

const AUTHORITY_CONNECTORS: [&str; 10] = [
    "der", "des", "für", "und", "von", "zu", "of", "for", "and", "the",
];

/// An authority named in a line: the keyword and the capitalised words that follow it ("Bundesministerium der Justiz und für
/// Verbraucherschutz", "Landeshauptstadt Erfurt").
fn authority_in(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        let key = bare(word);
        let is_key = AUTHORITY_WORDS.contains(&key.as_str())
            || key.ends_with("ministerium")
            || key == "landeshauptstadt";
        if !is_key || !capitalized(word) {
            continue;
        }
        let mut taken = vec![*word];
        for next in words.iter().skip(i + 1).take(7) {
            let b = bare(next);
            if capitalized(next)
                && !next.contains(':')
                && b.chars().all(char::is_alphabetic)
                && !b.is_empty()
                || AUTHORITY_CONNECTORS.contains(&b.as_str())
            {
                taken.push(next);
            } else {
                break;
            }
        }
        while taken
            .last()
            .is_some_and(|w| AUTHORITY_CONNECTORS.contains(&bare(w).as_str()))
        {
            taken.pop();
        }
        let alone = taken.len() == 1;
        if alone && i > 0 && !capitalized(words[i - 1]) {
            continue;
        }
        let joined = taken.join(" ");
        let trimmed = joined.trim_end_matches(|c: char| !c.is_alphanumeric());
        if trimmed.chars().count() >= 6 && !trimmed.chars().any(|c| c.is_ascii_digit()) {
            return tidy(trimmed, limits::BIB_PERSON_MAX);
        }
    }
    None
}

fn find_institution(lines: &[Line]) -> Option<String> {
    find_authority(lines).or_else(|| {
        lines
            .iter()
            .take(15)
            .filter(|l| l.text.chars().count() <= 90 && !l.text.chars().any(|c| c.is_ascii_digit()))
            .find(|l| {
                lower(&l.text).split_whitespace().any(|w| {
                    matches!(
                        bare(w).as_str(),
                        "institut" | "institute" | "foundation" | "stiftung"
                    )
                })
            })
            .and_then(|l| tidy(&l.text, limits::BIB_PERSON_MAX))
    })
}

/// Number after a label such as "Vol." / "Jg." / "No." / "Heft", with a bracketed issue "12(3)".
fn labelled_number(text: &str, labels: &[&str]) -> Option<(String, Option<String>)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        if !labels.contains(&bare(word).as_str()) {
            continue;
        }
        let Some(next) = words.get(i + 1) else {
            continue;
        };
        let next = next.trim_end_matches([',', ';', '.']);
        let (main, issue) = match next.split_once('(') {
            Some((m, rest)) => (m, Some(rest.trim_end_matches(')').to_owned())),
            None => (next, None),
        };
        if !main.is_empty()
            && main.len() <= 4
            && main.chars().all(|c| c.is_ascii_digit())
            && issue.as_ref().is_none_or(|n| {
                !n.is_empty() && n.len() <= 4 && n.chars().all(|c| c.is_ascii_digit())
            })
        {
            return Some((main.to_owned(), issue));
        }
    }
    None
}

fn find_pages(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        if !matches!(bare(word).as_str(), "pp" | "pages" | "s" | "seiten") {
            continue;
        }
        let Some(next) = words.get(i + 1) else {
            continue;
        };
        let next = next.trim_end_matches([',', ';', '.']);
        if let Some((a, b)) = next.split_once(['-', '\u{2013}', '\u{2014}']) {
            if [a, b]
                .iter()
                .all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit()))
            {
                return Some(format!("{a}\u{2013}{b}"));
            }
        }
    }
    None
}

/// The container: a short line with a journal word, cut where the numbers start.
fn find_container(lines: &[Line]) -> Option<String> {
    let line = lines.iter().take(14).find(|l| {
        let words = l.text.split_whitespace().count();
        (2..=10).contains(&words)
            && l.text.chars().count() <= 90
            && lower(&l.text)
                .split_whitespace()
                .any(|w| JOURNAL_WORDS.contains(&bare(w).as_str()))
    })?;
    let cut: String = line
        .text
        .chars()
        .take_while(|c| !c.is_ascii_digit())
        .collect();
    let cut = cut.trim_end_matches(|c: char| !c.is_alphabetic()).trim();
    // Cut at the last " vol" without slicing by an offset of a lowercased copy (its byte lengths can differ).
    let chars: Vec<char> = cut.chars().collect();
    let at = (0..chars.len()).rev().find(|&i| {
        chars[i..]
            .iter()
            .take(4)
            .flat_map(|c| c.to_lowercase())
            .eq(" vol".chars())
    });
    let cut: String = match at {
        Some(i) => chars[..i].iter().collect(),
        None => cut.to_owned(),
    };
    tidy(&cut, FIELD_MAX)
}

/// All hints from the pages that were read (file order index in each).
pub(super) fn hints_from_pages(pages: &[PageLines]) -> FirstPageHints {
    let mut hints = FirstPageHints::default();
    let front: Vec<&PageLines> = pages.iter().filter(|p| p.index < 3).collect();
    let imprint: Vec<&PageLines> = pages.iter().filter(|p| is_imprint(p)).collect();
    // Search order for the imprint facts: imprint pages, then the front pages.
    let mut order: Vec<&PageLines> = imprint.clone();
    for page in &front {
        if !order.iter().any(|p| p.index == page.index) {
            order.push(page);
        }
    }
    let texts: Vec<String> = order.iter().map(|p| joined(p)).collect();
    let front_text: String = front
        .iter()
        .map(|p| joined(p))
        .collect::<Vec<_>>()
        .join("\n");

    // Title: the largest-font run of page 1, else page 2, else page 3.
    let mut title_page: Option<(&PageLines, usize, usize)> = None;
    hints.title = law_title(front.first().map_or(&[][..], |p| &p.lines));
    let law = hints.title.is_some();
    for page in front.iter().filter(|_| !law) {
        if let Some((title, start, end)) = find_title_at(&page.lines) {
            if SECTION_HEADINGS.contains(&bare(&title).as_str()) {
                continue;
            }
            hints.title = Some(title);
            title_page = Some((page, start, end));
            break;
        }
    }

    // DOI: front pages first, then the imprint pages of the first eight pages (a last page lists other works' DOIs).
    let doi_texts = std::iter::once(front_text.clone())
        .chain(imprint.iter().filter(|p| p.index < 8).map(|p| joined(p)));
    let mut doi_span_text = front_text.clone();
    for text in doi_texts {
        if let Some((doi, span)) = find_doi(&text) {
            hints.doi = Some(doi);
            doi_span_text = format!(
                "{} {}",
                text.get(..span.start).unwrap_or(""),
                text.get(span.end..).unwrap_or("")
            );
            break;
        }
    }
    if hints.doi.is_none() {
        doi_span_text = front_text.clone();
    }

    hints.isbn = texts
        .iter()
        .find_map(|t| find_isbn(t))
        .or_else(|| find_isbn(&front_text));
    hints.edition = texts
        .iter()
        .find_map(|t| find_edition(t))
        .and_then(|e| tidy(&e, FIELD_MAX));

    // Place and publisher, with the year that stands beside them.
    let mut pp_year: Option<String> = None;
    'search: for page in &order {
        let book_page = is_book_page(page);
        for line in &page.lines {
            if let Some((place, publisher, year)) = place_publisher(&line.text, book_page) {
                hints.place = tidy(&place, FIELD_MAX);
                hints.publisher = tidy(&publisher, FIELD_MAX);
                pp_year = year;
                break 'search;
            }
        }
    }
    if hints.publisher.is_none() {
        'lines: for page in &order {
            for line in &page.lines {
                if let Some((publisher, place)) = publisher_line(&line.text) {
                    hints.publisher = tidy(&publisher, FIELD_MAX);
                    hints.place = place.and_then(|p| tidy(&p, FIELD_MAX));
                    break 'lines;
                }
            }
        }
    }

    // Year: beside the publisher, then the imprint pages (the year of this edition), then the front pages.
    hints.year = pp_year
        .or_else(|| {
            imprint
                .iter()
                .filter(|p| p.index < 8)
                .find_map(|p| find_year(&without_doi(&joined(p))))
        })
        .or_else(|| find_year(&doi_span_text))
        .or_else(|| {
            imprint
                .iter()
                .filter(|p| p.index >= 8)
                .find_map(|p| find_year(&without_doi(&joined(p))))
        })
        .or_else(|| texts.iter().find_map(|t| find_edition_year(t)));

    // Authors.
    if let Some((page, start, end)) = title_page {
        hints.authors = find_authors(&page.lines, end, start);
        if let Some((head, persons)) = hints.title.as_deref().and_then(split_byline) {
            hints.title = Some(head);
            if hints.authors.is_empty() {
                hints.authors = persons;
            }
        }
    }

    // Journal facts.
    let first_lines: Vec<Line> = front.iter().flat_map(|p| p.lines.iter().cloned()).collect();
    let container = if hints.isbn.is_some() {
        None
    } else {
        find_container(&first_lines)
    };
    if container.is_some() || (hints.doi.is_some() && hints.isbn.is_none()) {
        let volume = labelled_number(
            &front_text,
            &["vol", "volume", "jg", "jahrgang", "band", "bd"],
        );
        let issue = labelled_number(&front_text, &["no", "nr", "issue", "heft", "h"]);
        hints.volume = volume.as_ref().map(|v| v.0.clone());
        hints.issue = issue.map(|i| i.0).or_else(|| volume.and_then(|v| v.1));
        hints.pages = find_pages(&front_text);
        hints.container_title = container;
    }

    // Kind.
    let page_one: Vec<Line> = front.first().map(|p| p.lines.clone()).unwrap_or_default();
    let head: Vec<Line> = page_one.iter().take(14).cloned().collect();
    let title_lines: Vec<Line> = hints
        .title
        .iter()
        .map(|t| Line {
            y: 0.0,
            size: 0,
            text: t.clone(),
        })
        .collect();
    let top: Vec<Line> = head.iter().chain(title_lines.iter()).cloned().collect();
    let official = hints.isbn.is_none()
        && hints.publisher.is_none()
        && lines_with(&top, &OFFICIAL_WORDS).is_some();
    let thesis = hints.isbn.is_none() && lines_with(&top, &THESIS_WORDS).is_some();
    let report = hints.isbn.is_none() && hints.doi.is_none() && has_report_word(&top);
    hints.kind = if official || report {
        Some(BibKind::Report)
    } else if thesis {
        Some(BibKind::Thesis)
    } else if hints.isbn.is_some() {
        Some(BibKind::Book)
    } else if hints.doi.is_some() || (hints.volume.is_some() && hints.pages.is_some()) {
        Some(BibKind::Article)
    } else if hints.publisher.is_some() || hints.edition.is_some() {
        Some(BibKind::Book)
    } else {
        None
    };
    // The authority is the author of an official text, the institution of a report without a named author.
    if hints.authors.is_empty() {
        let name = if official {
            find_authority(&first_lines)
        } else if report {
            find_institution(&first_lines)
        } else {
            None
        };
        if let Some(name) = name {
            hints.authors = vec![Person {
                family: name,
                given: String::new(),
            }];
        }
    }
    hints
}

/// A year right after "Auflage"/"edition" words found in the imprint ("3. Auflage 2021").
fn find_edition_year(text: &str) -> Option<String> {
    let low = lower(text);
    ["auflage", "edition", "erschienen"].iter().find_map(|key| {
        low.find(key).and_then(|at| {
            low.get(at + key.len()..)
                .and_then(|rest| plain_year(&rest.chars().take(24).collect::<String>()))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(y: f32, size: i32, text: &str) -> Line {
        Line {
            y,
            size,
            text: text.to_owned(),
        }
    }

    fn page(index: usize, lines: &[(i32, &str)]) -> PageLines {
        PageLines {
            index,
            lines: lines
                .iter()
                .enumerate()
                .map(|(i, (size, text))| line(40.0 + 30.0 * i as f32, *size, text))
                .collect(),
        }
    }

    const BODY: &str =
        "Body text of the work that runs on for a good while and has many characters in it.";

    #[test]
    fn isbn_checksums_decide() {
        assert_eq!(
            find_isbn("ISBN 978-3-16-148410-0"),
            Some("9783161484100".into())
        );
        assert_eq!(
            find_isbn("ISBN-13: 978 3 16 148410 0 Printed"),
            Some("9783161484100".into())
        );
        assert_eq!(find_isbn("ISBN 0-8044-2957-X"), Some("080442957X".into()));
        assert_eq!(
            find_isbn("ISBN 0-306-40615-2 2019"),
            Some("0306406152".into())
        );
        assert_eq!(find_isbn("ISBN 978-3-16-148410-1"), None);
        assert_eq!(
            find_isbn("order 9783161484100 today"),
            Some("9783161484100".into())
        );
        assert_eq!(find_isbn("ISBN"), None);
        assert_eq!(find_isbn("x978-3-16-148410-0"), None);
    }

    #[test]
    fn editions_are_read_in_both_languages() {
        assert_eq!(
            find_edition("3., überarbeitete Auflage 2020"),
            Some("3".into())
        );
        assert_eq!(find_edition("2. Auflage"), Some("2".into()));
        assert_eq!(find_edition("Auflage 4"), Some("4".into()));
        assert_eq!(find_edition("Second Edition"), Some("2".into()));
        assert_eq!(find_edition("5th revised edition"), Some("5".into()));
        assert_eq!(find_edition("Edition 2019"), None);
        assert_eq!(find_edition("page 3 of 10"), None);
    }

    #[test]
    fn a_book_imprint_gives_publisher_place_year_edition_isbn_and_authors() {
        let pages = [
            page(
                0,
                &[
                    (14, "Reihe Grundlagen"),
                    (28, "Einführung in die Statistik"),
                    (14, "Anna Müller und Hans van der Berg"),
                    (11, BODY),
                    (11, BODY),
                ],
            ),
            page(
                1,
                &[
                    (9, "Bibliografische Information"),
                    (9, "3. Auflage"),
                    (9, "Berlin: Musterverlag, 2021"),
                    (9, "ISBN 978-3-16-148410-0"),
                    (9, "\u{a9} 2021 Alle Rechte vorbehalten"),
                ],
            ),
        ];
        let hints = hints_from_pages(&pages);
        assert_eq!(hints.title.as_deref(), Some("Einführung in die Statistik"));
        assert_eq!(hints.isbn.as_deref(), Some("9783161484100"));
        assert_eq!(hints.edition.as_deref(), Some("3"));
        assert_eq!(hints.publisher.as_deref(), Some("Musterverlag"));
        assert_eq!(hints.place.as_deref(), Some("Berlin"));
        assert_eq!(hints.year.as_deref(), Some("2021"));
        assert_eq!(hints.kind, Some(BibKind::Book));
        assert_eq!(
            hints.authors,
            vec![
                Person {
                    family: "Müller".into(),
                    given: "Anna".into()
                },
                Person {
                    family: "van der Berg".into(),
                    given: "Hans".into()
                },
            ]
        );
    }

    #[test]
    fn the_generated_book_layout_gives_title_and_author() {
        let pages = [
            page(0, &[(28, "A Short History of Maps"), (16, "Anna Berger")]),
            page(
                1,
                &[
                    (11, "A Short History of Maps"),
                    (11, "by Anna Berger"),
                    (10, "Copyright 2011 by Anna Berger. All rights reserved."),
                    (10, "Second edition 2011"),
                    (10, "Published by Harbor Press, Leeds"),
                    (10, "ISBN 978-3-16-148410-0"),
                ],
            ),
            page(2, &[(18, "Chapter 1"), (12, BODY)]),
        ];
        let hints = hints_from_pages(&pages);
        assert_eq!(hints.title.as_deref(), Some("A Short History of Maps"));
        assert_eq!(hints.authors.len(), 1);
        assert_eq!(hints.authors[0].family, "Berger");
        assert_eq!(hints.authors[0].given, "Anna");
        // Half-point sizes and 16 pt line gaps as the generator sets them: the byline must not join the title.
        let tight = [PageLines {
            index: 0,
            lines: vec![
                line(700.0, 22, "A Short History of Maps"),
                line(684.0, 22, "by Anna Berger"),
                line(
                    660.0,
                    20,
                    "Copyright 2011 by Anna Berger. All rights reserved.",
                ),
                line(644.0, 20, "Second edition 2011"),
            ],
        }];
        let t = hints_from_pages(&tight);
        assert_eq!(t.title.as_deref(), Some("A Short History of Maps"));
        assert_eq!(t.authors.len(), 1);
        let one = [page(
            0,
            &[
                (26, "Maps and Roads by Anna Berger and Hans Roth"),
                (11, BODY),
            ],
        )];
        let h = hints_from_pages(&one);
        assert_eq!(h.title.as_deref(), Some("Maps and Roads"));
        assert_eq!(h.authors.len(), 2);
        let two = [page(
            0,
            &[
                (26, "Maps and Roads"),
                (14, "herausgegeben von Anna Berger, Hans Roth"),
                (11, BODY),
            ],
        )];
        assert_eq!(hints_from_pages(&two).authors.len(), 2);
    }

    #[test]
    fn an_article_with_a_doi_is_an_article_with_its_journal_facts() {
        let pages = [page(
            0,
            &[
                (10, "Journal of Examples, Vol. 12(3), pp. 123-145"),
                (22, "On the Behaviour of Things"),
                (12, "Jane Q. Public, John Roe"),
                (9, "https://doi.org/10.1016/j.cell.2020.05.001"),
                (9, "\u{a9} 2020 The Authors"),
                (10, BODY),
            ],
        )];
        let hints = hints_from_pages(&pages);
        assert_eq!(hints.kind, Some(BibKind::Article));
        assert_eq!(hints.doi.as_deref(), Some("10.1016/j.cell.2020.05.001"));
        assert_eq!(hints.year.as_deref(), Some("2020"));
        assert_eq!(
            hints.container_title.as_deref(),
            Some("Journal of Examples")
        );
        assert_eq!(hints.volume.as_deref(), Some("12"));
        assert_eq!(hints.issue.as_deref(), Some("3"));
        assert_eq!(hints.pages.as_deref(), Some("123\u{2013}145"));
        assert_eq!(hints.authors.len(), 2);
        assert_eq!(hints.authors[0].family, "Public");
        assert_eq!(hints.authors[0].given, "Jane Q.");
    }

    #[test]
    fn an_official_text_is_a_report_by_its_authority() {
        let pages = [page(
            0,
            &[
                (12, "Stadt Beispielstadt"),
                (22, "Satzung über die Nutzung öffentlicher Einrichtungen"),
                (11, BODY),
                (11, BODY),
            ],
        )];
        let hints = hints_from_pages(&pages);
        assert_eq!(hints.kind, Some(BibKind::Report));
        assert_eq!(
            hints.authors,
            vec![Person {
                family: "Stadt Beispielstadt".into(),
                given: String::new()
            }]
        );
    }

    #[test]
    fn a_report_names_its_institution_and_a_plain_page_stays_unclassified() {
        let report = hints_from_pages(&[page(
            0,
            &[
                (12, "Institut für Beispiele"),
                (24, "Jahresbericht 2019"),
                (11, BODY),
                (11, BODY),
            ],
        )]);
        assert_eq!(report.kind, Some(BibKind::Report));
        assert_eq!(report.authors[0].family, "Institut für Beispiele");
        assert_eq!(
            hints_from_pages(&[page(0, &[(11, BODY), (11, BODY)])]),
            FirstPageHints::default()
        );
        assert_eq!(hints_from_pages(&[]), FirstPageHints::default());
    }

    #[test]
    fn a_journal_line_with_case_changing_letters_does_not_panic() {
        let lines = [
            line(0.0, 20, "{1e9e} Journal {dc}{dc} vol"),
            line(20.0, 20, "x"),
        ];
        let _ = find_container(&lines);
    }

    #[test]
    fn hostile_text_is_bounded_and_does_not_panic() {
        let long = "Verlag ".repeat(2_000);
        let weird =
            "\u{0}\u{202e}ISBN 97\u{301}8: \u{a9} 99999999999999999999 Auflage ,,, ::: ((( 10.";
        let pages = [
            page(
                0,
                &[(30, &long), (10, weird), (10, "A, B, C, D, E, F, G, H, I")],
            ),
            page(7, &[(10, weird), (10, &"X ".repeat(5_000))]),
        ];
        let hints = hints_from_pages(&pages);
        assert!(hints.authors.len() <= limits::BIB_AUTHORS_MAX);
        assert!(hints
            .publisher
            .as_deref()
            .is_none_or(|p| p.chars().count() <= FIELD_MAX));
    }

    #[test]
    fn authors_are_names_not_title_words() {
        assert!(parse_persons("Einführung in die Statistik").is_none());
        assert!(parse_persons("The Art of War").is_none());
        assert!(parse_persons("Cambridge University Press").is_none());
        let one = parse_persons("Müller, Hans").unwrap();
        assert_eq!(
            (one[0].family.as_str(), one[0].given.as_str()),
            ("Müller", "Hans")
        );
        let caps = parse_persons("JOHN SMITH").unwrap();
        assert_eq!(caps[0].family, "Smith");
        assert_eq!(
            parse_persons("von Maria Schmidt").unwrap()[0].family,
            "Schmidt"
        );
    }
}
