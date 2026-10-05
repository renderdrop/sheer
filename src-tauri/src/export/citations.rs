//! Citation list export (ADR-119 section 8): the typed blocks the UI sends and the file formats Rust writes.
//!
//! The UI never sends markup. `Txt`, `Html` and `Md` are made here from [`StyledBlock`]s (runs of text, each upright or italic) with
//! the escaping of the format; `Ris` and `Bib` are made from the stored [`BibRecord`] (the reference only, no quotes). Every function
//! that turns text into a file format treats the text as hostile: page text and PDF metadata end up in it.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::bibliography::{BibKind, BibRecord, Person};
use crate::storage::atomic::write_atomic;

/// The citation style the list was made in (it only names the file; the text comes formatted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitationStyle {
    Apa7,
    Mla9,
    Chicago17AuthorDate,
    DinIso690,
}

impl CitationStyle {
    /// The name in a file name: fixed words, never input.
    pub const fn file_label(self) -> &'static str {
        match self {
            Self::Apa7 => "APA 7",
            Self::Mla9 => "MLA 9",
            Self::Chicago17AuthorDate => "Chicago 17",
            Self::DinIso690 => "DIN ISO 690",
        }
    }
}

/// The file formats of `save_citation_list`: `Txt`, `Html` and `Md` are written from the blocks, `Ris` and `Bib` from the stored record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitationFileFormat {
    Txt,
    Html,
    Md,
    Ris,
    Bib,
}

impl CitationFileFormat {
    /// The file extension without the dot.
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Html => "html",
            Self::Md => "md",
            Self::Ris => "ris",
            Self::Bib => "bib",
        }
    }

    /// The label of the filter in the save dialog.
    pub const fn filter_label(self) -> &'static str {
        match self {
            Self::Txt => "Text",
            Self::Html => "HTML",
            Self::Md => "Markdown",
            Self::Ris => "RIS",
            Self::Bib => "BibTeX",
        }
    }

    /// `Ris` and `Bib` come from the stored record, not from blocks.
    pub const fn from_record(self) -> bool {
        matches!(self, Self::Ris | Self::Bib)
    }
}

/// A piece of a block in one face.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    #[serde(default)]
    pub italic: bool,
}

/// A paragraph of formatted text: at most `limits::STYLED_RUNS_MAX` runs of at most `STYLED_RUN_CHARS_MAX` characters. Never markup.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyledBlock {
    pub runs: Vec<Run>,
}

// --- Checks ------------------------------------------------------------------------------------------------------------

/// The caps on what the UI sent: at most `CITATION_EXPORT_BLOCKS_MAX` blocks, `STYLED_RUNS_MAX` runs per block, `STYLED_RUN_CHARS_MAX`
/// characters per run and `CITATION_EXPORT_MAX` bytes of text in all. Checked before anything is built.
pub fn check_blocks(blocks: &[StyledBlock]) -> Result<(), AppError> {
    if blocks.len() > limits::CITATION_EXPORT_BLOCKS_MAX {
        return Err(AppError::limit(
            "blocks",
            limits::CITATION_EXPORT_BLOCKS_MAX as u64,
        ));
    }
    let mut bytes = 0usize;
    for block in blocks {
        if block.runs.len() > limits::STYLED_RUNS_MAX {
            return Err(AppError::limit("runs", limits::STYLED_RUNS_MAX as u64));
        }
        for run in &block.runs {
            // `len() / 4` is a lower bound of the characters, so most runs are judged without counting.
            if run.text.len() / 4 > limits::STYLED_RUN_CHARS_MAX
                || run.text.chars().count() > limits::STYLED_RUN_CHARS_MAX
            {
                return Err(AppError::too_large(
                    "run",
                    limits::STYLED_RUN_CHARS_MAX as u64,
                ));
            }
            bytes = bytes.saturating_add(run.text.len());
        }
        if bytes > limits::CITATION_EXPORT_MAX {
            return Err(AppError::too_large(
                "citationList",
                limits::CITATION_EXPORT_MAX as u64,
            ));
        }
    }
    Ok(())
}

