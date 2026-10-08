//! Headers and footers (ADR-139 Addendum A2, ARCHITECTURE §16.2): the spec the user edits, the pure resolution of its tokens into
//! placed text runs (the one function the preview and the save both use), and the model state with its exact inverse.
//!
//! The spec has six slots (header and footer, left, centre, right), each a short text that may hold the tokens `{page}`, `{total}`,
//! `{date}` and `{file}`. It is written at save as a marked `/Artifact` stream per page (`pdfwrite::header_footer`); until then it is a
//! pending change of the model, one undo step.

use serde::{Deserialize, Serialize};

use super::annotation::{Rgb, StdFont};
use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState};
use super::geometry::Point;
use super::page_ops::{PagePlan, PlanPage};
use crate::content::std14;
use crate::error::AppError;
use crate::pdfwrite::page_layer::PageGeom;

/// Longest text of one slot (characters).
pub const SLOT_CHARS_MAX: usize = 256;
/// Longest `{date}` text (characters).
pub const DATE_CHARS_MAX: usize = 32;
/// Longest page range text (characters).
pub const RANGES_CHARS_MAX: usize = 256;
/// The distance from the top of the text to its baseline, and from the baseline to its bottom, in em (Helvetica ascender, descender).
const ASCENT: f32 = 0.72;
const DESCENT: f32 = 0.21;

/// The texts of the six places; `""` is none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct HfSlots {
    pub header_left: String,
    pub header_center: String,
    pub header_right: String,
    pub footer_left: String,
    pub footer_center: String,
    pub footer_right: String,
}

impl HfSlots {
    fn all(&self) -> [&String; 6] {
        [
            &self.header_left,
            &self.header_center,
            &self.header_right,
            &self.footer_left,
            &self.footer_center,
            &self.footer_right,
        ]
    }
}

/// The pages that get the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HfPages {
    All,
    /// "1-3, 5, 8-": positions in the order of the saved file.
    Ranges {
        text: String,
    },
}

/// What the user chose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct HfSpec {
    pub slots: HfSlots,
    pub pages: HfPages,
    /// Points, 6..=24.
    pub font_size: f32,
    /// Points from the shown edge, 12..=72.
    pub margin: f32,
    pub color: Rgb,
    /// What `{date}` is, formatted by the UI when the dialog applies.
    pub date: String,
}

impl Default for HfSpec {
    /// The spec a new dialog starts from: the date on the left of the footer, the page number on the right.
    fn default() -> Self {
        Self {
            slots: HfSlots {
                footer_left: "{date}".into(),
                footer_right: "{page}".into(),
                ..HfSlots::default()
            },
            pages: HfPages::All,
            font_size: 9.0,
            margin: 28.0,
            color: Rgb([0x0F, 0x0F, 0x0F]),
            date: String::new(),
        }
    }
}

/// One piece of a slot text.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    Lit(String),
    Page,
    Total,
    Date,
    File,
}

/// Splits a slot text at its tokens; `{{` and `}}` are braces, any other `{...}` is literal text.
fn segments(template: &str) -> Vec<Seg> {
    let chars: Vec<char> = template.chars().collect();
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    while i < chars.len() {
        let rest = &chars[i..];
        let starts = |word: &str| {
            let w: Vec<char> = word.chars().collect();
            rest.len() >= w.len() && rest[..w.len()] == w[..]
        };
        let token = [
            ("{page}", Seg::Page),
            ("{total}", Seg::Total),
            ("{date}", Seg::Date),
            ("{file}", Seg::File),
        ]
        .into_iter()
        .find(|(word, _)| starts(word));
        if let Some((word, seg)) = token {
            if !lit.is_empty() {
                out.push(Seg::Lit(std::mem::take(&mut lit)));
            }
            out.push(seg);
            i += word.len();
        } else if starts("{{") {
            lit.push('{');
            i += 2;
        } else if starts("}}") {
            lit.push('}');
            i += 2;
        } else {
            lit.push(chars[i]);
            i += 1;
        }
    }
    if !lit.is_empty() {
        out.push(Seg::Lit(lit));
    }
    out
}

