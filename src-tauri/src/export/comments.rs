//! Comment export (ADR-139 section 3 (3), ARCHITECTURE section 16.3): which annotations go into the summary, in what order, and the
//! Markdown form of it. The PDF form is `pdfwrite::summary`.
//!
//! Everything that reaches this module from a file (author, comment text, quote, tags) is hostile: control and bidi characters are
//! removed, texts are cut to `limits::COMMENT_EXPORT_TEXT_MAX`, and Markdown is escaped. A PDF string is never interpreted.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde::Deserialize;

use super::citations::{escape_block_start, escape_markdown};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;
use crate::menu::spec::{text as catalog_text, MenuLocale};
use crate::model::annotation::{Annotation, AnnotationBody, ReviewState, Rgb};
use crate::model::geometry::Quad;
use crate::model::ids::AnnotId;

// --- Options -----------------------------------------------------------------------------------------------------------

/// A type of annotation the export can take (`CommentExportOptions.include`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IncludeKind {
    /// Notes, text comments, and text markup that has a comment.
    Comments,
    /// Highlights, underlines and strikethroughs.
    Highlights,
    Citations,
    Stamps,
    /// Rectangles, ellipses and lines.
    Shapes,
    /// Freehand drawings.
    Drawings,
}

impl IncludeKind {
    pub const ALL: [IncludeKind; 6] = [
        Self::Comments,
        Self::Highlights,
        Self::Citations,
        Self::Stamps,
        Self::Shapes,
        Self::Drawings,
    ];

    /// The catalog key of the name of the type, for the "Filter: ..." part of the head.
    pub const fn label_key(self) -> &'static str {
        match self {
            Self::Comments => "annot.type.note",
            Self::Highlights => "annot.type.highlight",
            Self::Citations => "comments.group.citation",
            Self::Stamps => "annot.type.stamp",
            Self::Shapes => "comments.group.shape",
            Self::Drawings => "comments.group.drawing",
        }
    }
}

/// The review status the export takes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusFilter {
    #[default]
    All,
    Open,
    Resolved,
}

/// What the export takes (the page set is chosen by the caller).
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub include: Vec<IncludeKind>,
    /// `None` = every author; `""` stands for "no author".
    pub authors: Option<Vec<String>>,
    /// `None` = every tag; `""` stands for "no tag".
    pub tags: Option<Vec<String>>,
    pub status: StatusFilter,
    /// Without it (a file that forbids copying text) no quote is read or shown.
    pub allow_quotes: bool,
}

impl Filter {
    fn has(&self, kind: IncludeKind) -> bool {
        self.include.contains(&kind)
    }
}

// --- Items -------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Comment,
    Highlight,
    Underline,
    Strikeout,
    Citation,
    Stamp,
    Shape,
    Ink,
}

impl ItemKind {
    /// Text markup and citations: the kinds that have a quote and a colour swatch.
    pub const fn is_markup(self) -> bool {
        matches!(
            self,
            Self::Highlight | Self::Underline | Self::Strikeout | Self::Citation
        )
    }
}

/// One annotation of the export, with its replies.
#[derive(Debug, Clone, PartialEq)]
pub struct CommentItem {
    /// 1-based position of the page in the document.
    pub page_pos: u32,
    /// The page label, else the position.
    pub locator: String,
    pub kind: ItemKind,
    /// The catalog key of the type name (`annot.type.*`).
    pub type_key: &'static str,
    /// Extra text for the type line (the text of a stamp).
    pub detail: Option<String>,
    pub color: Rgb,
    /// Empty = no author.
    pub author: String,
    pub modified: Option<String>,
    pub quote: Option<String>,
    pub contents: String,
    /// The citation line in the current style (from the formatters of the UI), for citations.
    pub citation: Option<String>,
    pub tags: Vec<String>,
    pub state: Option<ReviewState>,
    pub replies: Vec<CommentItem>,
    /// The group a citation across pages shares.
    pub group: Option<String>,
    /// The annotation this item came from.
    pub id: AnnotId,
    /// The annotations merged into this item (the later parts of a citation across pages).
    pub merged: Vec<AnnotId>,
}

/// A page with its annotations, as the model has them.
#[derive(Debug, Clone)]
pub struct PageInput {
    pub page_id: PageId,
    /// 1-based.
    pub position: u32,
    pub locator: String,
    pub annotations: Vec<Annotation>,
}

/// The result of [`gather`].
#[derive(Debug, Clone, Default)]
pub struct Gathered {
    pub items: Vec<CommentItem>,
    /// A quote would have been shown but the file forbids copying text.
    pub quotes_omitted: bool,
}

// --- Texts -------------------------------------------------------------------------------------------------------------

/// Characters that never reach an export: bidi controls and invisible format characters (spoofing), and the line separators.
fn is_dropped(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

fn cut(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

/// A text of one line: white space collapsed, controls and format characters gone, at most `max` characters.
pub fn clean_line(text: &str, max: usize) -> String {
    let joined: String = text
        .chars()
        .filter(|c| !is_dropped(*c))
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    cut(joined.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// A text of paragraphs: line ends become `\n`, a tab a space, other controls and format characters go, at most one blank line in a
/// row, at most `max` characters.
pub fn clean_block(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max * 4));
    let mut chars = text.chars().peekable();
    let mut newlines = 0;
    while let Some(c) = chars.next() {
        let c = match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                '\n'
            }
            '\u{2028}' | '\u{2029}' => '\n',
            '\t' => ' ',
            c if is_dropped(c) => continue,
            c if c.is_control() && c != '\n' => ' ',
            c => c,
        };
        if c == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
        } else {
            newlines = 0;
        }
        out.push(c);
        // Far past the cap: the rest is cut anyway.
        if out.len() > max * 4 + 16 {
            break;
        }
    }
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    cut(lines.join("\n").trim().to_owned(), max)
}