// --- Blocks to txt, html, md -------------------------------------------------------------------------------------------

/// A control character, and the line and paragraph separators (U+2028, U+2029), become a space (a block is one paragraph, so a line
/// break is none either).
fn plain(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// Plain text: the blocks as paragraphs separated by a blank line; italics are not marked.
pub fn to_text(blocks: &[StyledBlock]) -> String {
    let paragraphs: Vec<String> = blocks
        .iter()
        .map(|block| block.runs.iter().map(|run| plain(&run.text)).collect())
        .collect();
    let mut out = paragraphs.join("\n\n");
    out.push('\n');
    out
}

/// HTML text: `& < > " '` become entities, controls become spaces.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// A complete HTML document: one `<p>` per block, italic runs in `<i>`. It holds no script, style or link, and a CSP that forbids all.
pub fn to_html(blocks: &[StyledBlock]) -> String {
    let mut out = String::from(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\">\n\
         <title>References</title>\n</head>\n<body>\n",
    );
    for block in blocks {
        out.push_str("<p>");
        for run in &block.runs {
            if run.italic && !run.text.is_empty() {
                out.push_str("<i>");
                out.push_str(&escape_html(&run.text));
                out.push_str("</i>");
            } else {
                out.push_str(&escape_html(&run.text));
            }
        }
        out.push_str("</p>\n");
    }
    out.push_str("</body>\n</html>\n");
    out
}

/// Markdown text: the characters that mean something in Markdown get a backslash. Controls become spaces.
pub fn escape_markdown(text: &str) -> String {
    let text = plain(text);
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '`'
                | '*'
                | '_'
                | '['
                | ']'
                | '('
                | ')'
                | '<'
                | '>'
                | '#'
                | '|'
                | '~'
                | '&'
                | '!'
                | '$'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The start of a block, where `+`, `-`, `=` and `12.` or `12)` would begin a list item or a heading.
fn escape_block_start(escaped: String) -> String {
    let trimmed = escaped.trim_start();
    let lead = escaped.len() - trimmed.len();
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    let after = trimmed[digits..].chars().next();
    let list_marker = matches!(trimmed.chars().next(), Some('+' | '-' | '='));
    let numbered = digits > 0 && matches!(after, Some('.' | ')'));
    if list_marker {
        format!("{}\\{}", &escaped[..lead], trimmed)
    } else if numbered {
        format!(
            "{}{}\\{}",
            &escaped[..lead],
            &trimmed[..digits],
            &trimmed[digits..]
        )
    } else {
        escaped
    }
}

/// Markdown: one paragraph per block, italic runs in `*...*` (the spaces at the edges of a run stay outside the marks).
pub fn to_markdown(blocks: &[StyledBlock]) -> String {
    let mut paragraphs: Vec<String> = Vec::with_capacity(blocks.len());
    for block in blocks {
        let mut line = String::new();
        for run in &block.runs {
            let escaped = escape_markdown(&run.text);
            let core = escaped.trim();
            if run.italic && !core.is_empty() {
                let lead = escaped.len() - escaped.trim_start().len();
                let tail = escaped.len() - escaped.trim_end().len();
                line.push_str(&escaped[..lead]);
                line.push('*');
                line.push_str(core);
                line.push('*');
                line.push_str(&escaped[escaped.len() - tail..]);
            } else {
                line.push_str(&escaped);
            }
        }
        // Two spaces at the end of a line are a hard break in Markdown.
        paragraphs.push(escape_block_start(line.trim_end().to_owned()));
    }
    let mut out = paragraphs.join("\n\n");
    out.push('\n');
    out
}

/// The text of a `Txt`, `Html` or `Md` file; the blocks are checked first.
pub fn render_blocks(
    format: CitationFileFormat,
    blocks: &[StyledBlock],
) -> Result<String, AppError> {
    check_blocks(blocks)?;
    match format {
        CitationFileFormat::Txt => Ok(to_text(blocks)),
        CitationFileFormat::Html => Ok(to_html(blocks)),
        CitationFileFormat::Md => Ok(to_markdown(blocks)),
        CitationFileFormat::Ris | CitationFileFormat::Bib => Err(AppError::invalid("format")),
    }
}

// --- Record to ris and bib ---------------------------------------------------------------------------------------------

/// A value of a field: controls (so every line break) become spaces, whitespace is collapsed, the length is capped. A value therefore
/// never holds a line, which is what keeps an `ER  -` or `@entry` in it text.
fn single_line(text: &str) -> String {
    let cut: String = text
        .chars()
        .take(limits::STYLED_RUN_CHARS_MAX)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cut.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn nonempty(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(single_line)
        .filter(|text| !text.is_empty())
}

fn ris_type(kind: BibKind) -> &'static str {
    match kind {
        BibKind::Book => "BOOK",
        BibKind::Article => "JOUR",
        BibKind::Chapter => "CHAP",
        BibKind::Report => "RPRT",
        BibKind::WebPage => "ELEC",
        BibKind::Thesis => "THES",
    }
}

fn person_line(person: &Person) -> String {
    let family = single_line(&person.family);
    let given = single_line(&person.given);
    if given.is_empty() {
        family
    } else if family.is_empty() {
        given
    } else {
        format!("{family}, {given}")
    }
}

/// The start and end page of a `pages` value such as `12-15`, `12–15` or `e45`.
fn page_range(pages: &str) -> (String, Option<String>) {
    match pages.split_once(['-', '\u{2013}', '\u{2014}']) {
        Some((start, end)) if !start.trim().is_empty() && !end.trim().is_empty() => (
            start.trim().to_owned(),
            Some(end.trim_start_matches(['-', '\u{2013}']).trim().to_owned()),
        ),
        _ => (pages.trim().to_owned(), None),
    }
}

/// A RIS file with one entry: `TAG  - value` lines, CRLF, ended by `ER  - `. A value never holds a line break, so no value can
/// end the entry or start another.
pub fn to_ris(record: &BibRecord) -> String {
    let mut lines: Vec<(&str, String)> = vec![("TY", ris_type(record.kind).to_owned())];
    for person in record.authors.iter().take(limits::BIB_AUTHORS_MAX) {
        let line = person_line(person);
        if !line.is_empty() {
            lines.push(("AU", line));
        }
    }
    let mut put = |tag: &'static str, value: Option<String>| {
        if let Some(value) = value {
            lines.push((tag, value));
        }
    };
    put("TI", nonempty(&record.title));
    put("PY", nonempty(&record.year));
    put("T2", nonempty(&record.container_title));
    put("VL", nonempty(&record.volume));
    put("IS", nonempty(&record.issue));
    if let Some(pages) = nonempty(&record.pages) {
        let (start, end) = page_range(&pages);
        put("SP", Some(start));
        put("EP", end);
    }
    put("ET", nonempty(&record.edition));
    put("PB", nonempty(&record.publisher));
    put("CY", nonempty(&record.place));
    put("DO", nonempty(&record.doi));
    put("UR", nonempty(&record.url));
    put(
        "Y2",
        nonempty(&record.accessed).map(|date| format!("{}/", date.replace('-', "/"))),
    );
    let mut out = String::new();
    for (tag, value) in lines {
        out.push_str(tag);
        out.push_str("  - ");
        out.push_str(&value);
        out.push_str("\r\n");
    }
    out.push_str("ER  - \r\n");
    out
}

/// Text for a BibTeX field value between braces. Braces that nest properly stay (they are groups to TeX, and none can close the
/// field early); if they do not nest, all are dropped. The TeX specials become their commands.
pub fn escape_bibtex(text: &str) -> String {
    let text = single_line(text);
    let mut depth = 0usize;
    let mut nests = true;
    for c in text.chars() {
        match c {
            '{' => depth += 1,
            '}' => match depth.checked_sub(1) {
                Some(next) => depth = next,
                None => {
                    nests = false;
                    break;
                }
            },
            _ => {}
        }
    }
    nests &= depth == 0;
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '{' | '}' if !nests => {}
            '\\' => out.push_str("\\textbackslash{}"),
            '%' | '&' | '#' | '_' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '^' => out.push_str("\\^{}"),
            '~' => out.push_str("\\~{}"),
            c => out.push(c),
        }
    }
    out
}