fn bad_char(text: &str) -> Result<(), AppError> {
    match text
        .chars()
        .find(|c| c.is_control() || std14::winansi(*c).is_none())
    {
        Some(c) => Err(AppError::bad_char_for("headerFooter", c)),
        None => Ok(()),
    }
}

impl HfSpec {
    /// No slot has text: nothing would be written.
    pub fn is_empty(&self) -> bool {
        self.slots.all().iter().all(|s| s.is_empty())
    }

    /// Checks the sizes and characters of what arrived from the UI or from a file. With the page count the range text is parsed
    /// against it (`invalid_argument` `ranges`); without it only its length is checked.
    pub fn check(&self, page_count: Option<u32>) -> Result<(), AppError> {
        if !self.font_size.is_finite() || !(6.0..=24.0).contains(&self.font_size) {
            return Err(AppError::invalid("fontSize"));
        }
        if !self.margin.is_finite() || !(12.0..=72.0).contains(&self.margin) {
            return Err(AppError::invalid("margin"));
        }
        if self.date.chars().count() > DATE_CHARS_MAX {
            return Err(AppError::limit("headerFooter", DATE_CHARS_MAX as u64));
        }
        bad_char(&self.date)?;
        for slot in self.slots.all() {
            if slot.chars().count() > SLOT_CHARS_MAX {
                return Err(AppError::limit("headerFooter", SLOT_CHARS_MAX as u64));
            }
            for seg in segments(slot) {
                if let Seg::Lit(text) = seg {
                    bad_char(&text)?;
                }
            }
        }
        if let HfPages::Ranges { text } = &self.pages {
            if text.chars().count() > RANGES_CHARS_MAX {
                return Err(AppError::limit("ranges", RANGES_CHARS_MAX as u64));
            }
            if let Some(count) = page_count {
                super::ranges::parse_ranges(text, count)?;
            }
        }
        Ok(())
    }

    /// Whether the page at `position` (0-based) of `total` pages is in the range. A range that no longer fits the page count (pages
    /// were deleted since the dialog) is clamped, never an error at save time.
    pub fn covers(&self, position: u32, total: u32) -> bool {
        let HfPages::Ranges { text } = &self.pages else {
            return true;
        };
        let page = position + 1;
        if page > total {
            return false;
        }
        // The grammar is the one `check` enforces (`ranges::parse_ranges`); only the page count is not: a range past the end (pages were
        // deleted since the dialog) is clamped, and a text the grammar refuses covers nothing.
        super::ranges::parse_ranges(text, u32::MAX)
            .is_ok_and(|ranges| ranges.iter().any(|&(from, to)| from <= page && page <= to))
    }
}

/// One line of text at its place on one page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedRun {
    pub text: String,
    /// The start of the baseline in page space (ADR-003: top left of the unrotated crop box, y down).
    pub origin: Point,
    /// Degrees clockwise the text is turned in page space so that it reads upright on the displayed page (the page's `/Rotate`).
    pub angle: u16,
    pub size: f32,
    pub width: f32,
}

/// `file` with every character WinAnsi cannot show replaced by `?`.
fn winansi_only(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || std14::winansi(c).is_none() {
                '?'
            } else {
                c
            }
        })
        .collect()
}

/// Which slot is where on the displayed page.
#[derive(Clone, Copy)]
enum Edge {
    Top,
    Bottom,
}

#[derive(Clone, Copy)]
enum Side {
    Left,
    Center,
    Right,
}