// --- Dates -------------------------------------------------------------------------------------------------------------

/// The first 14 digits of a date text (ISO 8601 `2026-10-07T12:30:00Z` and PDF `D:20261007123000Z` both give `20261007123000`).
fn date_digits(text: &str) -> Vec<u32> {
    text.chars()
        .filter_map(|c| c.to_digit(10))
        .take(14)
        .collect()
}

fn number(digits: &[u32]) -> u32 {
    digits.iter().fold(0, |acc, d| acc * 10 + d)
}

/// A number that orders dates written either way; 0 for a text that is no date.
pub fn date_key(text: &str) -> u64 {
    let mut digits = date_digits(text);
    if digits.len() < 8 {
        return 0;
    }
    digits.resize(14, 0);
    digits.iter().fold(0u64, |acc, d| acc * 10 + u64::from(*d))
}

const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A date for people: `7 Oct 2026, 12:30` or `07.10.2026, 12:30` (the time left out when the text has none). The time is the one
/// the file says (UTC for what the app writes). `None` for a text that is no date.
pub fn format_date(text: &str, locale: MenuLocale) -> Option<String> {
    let digits = date_digits(text);
    if digits.len() < 8 {
        return None;
    }
    let (year, month, day) = (
        number(&digits[0..4]),
        number(&digits[4..6]),
        number(&digits[6..8]),
    );
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = (digits.len() >= 12).then(|| {
        let (hour, minute) = (number(&digits[8..10]), number(&digits[10..12]));
        (hour <= 23 && minute <= 59).then(|| format!("{hour:02}:{minute:02}"))
    });
    let time = time.flatten();
    let date = match locale {
        MenuLocale::De => format!("{day:02}.{month:02}.{year:04}"),
        MenuLocale::En => format!("{day} {} {year:04}", MONTHS_EN[month as usize - 1]),
    };
    Some(match time {
        Some(time) => format!("{date}, {time}"),
        None => date,
    })
}

// --- Labels ------------------------------------------------------------------------------------------------------------

/// The texts of the export, from the compiled-in UI catalogs (`commentExport.*`, `annot.type.*`, `comments.group.*`). A key the catalog
/// does not have yet falls back to the built-in text, never to the bare key.
#[derive(Debug, Clone, Copy)]
pub struct Labels {
    locale: MenuLocale,
}

impl Labels {
    /// `de` gives German, whatever else English.
    pub fn new(lang: &str) -> Self {
        Self {
            locale: MenuLocale::from_tag(lang),
        }
    }

    pub fn locale(self) -> MenuLocale {
        self.locale
    }

    fn builtin(self, key: &str) -> Option<&'static str> {
        let de = self.locale == MenuLocale::De;
        Some(match key {
            "commentExport.pdf.title" => {
                if de {
                    "Kommentare"
                } else {
                    "Comments"
                }
            }
            "commentExport.pdf.page" => {
                if de {
                    "Seite {n}"
                } else {
                    "Page {n}"
                }
            }
            "commentExport.pdf.pageLabel" => {
                if de {
                    "Seite {label} ({n})"
                } else {
                    "Page {label} ({n})"
                }
            }
            "commentExport.pdf.meta" => {
                if de {
                    "Exportiert am {date} \u{00B7} {count} Eintr\u{00E4}ge"
                } else {
                    "Exported {date} \u{00B7} {count} items"
                }
            }
            "commentExport.pdf.filtered" => "\u{00B7} Filter: {types}",
            "commentExport.pdf.foot" => {
                if de {
                    "{name} \u{00B7} Kommentare \u{00B7} {n} / {total}"
                } else {
                    "{name} \u{00B7} Comments \u{00B7} {n} / {total}"
                }
            }
            "commentExport.fileName" => {
                if de {
                    "{name} – Kommentare"
                } else {
                    "{name} – comments"
                }
            }
            "commentExport.noAuthor" => {
                if de {
                    "Ohne Person"
                } else {
                    "No author"
                }
            }
            "annot.type.comment" => {
                if de {
                    "Kommentar"
                } else {
                    "Comment"
                }
            }
            _ => return None,
        })
    }

    /// The text for `key`.
    pub fn get(self, key: &str) -> String {
        let found = catalog_text(self.locale, key, "");
        if found == key {
            self.builtin(key).map_or(found, str::to_owned)
        } else {
            found
        }
    }

    /// [`Labels::get`] with `{name}` places filled in (once each, left to right, so a value that says `{n}` stays as it is).
    pub fn fill(self, key: &str, values: &[(&str, &str)]) -> String {
        let template = self.get(key);
        let mut out = String::with_capacity(template.len() + 32);
        let mut rest = template.as_str();
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let tail = &rest[open..];
            let Some(close) = tail.find('}') else {
                out.push_str(tail);
                rest = "";
                break;
            };
            let name = &tail[1..close];
            match values.iter().find(|(key, _)| *key == name) {
                Some((_, value)) => out.push_str(value),
                None => out.push_str(&tail[..=close]),
            }
            rest = &tail[close + 1..];
        }
        out.push_str(rest);
        out
    }
}