/// A DOI or URL for a BibTeX field: braces and backslashes are percent-encoded, no TeX escaping (`\url` takes the text as it is).
fn escape_bibtex_url(text: &str) -> String {
    single_line(text)
        .replace('{', "%7B")
        .replace('}', "%7D")
        .replace('\\', "%5C")
}

fn bibtex_type(kind: BibKind) -> &'static str {
    match kind {
        BibKind::Book => "book",
        BibKind::Article => "article",
        BibKind::Chapter => "incollection",
        BibKind::Report => "techreport",
        BibKind::WebPage => "misc",
        BibKind::Thesis => "phdthesis",
    }
}

/// The citation key: ASCII letters and digits of the first author's family name and the year, `ref` if there are none.
fn bibtex_key(record: &BibRecord) -> String {
    let family = record
        .authors
        .first()
        .map(|person| person.family.as_str())
        .unwrap_or_default();
    let year = record.year.as_deref().unwrap_or_default();
    let key: String = family
        .chars()
        .chain(year.chars())
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .collect();
    if key.is_empty() {
        "ref".to_owned()
    } else {
        key
    }
}

fn has_and(text: &str) -> bool {
    text.split_whitespace()
        .any(|word| word.eq_ignore_ascii_case("and"))
}

fn bibtex_author(person: &Person) -> String {
    let family = escape_bibtex(&person.family);
    let given = escape_bibtex(&person.given);
    if given.is_empty() {
        // An organisation: one braced name, never split at "and" or a comma.
        return format!("{{{family}}}");
    }
    // A word "and" in a name would split the author list, so such a part is braced.
    let family = if has_and(&family) {
        format!("{{{family}}}")
    } else {
        family
    };
    let given = if has_and(&given) {
        format!("{{{given}}}")
    } else {
        given
    };
    format!("{family}, {given}")
}