/// The runs of one page: pure, no I/O. `position` is 0-based, `total` the page count, `file` the display name without `.pdf`.
/// A page outside the range, and a slot whose text is empty after the tokens, give no run.
pub fn resolve(
    spec: &HfSpec,
    geom: PageGeom,
    position: u32,
    total: u32,
    file: &str,
) -> Vec<PlacedRun> {
    if !spec.covers(position, total) {
        return Vec::new();
    }
    let (w, h) = geom.display_size();
    let size = spec.font_size;
    let slots = [
        (&spec.slots.header_left, Edge::Top, Side::Left),
        (&spec.slots.header_center, Edge::Top, Side::Center),
        (&spec.slots.header_right, Edge::Top, Side::Right),
        (&spec.slots.footer_left, Edge::Bottom, Side::Left),
        (&spec.slots.footer_center, Edge::Bottom, Side::Center),
        (&spec.slots.footer_right, Edge::Bottom, Side::Right),
    ];
    let file = winansi_only(file);
    // The text of each slot, then the three of one edge fitted to each other (narrow pages).
    let texts: Vec<String> = slots
        .iter()
        .map(|(template, ..)| {
            let text: String = segments(template)
                .into_iter()
                .map(|seg| match seg {
                    Seg::Lit(text) => text,
                    Seg::Page => (position + 1).to_string(),
                    Seg::Total => total.to_string(),
                    Seg::Date => spec.date.clone(),
                    Seg::File => file.clone(),
                })
                .collect();
            text.trim().to_owned()
        })
        .collect();
    let mut runs = Vec::new();
    for (edge_slots, edge_texts) in slots.chunks(3).zip(texts.chunks(3)) {
        let fitted = fit_edge(
            [
                edge_texts[0].clone(),
                edge_texts[1].clone(),
                edge_texts[2].clone(),
            ],
            w,
            spec.margin,
            size,
        );
        for ((_, edge, side), text) in edge_slots.iter().zip(fitted) {
            if text.is_empty() {
                continue;
            }
            let width = std14::text_width(StdFont::Sans, &text, size);
            let dx = match side {
                Side::Left => spec.margin,
                Side::Center => (w - width) / 2.0,
                Side::Right => w - spec.margin - width,
            }
            .max(0.0);
            let dy = match edge {
                Edge::Top => spec.margin + ASCENT * size,
                Edge::Bottom => h - spec.margin - DESCENT * size,
            };
            let (x, y) = geom.display_to_page(dx, dy);
            runs.push(PlacedRun {
                text,
                origin: Point { x, y },
                angle: geom.rotate % 360,
                size,
                width,
            });
        }
    }
    runs
}