/// The head of an export.
#[derive(Debug, Clone)]
pub struct Head {
    /// The document name: the title of the reference, else the file name.
    pub name: String,
    /// The export date, formatted.
    pub exported: String,
    /// The names of the included types, when not all are.
    pub filtered: Option<String>,
}

/// "Exported 7 Oct 2026 · 23 items · Filter: Notes, Highlights".
pub fn meta_line(items: &[CommentItem], head: &Head, labels: Labels) -> String {
    let count = items.len().to_string();
    let mut line = labels.fill(
        "commentExport.pdf.meta",
        &[("date", &head.exported), ("count", &count)],
    );
    if let Some(types) = &head.filtered {
        line.push(' ');
        line.push_str(&labels.fill("commentExport.pdf.filtered", &[("types", types)]));
    }
    line
}

/// "Page 12", or "Page xii (14)" when the label is not the number.
pub fn page_heading(item: &CommentItem, labels: Labels) -> String {
    let n = item.page_pos.to_string();
    if item.locator == n || item.locator.is_empty() {
        labels.fill("commentExport.pdf.page", &[("n", &n)])
    } else {
        labels.fill(
            "commentExport.pdf.pageLabel",
            &[("label", &item.locator), ("n", &n)],
        )
    }
}

/// The name of the type, with the text of a stamp.
pub fn type_label(item: &CommentItem, labels: Labels) -> String {
    let base = labels.get(item.type_key);
    match &item.detail {
        Some(detail) if !detail.is_empty() => format!("{base}: {detail}"),
        _ => base,
    }
}

/// The author, or "No author".
pub fn author_label(author: &str, labels: Labels) -> String {
    if author.is_empty() {
        labels.get("commentExport.noAuthor")
    } else {
        author.to_owned()
    }
}

// --- Gather ------------------------------------------------------------------------------------------------------------

fn classify(annotation: &Annotation, filter: &Filter) -> Option<(ItemKind, &'static str)> {
    let has_text = !annotation.contents.trim().is_empty();
    let markup = |kind: ItemKind, key: &'static str| {
        (filter.has(IncludeKind::Highlights) || (filter.has(IncludeKind::Comments) && has_text))
            .then_some((kind, key))
    };
    match &annotation.body {
        AnnotationBody::Highlight { .. } if annotation.cite.is_some() => filter
            .has(IncludeKind::Citations)
            .then_some((ItemKind::Citation, "comments.group.citation")),
        AnnotationBody::Highlight { .. } => markup(ItemKind::Highlight, "annot.type.highlight"),
        AnnotationBody::Underline { .. } => markup(ItemKind::Underline, "annot.type.underline"),
        AnnotationBody::Strikeout { .. } => markup(ItemKind::Strikeout, "annot.type.strikeout"),
        AnnotationBody::Note { .. } => filter
            .has(IncludeKind::Comments)
            .then_some((ItemKind::Comment, "annot.type.note")),
        AnnotationBody::FreeText { .. } => filter
            .has(IncludeKind::Comments)
            .then_some((ItemKind::Comment, "annot.type.freeText")),
        AnnotationBody::Stamp { .. } => filter
            .has(IncludeKind::Stamps)
            .then_some((ItemKind::Stamp, "annot.type.stamp")),
        AnnotationBody::Ink { .. } => filter
            .has(IncludeKind::Drawings)
            .then_some((ItemKind::Ink, "annot.type.ink")),
        AnnotationBody::Rect { .. } => filter
            .has(IncludeKind::Shapes)
            .then_some((ItemKind::Shape, "annot.type.rect")),
        AnnotationBody::Ellipse { .. } => filter
            .has(IncludeKind::Shapes)
            .then_some((ItemKind::Shape, "annot.type.ellipse")),
        AnnotationBody::Line { .. } => filter
            .has(IncludeKind::Shapes)
            .then_some((ItemKind::Shape, "annot.type.line")),
        // Signatures, marks, text boxes, images, redaction marks and what the model does not know: never exported.
        _ => None,
    }
}

fn status_matches(status: StatusFilter, state: Option<ReviewState>) -> bool {
    match status {
        StatusFilter::All => true,
        StatusFilter::Open => matches!(state, None | Some(ReviewState::None)),
        StatusFilter::Resolved => state == Some(ReviewState::Completed),
    }
}

/// The wanted tags in lower case, once per export (`""` stays: it stands for "no tag").
fn lowered(wanted: &Option<Vec<String>>) -> Option<Vec<String>> {
    wanted
        .as_ref()
        .map(|tags| tags.iter().map(|tag| tag.to_lowercase()).collect())
}

/// Whether an item with `tags` passes the tag filter; `wanted` comes from [`lowered`], each tag of the item is lowered once.
fn tags_match(wanted: &Option<Vec<String>>, tags: &[String]) -> bool {
    let Some(wanted) = wanted else {
        return true;
    };
    if tags.is_empty() {
        return wanted.iter().any(String::is_empty);
    }
    tags.iter().any(|tag| {
        let tag = tag.to_lowercase();
        wanted.iter().any(|want| !want.is_empty() && *want == tag)
    })
}

fn author_of(annotation: &Annotation) -> String {
    clean_line(
        annotation.author.as_deref().unwrap_or(""),
        limits::TAG_NAME_MAX * 3,
    )
}