/// A BibTeX file with one entry. Every value is a braced field value that cannot end early (see [`escape_bibtex`]).
pub fn to_bibtex(record: &BibRecord) -> String {
    let mut fields: Vec<(&str, String)> = Vec::new();
    let authors: Vec<String> = record
        .authors
        .iter()
        .take(limits::BIB_AUTHORS_MAX)
        .filter(|person| !(person.family.trim().is_empty() && person.given.trim().is_empty()))
        .map(bibtex_author)
        .collect();
    if !authors.is_empty() {
        fields.push(("author", authors.join(" and ")));
    }
    let mut put = |name: &'static str, value: Option<String>, url: bool| {
        if let Some(value) = value {
            let value = if url {
                escape_bibtex_url(&value)
            } else {
                escape_bibtex(&value)
            };
            fields.push((name, value));
        }
    };
    put("title", nonempty(&record.title), false);
    let container = match record.kind {
        BibKind::Article => "journal",
        _ => "booktitle",
    };
    put(container, nonempty(&record.container_title), false);
    put("year", nonempty(&record.year), false);
    put("volume", nonempty(&record.volume), false);
    put("number", nonempty(&record.issue), false);
    put(
        "pages",
        nonempty(&record.pages).map(|pages| {
            let (start, end) = page_range(&pages);
            end.map_or(start.clone(), |end| format!("{start}--{end}"))
        }),
        false,
    );
    put("edition", nonempty(&record.edition), false);
    let publisher = match record.kind {
        BibKind::Report => "institution",
        BibKind::Thesis => "school",
        _ => "publisher",
    };
    put(publisher, nonempty(&record.publisher), false);
    put("address", nonempty(&record.place), false);
    put("doi", nonempty(&record.doi), true);
    put("url", nonempty(&record.url), true);
    put("urldate", nonempty(&record.accessed), false);
    let mut out = String::new();
    // Writing to a `String` cannot fail.
    let _ = writeln!(
        out,
        "@{}{{{},",
        bibtex_type(record.kind),
        bibtex_key(record)
    );
    for (name, value) in fields {
        let _ = writeln!(out, "  {name} = {{{value}}},");
    }
    out.push_str("}\n");
    out
}