/// `text` cut from the end, with an ellipsis, until it is at most `limit` points wide; empty if not even the ellipsis fits.
fn fit_text(text: &str, limit: f32, size: f32) -> String {
    let width = |t: &str| std14::text_width(StdFont::Sans, t, size);
    if text.is_empty() || width(text) <= limit {
        return text.to_owned();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while chars.pop().is_some() {
        let mut cut: String = chars.iter().collect();
        cut = cut.trim_end().to_owned();
        cut.push('\u{2026}');
        if width(&cut) <= limit {
            return cut;
        }
    }
    String::new()
}

/// The left, centre and right text of one edge on a page `w` wide, so that they cannot overlap or leave the margins: when left and right
/// together are too wide, the shorter one keeps its text and the longer is cut (both when both are long, half each); the centre then
/// gets what is left around the middle of the page. A gap of one em stays between neighbours. Deterministic, no reflow.
fn fit_edge(
    [mut left, mut centre, mut right]: [String; 3],
    w: f32,
    margin: f32,
    size: f32,
) -> [String; 3] {
    let width = |t: &str| std14::text_width(StdFont::Sans, t, size);
    let avail = (w - 2.0 * margin).max(0.0);
    let gap = size;
    let (wl, wr) = (width(&left), width(&right));
    let both = !left.is_empty() && !right.is_empty();
    let g = if both { gap } else { 0.0 };
    if wl + wr + g > avail {
        let half = ((avail - g) / 2.0).max(0.0);
        let (limit_left, limit_right) = if !both {
            (avail, avail)
        } else if wl <= half {
            (wl, avail - g - wl)
        } else if wr <= half {
            (avail - g - wr, wr)
        } else {
            (half, half)
        };
        left = fit_text(&left, limit_left, size);
        right = fit_text(&right, limit_right, size);
    }
    let left_end = if left.is_empty() {
        margin
    } else {
        margin + width(&left) + gap
    };
    let right_start = if right.is_empty() {
        w - margin
    } else {
        w - margin - width(&right) - gap
    };
    let room = (w / 2.0 - left_end).min(right_start - w / 2.0).max(0.0);
    centre = fit_text(&centre, 2.0 * room, size);
    [left, centre, right]
}

/// What the session has: the spec of the file, how many pages carry a layer of ours, and the staged change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeaderFooterState {
    /// The file has been read (`get_header_footer`); a change needs it.
    pub read: bool,
    /// The spec in the file's catalog; `None` when there is none or it is damaged.
    pub file: Option<HfSpec>,
    /// Pages of the file with a `/SHR_HF` key.
    pub file_layers: u32,
    /// Their indices in the file the session was opened from (or last saved to); the engine copy shows these layers until a save.
    pub layer_pages: Vec<u32>,
    /// `None`: nothing staged. `Some(None)`: the removal is staged. `Some(Some(spec))`: a spec is staged.
    pub pending: Option<Option<HfSpec>>,
}

impl HeaderFooterState {
    /// The spec the document has now: the staged one, else the file's.
    pub fn current(&self) -> Option<&HfSpec> {
        match &self.pending {
            Some(pending) => pending.as_ref(),
            None => self.file.as_ref(),
        }
    }

    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// The file has layers of ours that the next save replaces or removes.
    pub fn replaces_file_layers(&self) -> bool {
        self.pending.is_some() && (self.file_layers > 0 || self.file.is_some())
    }
}

/// What a save writes (`SavePlan.header_footer`): the spec (for the catalog; `None` removes everything of ours) and the runs of each
/// page by its position in the saved file. Pages without a run lose a layer they have.
#[derive(Debug, Clone, PartialEq)]
pub struct HfWrite {
    pub spec: Option<HfSpec>,
    pub pages: Vec<(u32, Vec<PlacedRun>)>,
}

/// The geometry of a page of a save plan.
fn geom_of(page: &PlanPage) -> PageGeom {
    PageGeom {
        crop: page.crop.unwrap_or(page.media),
        rotate: page.rotation,
    }
}

/// What the next save writes for the staged change, from the pages the save builds. `None` when nothing is staged.
pub fn plan(state: &DocState, pages: &PagePlan, file: &str) -> Option<HfWrite> {
    let pending = state.header_footer.pending.as_ref()?;
    let Some(spec) = pending else {
        return Some(HfWrite {
            spec: None,
            pages: Vec::new(),
        });
    };
    let total = u32::try_from(pages.pages.len()).unwrap_or(u32::MAX);
    let runs = pages
        .pages
        .iter()
        .zip(0u32..)
        .filter(|(page, _)| !matches!(page.source, super::page::PageSource::Redacted { .. }))
        .map(|(page, position)| {
            (
                position,
                resolve(spec, geom_of(page), position, total, file),
            )
        })
        .filter(|(_, runs)| !runs.is_empty())
        .collect();
    Some(HfWrite {
        spec: Some(spec.clone()),
        pages: runs,
    })
}