fn base_item(
    page: &PageInput,
    annotation: &Annotation,
    kind: ItemKind,
    key: &'static str,
) -> CommentItem {
    CommentItem {
        page_pos: page.position,
        locator: clean_line(&page.locator, limits::PAGE_LABEL_MAX),
        kind,
        type_key: key,
        detail: None,
        color: annotation.color,
        author: author_of(annotation),
        modified: annotation
            .modified
            .as_deref()
            .map(|text| clean_line(text, 40))
            .filter(|text| !text.is_empty()),
        quote: None,
        contents: clean_block(&annotation.contents, limits::COMMENT_EXPORT_TEXT_MAX),
        citation: None,
        tags: annotation
            .tags
            .iter()
            .map(|tag| clean_line(tag, limits::TAG_NAME_MAX))
            .filter(|tag| !tag.is_empty())
            .collect(),
        state: None,
        replies: Vec::new(),
        group: None,
        id: annotation.id,
        merged: Vec::new(),
    }
}

/// The top-level annotation a reply belongs to (replies to replies belong to the top of the chain); `None` for a chain that is broken
/// or too long.
fn root_of(annotation: &Annotation, by_id: &HashMap<AnnotId, &Annotation>) -> Option<AnnotId> {
    let mut current = annotation;
    for _ in 0..8 {
        match current.in_reply_to {
            None => return Some(current.id),
            Some(parent) => current = by_id.get(&parent)?,
        }
    }
    None
}

/// The items of `pages` in order (page, then top to bottom, left to right), replies under their parent, a citation across pages as one
/// item. `quotes(page, quads)` answers the text under a text markup; it is called only when `filter.allow_quotes`.
pub fn gather(
    pages: &[PageInput],
    filter: &Filter,
    quotes: &mut dyn FnMut(PageId, &[Quad]) -> Option<String>,
) -> Result<Gathered, AppError> {
    let mut out = Gathered::default();
    let wanted_tags = lowered(&filter.tags);
    let mut count = 0usize;
    for page in pages {
        let mut order: Vec<&Annotation> = page
            .annotations
            .iter()
            .filter(|annotation| annotation.body.is_written_as_annotation())
            .collect();
        order.sort_by(|a, b| {
            a.rect
                .y
                .total_cmp(&b.rect.y)
                .then(a.rect.x.total_cmp(&b.rect.x))
                .then(a.id.cmp(&b.id))
        });
        let by_id: HashMap<AnnotId, &Annotation> = order.iter().map(|a| (a.id, *a)).collect();
        let mut replies: HashMap<AnnotId, Vec<&Annotation>> = HashMap::new();
        for annotation in order.iter().filter(|a| a.in_reply_to.is_some()) {
            if let Some(root) = root_of(annotation, &by_id) {
                replies.entry(root).or_default().push(annotation);
            }
        }
        for annotation in order.iter().filter(|a| a.in_reply_to.is_none()) {
            let Some((kind, key)) = classify(annotation, filter) else {
                continue;
            };
            let mut thread = replies.remove(&annotation.id).unwrap_or_default();
            thread
                .sort_by_key(|reply| (date_key(reply.modified.as_deref().unwrap_or("")), reply.id));
            let state = thread
                .iter()
                .rev()
                .find_map(|reply| reply.state)
                .or(annotation.state);
            let mut item = base_item(page, annotation, kind, key);
            if let Some(wanted) = &filter.authors {
                if !wanted.contains(&item.author) {
                    continue;
                }
            }
            if !tags_match(&wanted_tags, &item.tags) || !status_matches(filter.status, state) {
                continue;
            }
            item.state = state;
            match &annotation.body {
                AnnotationBody::Stamp { text, .. } => {
                    let text = clean_line(text, 200);
                    item.detail = (!text.is_empty()).then_some(text.clone());
                    // The stamp's own text is its contents: shown in the type line, not twice.
                    if item.contents == text {
                        item.contents.clear();
                    }
                }
                AnnotationBody::Highlight { quads }
                | AnnotationBody::Underline { quads }
                | AnnotationBody::Strikeout { quads } => {
                    if let Some(cite) = &annotation.cite {
                        item.group = cite.group.clone();
                        if filter.allow_quotes {
                            let quote = clean_block(&cite.quote, limits::CITE_QUOTE_MAX);
                            item.quote = (!quote.is_empty()).then_some(quote);
                        } else {
                            out.quotes_omitted = true;
                        }
                    } else if filter.allow_quotes {
                        item.quote = quotes(page.page_id, quads)
                            .map(|quote| clean_block(&quote, limits::CITE_QUOTE_MAX))
                            .filter(|quote| !quote.is_empty());
                    } else {
                        out.quotes_omitted = true;
                    }
                }
                _ => {}
            }
            for reply in thread {
                let text = clean_block(&reply.contents, limits::COMMENT_EXPORT_TEXT_MAX);
                if text.is_empty() {
                    continue;
                }
                let mut entry = base_item(page, reply, ItemKind::Comment, "annot.type.comment");
                entry.contents = text;
                item.replies.push(entry);
            }
            count += 1 + item.replies.len();
            if count > limits::COMMENT_EXPORT_ITEMS_MAX {
                return Err(AppError::limit(
                    "commentExport",
                    limits::COMMENT_EXPORT_ITEMS_MAX as u64,
                ));
            }
            out.items.push(item);
        }
    }
    merge_groups(&mut out.items);
    Ok(out)
}