/// The text of the file for `format`: from `blocks` (`Txt`, `Html`, `Md`; at least one) or from `record` (`Ris`, `Bib`; `blocks`
/// must be empty). At most `CITATION_EXPORT_MAX` bytes.
pub fn render(
    format: CitationFileFormat,
    blocks: &[StyledBlock],
    record: Option<&BibRecord>,
) -> Result<String, AppError> {
    let text = if format.from_record() {
        if !blocks.is_empty() {
            return Err(AppError::invalid("blocks"));
        }
        let record = record.ok_or(AppError::invalid("bibliography"))?;
        if format == CitationFileFormat::Ris {
            to_ris(record)
        } else {
            to_bibtex(record)
        }
    } else {
        if blocks.is_empty() {
            return Err(AppError::invalid("blocks"));
        }
        render_blocks(format, blocks)?
    };
    if text.len() > limits::CITATION_EXPORT_MAX {
        return Err(AppError::too_large(
            "citationList",
            limits::CITATION_EXPORT_MAX as u64,
        ));
    }
    Ok(text)
}

// --- The file ----------------------------------------------------------------------------------------------------------

/// The name the save dialog starts with: `<stem> - citations (<style>).<ext>`; for RIS and BibTeX, which hold no style,
/// `<stem> - reference.<ext>`. `stem` comes from `export::names::export_stem`.
pub fn default_file_name(stem: &str, format: CitationFileFormat, style: CitationStyle) -> String {
    let ext = format.extension();
    if format.from_record() {
        format!("{stem} - reference.{ext}")
    } else {
        format!("{stem} - citations ({}).{ext}", style.file_label())
    }
}