/// Runs `DocCommand::SetHeaderFooter`: stages `spec` (`None` removes; a spec equal to the file's stages nothing) and returns the
/// command that puts the previous staged state back. The file must have been read (`get_header_footer`).
pub(crate) fn set(
    state: &mut DocState,
    spec: Option<&HfSpec>,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    if !state.header_footer.read {
        return Err(AppError::invalid("headerFooter"));
    }
    if let Some(spec) = spec {
        spec.check(Some(state.page_count()))?;
    }
    // A spec without text is a removal.
    let next = spec.filter(|s| !s.is_empty()).cloned();
    let hf = &mut state.header_footer;
    let previous = hf.pending.clone();
    let nothing_to_change = match &next {
        Some(spec) => hf.file.as_ref() == Some(spec),
        None => hf.file.is_none() && hf.file_layers == 0,
    };
    hf.pending = (!nothing_to_change).then_some(next);
    delta.doc.insert(DocPart::HeaderFooter);
    Ok(DocCommand::RestoreHeaderFooter { pending: previous })
}

/// Runs `DocCommand::RestoreHeaderFooter`: puts the staged state back; its inverse is the same command.
pub(crate) fn restore(
    state: &mut DocState,
    pending: &Option<Option<HfSpec>>,
    delta: &mut Delta,
) -> DocCommand {
    let previous = std::mem::replace(&mut state.header_footer.pending, pending.clone());
    delta.doc.insert(DocPart::HeaderFooter);
    DocCommand::RestoreHeaderFooter { pending: previous }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::doc_state::Stamp;

    fn stamp() -> Stamp {
        Stamp {
            now_ms: 0,
            modified: "2026-10-07T00:00:00Z".into(),
        }
    }

    fn geom(rotate: u16) -> PageGeom {
        PageGeom {
            crop: [0.0, 0.0, 200.0, 300.0],
            rotate,
        }
    }

    fn spec() -> HfSpec {
        HfSpec {
            date: "7.10.2026".into(),
            ..HfSpec::default()
        }
    }

    fn texts(runs: &[PlacedRun]) -> Vec<&str> {
        runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn the_default_is_the_date_on_the_left_and_the_page_number_on_the_right() {
        let runs = resolve(&spec(), geom(0), 4, 12, "Bericht");
        assert_eq!(texts(&runs), ["7.10.2026", "5"]);
        // footer baseline: 300 - 28 - 0.21 * 9 from the top
        assert!((runs[0].origin.y - (300.0 - 28.0 - 0.21 * 9.0)).abs() < 0.01);
        assert!((runs[0].origin.x - 28.0).abs() < 0.01);
        // right aligned: the text ends at the margin
        assert!((runs[1].origin.x + runs[1].width - (200.0 - 28.0)).abs() < 0.01);
    }

    #[test]
    fn tokens_resolve_per_page_and_braces_escape() {
        let mut s = spec();
        s.slots = HfSlots {
            header_center: "{file} - {page}/{total} {{x}} {unknown}".into(),
            ..HfSlots::default()
        };
        let runs = resolve(&s, geom(0), 1, 3, "A\u{4e2d}b");
        assert_eq!(texts(&runs), ["A?b - 2/3 {x} {unknown}"]);
    }

    #[test]
    fn the_page_range_is_respected_and_clamped() {
        let mut s = spec();
        s.pages = HfPages::Ranges {
            text: "1-2, 4, 6-".into(),
        };
        let hit: Vec<bool> = (0..7).map(|p| s.covers(p, 7)).collect();
        assert_eq!(hit, [true, true, false, true, false, true, true]);
        // after pages were deleted
        assert!(resolve(&s, geom(0), 2, 7, "f").is_empty());
        assert!(s.covers(1, 2) && !s.covers(3, 3));
        // the grammar of `check`: what it refuses covers nothing (no lenient reading of "1-x", "0", "3-1" or "")
        for bad in ["1-x", "0", "3-1", "", "1,,2", "-3", "1 2"] {
            s.pages = HfPages::Ranges { text: bad.into() };
            assert!(s.check(Some(7)).is_err(), "{bad}");
            assert!(!(0..7).any(|p| s.covers(p, 7)), "{bad}");
        }
    }

    #[test]
    fn three_long_runs_on_a_narrow_page_are_cut_and_never_overlap() {
        let mut s = spec();
        s.slots = HfSlots {
            header_left: "Quarterly report of the northern region".into(),
            header_center: "Confidential draft for review".into(),
            header_right: "Page {page} of {total} in this long file".into(),
            footer_left: "Short".into(),
            footer_center: "A centre text that is much too wide".into(),
            footer_right: "R".into(),
        };
        // 200 pt wide, 28 pt margins: 144 pt for the three.
        let runs = resolve(&s, geom(0), 0, 12, "f");
        let (top, bottom): (Vec<_>, Vec<_>) = runs.iter().partition(|r| r.origin.y < 150.0);
        for edge in [top, bottom] {
            let mut spans: Vec<(f32, f32)> = edge
                .iter()
                .map(|r| (r.origin.x, r.origin.x + r.width))
                .collect();
            spans.sort_by(|a, b| a.0.total_cmp(&b.0));
            assert!(!spans.is_empty());
            assert!(spans.first().is_some_and(|s| s.0 >= 28.0 - 0.01));
            assert!(spans.last().is_some_and(|s| s.1 <= 172.0 + 0.01));
            for pair in spans.windows(2) {
                assert!(pair[1].0 - pair[0].1 >= s.font_size - 0.01, "{spans:?}");
            }
        }
        assert!(runs.iter().any(|r| r.text.ends_with('\u{2026}')));
        // untouched when it fits
        let wide = resolve(
            &s,
            PageGeom {
                crop: [0.0, 0.0, 2000.0, 300.0],
                rotate: 0,
            },
            0,
            12,
            "f",
        );
        assert!(wide.iter().all(|r| !r.text.contains('\u{2026}')));
        // deterministic
        assert_eq!(runs, resolve(&s, geom(0), 0, 12, "f"));
    }

    #[test]
    fn rotated_pages_put_the_header_at_the_displayed_top() {
        let mut s = spec();
        s.slots = HfSlots {
            header_left: "H".into(),
            ..HfSlots::default()
        };
        let runs = resolve(&s, geom(90), 0, 1, "f");
        // displayed 300 x 200; (28, 28 + 0.72 * 9) displayed is (dy, h - dx) = (34.48, 172) in page space
        assert_eq!(runs[0].angle, 90);
        assert!((runs[0].origin.x - (28.0 + 0.72 * 9.0)).abs() < 0.01);
        assert!((runs[0].origin.y - (300.0 - 28.0)).abs() < 0.01);
    }

    #[test]
    fn the_checks_refuse_bad_input() {
        let mut s = spec();
        s.slots.header_left = "\u{4e2d}".into();
        assert!(s.check(None).is_err());
        let mut s = spec();
        s.slots.footer_left = "Grüße {page} €".into();
        assert!(s.check(None).is_ok());
        s.font_size = 5.0;
        assert!(s.check(None).is_err());
        s.font_size = 9.0;
        s.margin = f32::NAN;
        assert!(s.check(None).is_err());
        let mut s = spec();
        s.pages = HfPages::Ranges { text: "9".into() };
        assert!(s.check(Some(3)).is_err());
        assert!(s.check(None).is_ok());
        s.slots.header_right = "x".repeat(257);
        assert!(s.check(None).is_err());
    }

    fn read_state(pages: u32) -> DocState {
        let mut state = DocState::new(pages);
        state.header_footer.read = true;
        state
    }

    #[test]
    fn a_change_is_one_undo_step_with_an_exact_inverse() {
        let mut state = read_state(3);
        let changes = state
            .execute(DocCommand::SetHeaderFooter { spec: Some(spec()) }, &stamp())
            .unwrap();
        assert!(changes.doc.contains(&DocPart::HeaderFooter));
        assert_eq!(
            changes.history.undo_label.as_deref(),
            Some("headerFooter.set")
        );
        assert_eq!(state.header_footer.current(), Some(&spec()));
        let mut other = spec();
        other.font_size = 12.0;
        state
            .execute(
                DocCommand::SetHeaderFooter {
                    spec: Some(other.clone()),
                },
                &stamp(),
            )
            .unwrap();
        state.undo(&stamp()).unwrap();
        assert_eq!(state.header_footer.current(), Some(&spec()));
        state.redo(&stamp()).unwrap();
        assert_eq!(state.header_footer.current(), Some(&other));
        state.undo(&stamp()).unwrap();
        state.undo(&stamp()).unwrap();
        assert!(!state.header_footer.is_pending());
    }

    #[test]
    fn a_removal_is_staged_only_when_the_file_has_something() {
        let mut state = read_state(2);
        state
            .execute(DocCommand::SetHeaderFooter { spec: None }, &stamp())
            .unwrap();
        assert!(!state.header_footer.is_pending(), "nothing to remove");
        state.header_footer.file = Some(spec());
        state.header_footer.file_layers = 2;
        let changes = state
            .execute(DocCommand::SetHeaderFooter { spec: None }, &stamp())
            .unwrap();
        assert_eq!(
            changes.history.undo_label.as_deref(),
            Some("headerFooter.remove")
        );
        assert_eq!(state.header_footer.pending, Some(None));
        assert!(state.header_footer.current().is_none());
        // the same spec as the file's stages nothing
        state
            .execute(DocCommand::SetHeaderFooter { spec: Some(spec()) }, &stamp())
            .unwrap();
        assert!(!state.header_footer.is_pending());
    }

    #[test]
    fn an_unread_file_and_a_bad_range_are_refused_and_change_nothing() {
        let mut state = DocState::new(2);
        let err = state.execute(DocCommand::SetHeaderFooter { spec: Some(spec()) }, &stamp());
        assert!(err.is_err());
        state.header_footer.read = true;
        let mut bad = spec();
        bad.pages = HfPages::Ranges { text: "5".into() };
        assert!(state
            .execute(DocCommand::SetHeaderFooter { spec: Some(bad) }, &stamp())
            .is_err());
        assert!(!state.is_dirty());
    }

    #[test]
    fn the_save_plan_numbers_the_pages_of_the_saved_order_and_skips_other_pages() {
        let mut state = read_state(4);
        let mut s = spec();
        s.pages = HfPages::Ranges { text: "2-3".into() };
        s.slots.footer_right = "{page}/{total} {file}".into();
        state
            .execute(DocCommand::SetHeaderFooter { spec: Some(s) }, &stamp())
            .unwrap();
        let plan = plan(&state, &state.page_plan(), "Bericht").unwrap();
        assert_eq!(
            plan.pages.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(plan.pages[0].1[1].text, "2/4 Bericht");
        // a removal writes no runs; nothing staged writes nothing
        state
            .execute(DocCommand::SetHeaderFooter { spec: None }, &stamp())
            .unwrap();
        state.header_footer.pending = None;
        assert!(super::plan(&state, &state.page_plan(), "x").is_none());
        state.header_footer.pending = Some(None);
        let removal = super::plan(&state, &state.page_plan(), "x").unwrap();
        assert!(removal.spec.is_none() && removal.pages.is_empty());
    }

    #[test]
    fn the_spec_crosses_the_wire_in_camel_case() {
        let json = serde_json::json!({
            "slots": { "footerRight": "{page}" },
            "pages": { "type": "ranges", "text": "2-" },
            "fontSize": 10, "margin": 30, "color": [1, 2, 3], "date": "x"
        });
        let s: HfSpec = serde_json::from_value(json).unwrap();
        assert_eq!(s.slots.footer_right, "{page}");
        assert_eq!(s.color, Rgb([1, 2, 3]));
        assert!(serde_json::from_value::<HfSpec>(serde_json::json!({"nope": 1})).is_err());
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["pages"]["type"], "ranges");
    }
}