/// A selection across pages is one citation per page with a shared group: one item on the first page, the quotes joined, the locator
/// "first-last".
fn merge_groups(items: &mut Vec<CommentItem>) {
    let mut first: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<CommentItem> = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        let Some(group) = item
            .group
            .clone()
            .filter(|_| item.kind == ItemKind::Citation)
        else {
            merged.push(item);
            continue;
        };
        match first.get(&group) {
            None => {
                first.insert(group, merged.len());
                merged.push(item);
            }
            Some(&at) => {
                let head = &mut merged[at];
                if let Some(quote) = item.quote {
                    head.quote = Some(match head.quote.take() {
                        Some(before) => format!("{before} \u{2026} {quote}"),
                        None => quote,
                    });
                }
                if !item.locator.is_empty() && !head.locator.ends_with(&item.locator) {
                    let start = head
                        .locator
                        .split('\u{2013}')
                        .next()
                        .unwrap_or("")
                        .to_owned();
                    head.locator = format!("{start}\u{2013}{}", item.locator);
                }
                for tag in item.tags {
                    if !head.tags.contains(&tag) {
                        head.tags.push(tag);
                    }
                }
                if head.contents.is_empty() {
                    head.contents = item.contents;
                }
                head.merged.push(item.id);
                head.replies.extend(item.replies);
            }
        }
    }
    *items = merged;
}

/// Sets the citation lines (`id` = any annotation of the citation, or of the group it was merged into).
pub fn apply_citation_lines(items: &mut [CommentItem], lines: &[(AnnotId, String)]) {
    let by_id: HashMap<AnnotId, &str> = lines
        .iter()
        .map(|(id, text)| (*id, text.as_str()))
        .collect();
    for item in items.iter_mut().filter(|i| i.kind == ItemKind::Citation) {
        let line = std::iter::once(&item.id)
            .chain(item.merged.iter())
            .find_map(|id| by_id.get(id));
        item.citation = line
            .map(|line| clean_block(line, limits::COMMENT_EXPORT_TEXT_MAX))
            .filter(|line| !line.is_empty());
    }
}

// --- Markdown ----------------------------------------------------------------------------------------------------------

/// Paragraphs of untrusted text as Markdown: every line escaped, a single line break a hard break.
fn md_paragraphs(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = String::with_capacity(text.len() + 16);
    for (index, line) in lines.iter().enumerate() {
        out.push_str(&escape_block_start(escape_markdown(line)));
        if let Some(next) = lines.get(index + 1) {
            if line.is_empty() || next.is_empty() {
                out.push('\n');
            } else {
                out.push_str("  \n");
            }
        }
    }
    out
}