/// The path the list is written to, judged like a Save As target (SECURITY I3): plain spelling, an existing folder (resolved), the
/// extension of the format (added if the dialog left it out), and what is there already, if anything, a regular file that is not a link.
pub fn admit_target(path: &Path, format: CitationFileFormat) -> Result<PathBuf, AppError> {
    if !crate::documents::intake::spelling_is_plain(path) {
        return Err(AppError::invalid("path"));
    }
    let name = path.file_name().ok_or(AppError::invalid("path"))?;
    let folder = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let folder = std::fs::canonicalize(folder)?;
    if !crate::documents::intake::spelling_is_plain(&folder) {
        return Err(AppError::invalid("path"));
    }
    let mut file_name = OsString::from(name);
    let has_extension = Path::new(name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(format.extension()));
    if !has_extension {
        file_name.push(".");
        file_name.push(format.extension());
    }
    let target = folder.join(file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(AppError::logged(
                ErrorCode::InvalidArgument,
                "the save target is a folder, a link or a device",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(target)
}

/// Makes the file for `format` and writes it atomically to `target` (judged by [`admit_target`]). Answers the path written; it
/// never goes to the UI.
pub fn write_list(
    target: &Path,
    format: CitationFileFormat,
    blocks: &[StyledBlock],
    record: Option<&BibRecord>,
) -> Result<PathBuf, AppError> {
    let text = render(format, blocks, record)?;
    let target = admit_target(target, format)?;
    write_atomic(&target, text.as_bytes()).map_err(|error| {
        let error = AppError::from(error);
        match error.code() {
            ErrorCode::IoInUse
            | ErrorCode::IoPermissionDenied
            | ErrorCode::IoNotFound
            | ErrorCode::IoDiskFull => error,
            _ => AppError::logged(ErrorCode::SaveFailed, error),
        }
    })?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(runs: &[(&str, bool)]) -> StyledBlock {
        StyledBlock {
            runs: runs
                .iter()
                .map(|(text, italic)| Run {
                    text: (*text).to_owned(),
                    italic: *italic,
                })
                .collect(),
        }
    }

    #[test]
    fn html_escapes_markup_and_marks_italics() {
        let out = to_html(&[block(&[
            ("<script>alert('x')</script> & \"q\"", false),
            ("Title", true),
        ])]);
        assert!(out.contains(
            "<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;<i>Title</i></p>"
        ));
        assert!(!out.contains("<script"));
        assert!(out.contains("default-src 'none'"));
        assert_eq!(escape_html("a\u{0}b\nc"), "a b c");
    }

    #[test]
    fn markdown_escapes_control_characters_and_marks_italics() {
        assert_eq!(
            escape_markdown("*a* _b_ [c](d) `e` <f> #g | ~h~ \\ & !"),
            "\\*a\\* \\_b\\_ \\[c\\]\\(d\\) \\`e\\` \\<f\\> \\#g \\| \\~h\\~ \\\\ \\& \\!"
        );
        let out = to_markdown(&[block(&[
            ("Smith, J. ", false),
            (" A *title* ", true),
            ("(2020).", false),
        ])]);
        assert_eq!(out, "Smith, J.  *A \\*title\\** \\(2020\\).\n");
    }

    #[test]
    fn markdown_block_starts_cannot_open_lists_or_headings() {
        for (input, expected) in [
            ("- item", "\\- item\n"),
            ("+ item", "\\+ item\n"),
            ("1. item", "1\\. item\n"),
            ("12) item", "12\\) item\n"),
            ("# head", "\\# head\n"),
            ("> quote", "\\> quote\n"),
            ("= x", "\\= x\n"),
            ("2020 was", "2020 was\n"),
        ] {
            assert_eq!(
                to_markdown(&[block(&[(input, false)])]),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn plain_text_is_kept_as_it_is_without_controls() {
        let out = to_text(&[
            block(&[("a <b> & ", false), ("c\nd\u{7}", true)]),
            block(&[("e", false)]),
        ]);
        assert_eq!(out, "a <b> & c d \n\ne\n");
        // A line or paragraph separator would be a line break for a reader of the file.
        let separated = [block(&[("x\u{2028}y\u{2029}z", false)])];
        assert_eq!(to_text(&separated), "x y z\n");
        assert_eq!(to_markdown(&separated), "x y z\n");
    }

    #[test]
    fn an_empty_list_gives_an_empty_document() {
        assert_eq!(to_text(&[]), "\n");
        assert_eq!(to_markdown(&[]), "\n");
        assert!(to_html(&[]).contains("<body>\n</body>"));
        // The command never writes an empty list.
        assert!(render(CitationFileFormat::Txt, &[], None).is_err());
    }

    #[test]
    fn ris_values_cannot_end_or_start_an_entry() {
        let record = BibRecord {
            title: Some("T\r\nER  - \r\nTY  - BOOK".to_owned()),
            authors: vec![Person {
                family: "Doe\nAU  - Evil".to_owned(),
                given: "J".to_owned(),
            }],
            pages: Some("12-15".to_owned()),
            accessed: Some("2024-05-06".to_owned()),
            ..BibRecord::default()
        };
        let ris = to_ris(&record);
        assert_eq!(ris.matches("ER  - ").count(), 1);
        assert!(ris.ends_with("ER  - \r\n"));
        for line in ris.split("\r\n").filter(|line| !line.is_empty()) {
            assert_eq!(&line[2..6], "  - ", "{line}");
        }
        assert!(ris.contains("TI  - T ER - TY - BOOK\r\n"));
        assert!(ris.contains("AU  - Doe AU - Evil, J\r\n"));
        assert!(ris.contains("SP  - 12\r\nEP  - 15\r\n"));
        assert!(ris.contains("Y2  - 2024/05/06/\r\n"));
        assert!(ris.starts_with("TY  - JOUR\r\n"));
    }

    #[test]
    fn bibtex_values_cannot_close_the_field_or_start_an_entry() {
        let record = BibRecord {
            title: Some("A} @article{evil, title = {x".to_owned()),
            authors: vec![
                Person {
                    family: "Smith and Jones".to_owned(),
                    given: "A".to_owned(),
                },
                Person {
                    family: "Org & Co".to_owned(),
                    given: String::new(),
                },
            ],
            doi: Some("10.1/a{b}\\c".to_owned()),
            year: Some("2020".to_owned()),
            ..BibRecord::default()
        };
        let bib = to_bibtex(&record);
        assert!(bib.starts_with("@article{SmithandJones2020,\n"));
        assert!(bib.contains("  title = {A @articleevil, title = x},\n"));
        assert!(bib.contains("author = {{Smith and Jones}, A and {Org \\& Co}},"));
        assert!(bib.contains("doi = {10.1/a%7Bb%7D%5Cc},"));
        // The entry is balanced and has one `@`.
        assert_eq!(bib.matches('{').count(), bib.matches('}').count());
        // The text stays inside its braces: only one line starts an entry.
        assert_eq!(bib.lines().filter(|line| line.starts_with('@')).count(), 1);
    }

    #[test]
    fn bibtex_keeps_nested_braces_and_escapes_specials() {
        assert_eq!(
            escape_bibtex("The {DNA} 100% $x_1$ #a ~ ^"),
            "The {DNA} 100\\% \\$x\\_1\\$ \\#a \\~{} \\^{}"
        );
        assert_eq!(escape_bibtex("a}b{"), "ab");
        assert_eq!(escape_bibtex("}{"), "");
        assert_eq!(escape_bibtex("a\\b"), "a\\textbackslash{}b");
        assert_eq!(escape_bibtex("l1\nl2\r\n"), "l1 l2");
    }

    #[test]
    fn bibtex_types_fields_and_pages() {
        let record = BibRecord {
            kind: BibKind::Chapter,
            title: Some("T".to_owned()),
            container_title: Some("Book".to_owned()),
            pages: Some("12\u{2013}15".to_owned()),
            publisher: Some("P".to_owned()),
            ..BibRecord::default()
        };
        let bib = to_bibtex(&record);
        assert!(bib.starts_with("@incollection{ref,\n"));
        assert!(bib.contains("booktitle = {Book},"));
        assert!(bib.contains("pages = {12--15},"));
        assert!(bib.contains("publisher = {P},"));
    }

    #[test]
    fn huge_input_is_refused_before_it_is_built() {
        let run = |text: String| StyledBlock {
            runs: vec![Run {
                text,
                italic: false,
            }],
        };
        let too_many = vec![run("a".to_owned()); limits::CITATION_EXPORT_BLOCKS_MAX + 1];
        assert!(check_blocks(&too_many).is_err());
        let exact = vec![run("a".to_owned()); limits::CITATION_EXPORT_BLOCKS_MAX];
        assert!(check_blocks(&exact).is_ok());
        assert!(check_blocks(&[run("a".repeat(limits::STYLED_RUN_CHARS_MAX + 1))]).is_err());
        let runs = StyledBlock {
            runs: vec![
                Run {
                    text: String::new(),
                    italic: false
                };
                limits::STYLED_RUNS_MAX + 1
            ],
        };
        assert!(check_blocks(&[runs]).is_err());
        // Together over 4 MiB, each block within its own caps.
        let big = vec![run("a".repeat(limits::STYLED_RUN_CHARS_MAX)); 1100];
        let error = render_blocks(CitationFileFormat::Txt, &big).unwrap_err();
        assert_eq!(error.code(), ErrorCode::TooLarge);
        // A record with huge fields is cut, never refused.
        let record = BibRecord {
            title: Some("x".repeat(10_000_000)),
            ..BibRecord::default()
        };
        assert!(to_ris(&record).len() < 10_000);
        assert!(to_bibtex(&record).len() < 10_000);
    }

    #[test]
    fn records_and_blocks_do_not_mix() {
        let record = BibRecord::default();
        let one = [block(&[("a", false)])];
        assert!(render(CitationFileFormat::Ris, &one, Some(&record)).is_err());
        assert!(render(CitationFileFormat::Bib, &[], None).is_err());
        assert!(render(CitationFileFormat::Bib, &[], Some(&record)).is_ok());
        assert!(render(CitationFileFormat::Html, &one, None).is_ok());
    }

    #[test]
    fn default_names() {
        assert_eq!(
            default_file_name("paper", CitationFileFormat::Md, CitationStyle::Apa7),
            "paper - citations (APA 7).md"
        );
        assert_eq!(
            default_file_name("paper", CitationFileFormat::Bib, CitationStyle::DinIso690),
            "paper - reference.bib"
        );
    }
}