/// A quote as a block quote: every line prefixed with "> ".
fn md_quote(text: &str) -> String {
    text.split('\n')
        .map(|line| format!("> {}", escape_markdown(line)).trim_end().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

fn item_heading(item: &CommentItem, labels: Labels) -> String {
    let mut parts = vec![type_label(item, labels), author_label(&item.author, labels)];
    if let Some(date) = item
        .modified
        .as_deref()
        .and_then(|text| format_date(text, labels.locale()))
    {
        parts.push(date);
    }
    parts
        .iter()
        .map(|part| escape_markdown(part))
        .collect::<Vec<_>>()
        .join(" \u{00B7} ")
}

/// The Markdown file (DESIGN 3.16 E6). Over `COMMENT_EXPORT_MD_MAX` bytes it is `limit_exceeded`.
pub fn to_markdown(items: &[CommentItem], head: &Head, labels: Labels) -> Result<String, AppError> {
    let mut blocks: Vec<String> = Vec::new();
    blocks.push(format!(
        "# {}: {}",
        escape_markdown(&labels.get("commentExport.pdf.title")),
        escape_markdown(&head.name)
    ));
    blocks.push(escape_markdown(&meta_line(items, head, labels)));
    let mut page: Option<u32> = None;
    for item in items {
        if page != Some(item.page_pos) {
            page = Some(item.page_pos);
            blocks.push(format!(
                "## {}",
                escape_markdown(&page_heading(item, labels))
            ));
        }
        blocks.push(format!("### {}", item_heading(item, labels)));
        if let Some(quote) = &item.quote {
            blocks.push(md_quote(quote));
        }
        if let Some(line) = &item.citation {
            blocks.push(md_paragraphs(line));
        }
        if !item.contents.is_empty() {
            blocks.push(md_paragraphs(&item.contents));
        }
        if !item.replies.is_empty() {
            let mut list = String::new();
            for reply in &item.replies {
                if !list.is_empty() {
                    list.push('\n');
                }
                let date = reply
                    .modified
                    .as_deref()
                    .and_then(|text| format_date(text, labels.locale()));
                let _ = write!(
                    list,
                    "- **{}**{}: {}",
                    escape_markdown(&author_label(&reply.author, labels)),
                    date.map_or_else(String::new, |d| format!(
                        " \u{00B7} {}",
                        escape_markdown(&d)
                    )),
                    md_paragraphs(&reply.contents).replace('\n', "\n  ")
                );
            }
            blocks.push(list);
        }
    }
    let mut out = blocks.join("\n\n");
    out.push('\n');
    if out.len() > limits::COMMENT_EXPORT_MD_MAX {
        return Err(AppError::limit(
            "commentExport",
            limits::COMMENT_EXPORT_MD_MAX as u64,
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn annotation(value: serde_json::Value) -> Annotation {
        let mut base = json!({
            "id": 1, "pageId": 0, "rect": {"x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0},
            "color": [255, 248, 77], "opacity": 1.0, "contents": "", "author": null, "modified": null,
            "inReplyTo": null, "locked": false, "sync": "clean"
        });
        for (key, v) in value.as_object().unwrap() {
            base[key] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn quad(x: f32) -> serde_json::Value {
        json!([{"x": x, "y": 0.0}, {"x": x + 5.0, "y": 0.0}, {"x": x, "y": 5.0}, {"x": x + 5.0, "y": 5.0}])
    }

    fn page(position: u32, locator: &str, annotations: Vec<Annotation>) -> PageInput {
        PageInput {
            page_id: PageId::new(position - 1),
            position,
            locator: locator.to_owned(),
            annotations,
        }
    }

    fn everything() -> Filter {
        Filter {
            include: IncludeKind::ALL.to_vec(),
            allow_quotes: true,
            ..Filter::default()
        }
    }

    fn no_quotes(_: PageId, _: &[Quad]) -> Option<String> {
        None
    }

    #[test]
    fn dates_read_iso_and_pdf_forms() {
        assert_eq!(
            format_date("2026-10-07T12:30:00Z", MenuLocale::En).as_deref(),
            Some("7 Oct 2026, 12:30")
        );
        assert_eq!(
            format_date("D:20261007123000+02'00'", MenuLocale::De).as_deref(),
            Some("07.10.2026, 12:30")
        );
        assert_eq!(
            format_date("2026-10-07", MenuLocale::En).as_deref(),
            Some("7 Oct 2026")
        );
        assert_eq!(format_date("yesterday", MenuLocale::En), None);
        assert_eq!(format_date("2026-13-07", MenuLocale::En), None);
        assert!(date_key("2026-10-07T12:30:00Z") == date_key("D:20261007123000Z"));
        assert!(date_key("2026-10-08") > date_key("2026-10-07T23:59:59Z"));
        assert_eq!(date_key("x"), 0);
    }

    #[test]
    fn hostile_text_loses_controls_and_bidi_marks_and_is_cut() {
        assert_eq!(clean_line("a\u{202E}b\u{0}\tc\r\nd", 50), "ab c d");
        assert_eq!(
            clean_block("a\r\nb\r\n\r\n\r\n\r\nc\u{7}d\te", 50),
            "a\nb\n\nc d e"
        );
        let cut = clean_block(&"x".repeat(20_000), limits::COMMENT_EXPORT_TEXT_MAX);
        assert_eq!(cut.chars().count(), limits::COMMENT_EXPORT_TEXT_MAX);
        assert!(cut.ends_with('\u{2026}'));
    }

    #[test]
    fn items_come_in_page_order_top_to_bottom_with_replies_and_state() {
        let note = |id: u32, y: f32, text: &str| {
            annotation(
                json!({"id": id, "kind": "note", "at": {"x": 0.0, "y": y}, "icon": "note",
                "rect": {"x": 0.0, "y": y, "w": 10.0, "h": 10.0}, "contents": text, "author": "Ann", "modified": "2026-10-07T10:00:00Z"}),
            )
        };
        let reply = |id: u32, parent: u32, text: &str, when: &str, state: Option<&str>| {
            let mut value = json!({"id": id, "kind": "note", "at": {"x": 0.0, "y": 0.0}, "icon": "note",
                "contents": text, "author": "Bob", "modified": when, "inReplyTo": parent});
            if let Some(state) = state {
                value["state"] = json!(state);
            }
            annotation(value)
        };
        let pages = [
            page(
                2,
                "ii",
                vec![
                    note(1, 50.0, "lower"),
                    note(2, 10.0, "upper"),
                    reply(3, 2, "late", "2026-10-09T10:00:00Z", None),
                    reply(4, 2, "early", "2026-10-08T10:00:00Z", None),
                    reply(5, 2, "", "2026-10-10T10:00:00Z", Some("completed")),
                    reply(6, 3, "nested", "2026-10-11T10:00:00Z", None),
                ],
            ),
            page(3, "3", vec![note(7, 0.0, "next page")]),
        ];
        let got = gather(&pages, &everything(), &mut no_quotes).unwrap();
        let texts: Vec<_> = got.items.iter().map(|i| i.contents.as_str()).collect();
        assert_eq!(texts, ["upper", "lower", "next page"]);
        let replies: Vec<_> = got.items[0]
            .replies
            .iter()
            .map(|r| r.contents.as_str())
            .collect();
        assert_eq!(replies, ["early", "late", "nested"]);
        assert_eq!(got.items[0].state, Some(ReviewState::Completed));
        assert_eq!(got.items[0].locator, "ii");
        // Status filter.
        let mut open = everything();
        open.status = StatusFilter::Open;
        let got = gather(&pages, &open, &mut no_quotes).unwrap();
        assert_eq!(got.items.len(), 2);
        let mut resolved = everything();
        resolved.status = StatusFilter::Resolved;
        let got = gather(&pages, &resolved, &mut no_quotes).unwrap();
        assert_eq!(got.items.len(), 1);
    }

    #[test]
    fn types_authors_and_tags_filter_and_signatures_never_go() {
        let pages = [page(
            1,
            "1",
            vec![
                annotation(
                    json!({"id": 1, "kind": "highlight", "quads": [quad(0.0)], "contents": "", "author": "Ann", "tags": ["Todo"]}),
                ),
                annotation(json!({"id": 2, "kind": "ink", "strokes": [], "width": 1.0})),
                annotation(
                    json!({"id": 3, "kind": "rect", "box": {"x": 0.0, "y": 20.0, "w": 5.0, "h": 5.0}, "width": 1.0, "fill": null, "dashed": false}),
                ),
                annotation(
                    json!({"id": 4, "kind": "signature", "box": {"x": 0.0, "y": 30.0, "w": 5.0, "h": 5.0}, "role": "signature",
                    "art": {"type": "file"}, "angle": 0.0}),
                ),
                annotation(
                    json!({"id": 5, "kind": "stamp", "box": {"x": 0.0, "y": 40.0, "w": 5.0, "h": 5.0}, "stamp": "approved",
                    "text": "Approved", "date": null, "tone": "ink", "contents": "Approved"}),
                ),
                annotation(
                    json!({"id": 6, "kind": "underline", "quads": [quad(10.0)], "contents": "why", "author": "Bob"}),
                ),
            ],
        )];
        let mut quotes = |_: PageId, quads: &[Quad]| Some(format!("quoted {}", quads[0][0].x));
        let all = gather(&pages, &everything(), &mut quotes).unwrap();
        let kinds: Vec<_> = all.items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            [
                ItemKind::Highlight,
                ItemKind::Ink,
                ItemKind::Shape,
                ItemKind::Stamp,
                ItemKind::Underline
            ]
        );
        assert_eq!(all.items[0].quote.as_deref(), Some("quoted 0"));
        assert_eq!(all.items[3].detail.as_deref(), Some("Approved"));
        assert!(
            all.items[3].contents.is_empty(),
            "the stamp text is not shown twice"
        );
        // Only comments: the underline has text, the highlight has none.
        let only = Filter {
            include: vec![IncludeKind::Comments],
            allow_quotes: true,
            ..Filter::default()
        };
        let got = gather(&pages, &only, &mut quotes).unwrap();
        assert_eq!(got.items.len(), 1);
        assert_eq!(got.items[0].kind, ItemKind::Underline);
        // Author "Bob" and the empty author.
        let mut by_author = everything();
        by_author.authors = Some(vec!["Bob".into()]);
        assert_eq!(
            gather(&pages, &by_author, &mut quotes).unwrap().items.len(),
            1
        );
        by_author.authors = Some(vec![String::new()]);
        assert_eq!(
            gather(&pages, &by_author, &mut quotes).unwrap().items.len(),
            3
        );
        // Tags, case-insensitive; "" is untagged.
        let mut by_tag = everything();
        by_tag.tags = Some(vec!["todo".into()]);
        assert_eq!(gather(&pages, &by_tag, &mut quotes).unwrap().items.len(), 1);
        by_tag.tags = Some(vec![String::new()]);
        assert_eq!(gather(&pages, &by_tag, &mut quotes).unwrap().items.len(), 4);
    }

    #[test]
    fn without_the_copy_permission_no_quote_is_read_and_the_loss_is_reported() {
        let pages = [page(
            1,
            "1",
            vec![
                annotation(
                    json!({"id": 1, "kind": "highlight", "quads": [quad(0.0)], "cite": {"quote": "stored"}}),
                ),
                annotation(json!({"id": 2, "kind": "underline", "quads": [quad(9.0)], "y": 0})),
            ],
        )];
        let mut called = false;
        let mut quotes = |_: PageId, _: &[Quad]| {
            called = true;
            Some("text".to_owned())
        };
        let mut filter = everything();
        filter.allow_quotes = false;
        let got = gather(&pages, &filter, &mut quotes).unwrap();
        assert!(got.quotes_omitted && got.items.len() == 2);
        assert!(got.items.iter().all(|i| i.quote.is_none()));
        assert!(!called);
        let got = gather(&pages, &everything(), &mut |_, _| Some("text".into())).unwrap();
        assert!(!got.quotes_omitted);
        assert_eq!(got.items[0].quote.as_deref(), Some("stored"));
        assert_eq!(got.items[1].quote.as_deref(), Some("text"));
    }

    #[test]
    fn a_citation_across_pages_is_one_item_with_joined_locator_and_quote() {
        let cite = |id: u32, quote: &str| {
            annotation(
                json!({"id": id, "kind": "highlight", "quads": [quad(0.0)], "cite": {"quote": quote, "group": "ab12cd34"}}),
            )
        };
        let pages = [
            page(12, "12", vec![cite(1, "one")]),
            page(13, "13", vec![cite(2, "two")]),
        ];
        let mut got = gather(&pages, &everything(), &mut no_quotes).unwrap();
        assert_eq!(got.items.len(), 1);
        assert_eq!(got.items[0].locator, "12\u{2013}13");
        assert_eq!(got.items[0].quote.as_deref(), Some("one \u{2026} two"));
        apply_citation_lines(
            &mut got.items,
            &[(AnnotId::new(2), "Müller, S. 12–13.".to_owned())],
        );
        assert_eq!(got.items[0].citation.as_deref(), Some("Müller, S. 12–13."));
    }

    #[test]
    fn too_many_items_are_refused() {
        let many: Vec<Annotation> = (0..=limits::COMMENT_EXPORT_ITEMS_MAX as u32)
            .map(|id| annotation(json!({"id": id, "kind": "note", "at": {"x": 0.0, "y": 0.0}, "icon": "note", "contents": "x"})))
            .collect();
        let error = gather(&[page(1, "1", many)], &everything(), &mut no_quotes).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::LimitExceeded);
    }

    fn head() -> Head {
        Head {
            name: "My *Paper*".to_owned(),
            exported: "7 Oct 2026".to_owned(),
            filtered: Some("Note, Highlight".to_owned()),
        }
    }

    #[test]
    fn markdown_follows_the_template_and_escapes_hostile_text() {
        let pages = [
            page(
                2,
                "ii",
                vec![
                    annotation(
                        json!({"id": 1, "kind": "highlight", "quads": [quad(0.0)], "contents": "# <script>alert(1)</script>\n\n- item\nsecond",
                        "author": "A*n", "modified": "2026-10-07T10:00:00Z"}),
                    ),
                    annotation(
                        json!({"id": 2, "kind": "note", "at": {"x": 0.0, "y": 0.0}, "icon": "note", "rect": {"x": 0.0, "y": 5.0, "w": 1.0, "h": 1.0},
                        "contents": "n"}),
                    ),
                    annotation(
                        json!({"id": 3, "kind": "note", "at": {"x": 0.0, "y": 0.0}, "icon": "note", "contents": "re *ply*",
                        "author": "Bob", "modified": "2026-10-08T10:00:00Z", "inReplyTo": 1}),
                    ),
                ],
            ),
            page(
                3,
                "3",
                vec![annotation(
                    json!({"id": 4, "kind": "ink", "strokes": [], "width": 1.0}),
                )],
            ),
        ];
        let mut quotes = |_: PageId, _: &[Quad]| Some("line one\n# two".to_owned());
        let got = gather(&pages, &everything(), &mut quotes).unwrap();
        let md = to_markdown(&got.items, &head(), Labels::new("en")).unwrap();
        let expected = "\
# Comments: My \\*Paper\\*

Exported 7 Oct 2026 \u{00B7} 3 items \u{00B7} Filter: Note, Highlight

## Page ii \\(2\\)

### Highlight \u{00B7} A\\*n \u{00B7} 7 Oct 2026, 10:00

> line one
> \\# two

\\# \\<script\\>alert\\(1\\)\\</script\\>

\\- item
second

- **Bob** \u{00B7} 8 Oct 2026, 10:00: re \\*ply\\*

### Note \u{00B7} No author

n

## Page 3

### Drawing \u{00B7} No author
";
        // The filter text is escaped like any text ("Note, Highlight" has nothing to escape).
        let expected = expected.replace(
            "\\- item
second",
            "\\- item  
second",
        );
        assert_eq!(md, expected);
        assert!(!md.contains("<script>"));
        assert!(!md.contains('\r'));
        let de = to_markdown(&got.items, &head(), Labels::new("de")).unwrap();
        assert!(de.starts_with("# Kommentare: "));
        assert!(de.contains("## Seite ii \\(2\\)") && de.contains("Ohne Person"));
        assert!(de.contains("07.10.2026, 10:00"));
    }

    #[test]
    fn a_hostile_reply_cannot_inject_structure() {
        let mut item = CommentItem {
            page_pos: 1,
            locator: "1".into(),
            kind: ItemKind::Comment,
            type_key: "annot.type.note",
            detail: None,
            color: Rgb([0, 0, 0]),
            author: String::new(),
            modified: None,
            quote: None,
            contents: "c".into(),
            citation: None,
            tags: Vec::new(),
            state: None,
            replies: Vec::new(),
            group: None,
            id: AnnotId::new(1),
            merged: Vec::new(),
        };
        let mut reply = item.clone();
        reply.author = "Bob".into();
        reply.contents = "hi
- x
1. y
> q
# h"
        .into();
        item.replies.push(reply);
        let md = to_markdown(&[item], &head(), Labels::new("en")).unwrap();
        assert!(
            md.contains("- **Bob**: hi  \n  \\- x  \n  1\\. y  \n  \\> q  \n  \\# h\n"),
            "{md}"
        );
    }

    #[test]
    fn markdown_over_the_cap_is_refused() {
        let item = |n: u32| CommentItem {
            page_pos: n,
            locator: n.to_string(),
            kind: ItemKind::Comment,
            type_key: "annot.type.note",
            detail: None,
            color: Rgb([0, 0, 0]),
            author: String::new(),
            modified: None,
            quote: None,
            contents: "x".repeat(limits::COMMENT_EXPORT_TEXT_MAX),
            citation: None,
            tags: Vec::new(),
            state: None,
            replies: Vec::new(),
            group: None,
            id: AnnotId::new(n),
            merged: Vec::new(),
        };
        let items: Vec<_> = (1..=2_200).map(item).collect();
        let error = to_markdown(&items, &head(), Labels::new("en")).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::LimitExceeded);
    }

    #[test]
    fn labels_fill_each_place_once_and_fall_back_to_built_in_text() {
        let labels = Labels::new("en");
        assert_eq!(
            labels.fill("commentExport.pdf.page", &[("n", "{n}")]),
            "Page {n}"
        );
        assert_eq!(labels.get("annot.type.highlight"), "Highlight");
        assert_eq!(
            Labels::new("de-AT").get("annot.type.highlight"),
            "Hervorhebung"
        );
        assert_eq!(labels.get("no.such.key"), "no.such.key");
    }
}
