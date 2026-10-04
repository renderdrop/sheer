//! The welcome document (ADR-023, DESIGN 3.14): a sample PDF that opens on the first launch, one task per page.
//!
//! It is generated here with `PdfBuilder`, and the result is committed as `resources/welcome/welcome-{en,de}.pdf` (bundled as Tauri
//! resources). The strings are the `welcomePdf.*` and `tour.step.*` keys of the UI catalogs, `{app}` is `APP_NAME`, and the steps
//! (which exist, on which page, where their target is) are `src/features/tour/steps.json`, the file the tour engine reads too, so a
//! drawn frame and the coach mark that points at it cannot drift. After changing the generator, the strings or the steps, rewrite
//! the files with
//!
//! ```text
//! UPDATE_WELCOME=1 cargo test --manifest-path src-tauri/Cargo.toml --test welcome_document
//! ```
//!
//! The page renders for a visual review (`review/welcome/`, git-ignored) come from the ignored test at the end:
//! `cargo test --manifest-path src-tauri/Cargo.toml --test welcome_document -- --ignored`.
//!
//! Coordinates in this file run from the top left with y down (as DESIGN 3.14 states them); `Canvas` flips them to PDF space.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::Value;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocKind, DocumentInfo, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::events::AppEvent;
use support::{text_string, win_ansi, PdfBuilder};

const STEPS_JSON: &str = include_str!("../../src/features/tour/steps.json");
const APP_TS: &str = include_str!("../../src/config/app.ts");

const PAGE_WIDTH: f64 = 600.0;
const PAGE_HEIGHT: f64 = 800.0;
/// Circle and rounded corner as Béziers: the control point sits `K` of the radius from the corner.
const K: f64 = 0.5523;
/// The upper bound of the advance of a Helvetica or Helvetica-Bold character, in em, for the "does it fit" checks. (The widest
/// letters are 0.944; a line of ordinary text averages about 0.5, so a line that passes at 0.55 has room to spare.)
const EM: f64 = 0.55;

type Rgb = [u8; 3];
const SAND: Rgb = [0xF6, 0xF5, 0xF1];
const RULE: Rgb = [0xE5, 0xE5, 0xE1];
const STONE: Rgb = [0x8A, 0x8A, 0x86];
const SOLAR: Rgb = [0xFF, 0xF8, 0x4D];
/// The glow of page 1 is capped at this alpha (Solar over Sand) ...
const GLOW_ALPHA: f64 = 0.85;
/// ... and has faded out at this share of its radius, so the footer is not on full Solar.
const GLOW_FADE: f64 = 0.55;
const GLOW_RADIUS: f64 = 400.0;

/// Solar at `GLOW_ALPHA` over Sand, as an opaque colour (the shading has no alpha).
fn glow_core() -> Rgb {
    let mix = |sand: u8, solar: u8| {
        (f64::from(sand) * (1.0 - GLOW_ALPHA) + f64::from(solar) * GLOW_ALPHA).round() as u8
    };
    [
        mix(SAND[0], SOLAR[0]),
        mix(SAND[1], SOLAR[1]),
        mix(SAND[2], SOLAR[2]),
    ]
}
const INK: Rgb = [0x0F, 0x0F, 0x0F];
const INK_60: Rgb = [0x6F, 0x6F, 0x6B];
const WHITE: Rgb = [0xFF, 0xFF, 0xFF];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    En,
    De,
}

impl Lang {
    const ALL: [Lang; 2] = [Lang::En, Lang::De];

    fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::De => "de",
        }
    }

    fn bcp47(self) -> &'static str {
        match self {
            Lang::En => "en-US",
            Lang::De => "de-DE",
        }
    }

    fn file_name(self) -> String {
        format!("welcome-{}.pdf", self.code())
    }
}

// --- strings and steps -------------------------------------------------------------------------------------------------------

fn app_name() -> String {
    let start = APP_TS.find("APP_NAME = '").expect("APP_NAME in app.ts") + "APP_NAME = '".len();
    let end = start + APP_TS[start..].find('\'').expect("closing quote");
    APP_TS[start..end].to_owned()
}

struct Strings {
    catalog: HashMap<String, String>,
    app: String,
}

impl Strings {
    fn load(lang: Lang) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("i18n")
            .join("locales")
            .join(format!("{}.json", lang.code()));
        let text = std::fs::read_to_string(&path).unwrap();
        Self {
            catalog: serde_json::from_str(&text).unwrap(),
            app: app_name(),
        }
    }

    fn t(&self, key: &str) -> String {
        self.with(key, &[])
    }

    fn with(&self, key: &str, params: &[(&str, String)]) -> String {
        let mut text = self
            .catalog
            .get(key)
            .unwrap_or_else(|| panic!("the catalog lacks {key}"))
            .replace("{app}", &self.app);
        for (name, value) in params {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        assert!(!text.contains('{'), "{key} has an unfilled placeholder");
        text
    }
}

struct Step {
    id: String,
    page: String,
    ships: String,
    target: Option<Rect>,
    /// Reorder: the thumbnail positions in the edition (the page at `from` goes above the page at `to`).
    from: Option<usize>,
    to: Option<usize>,
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct Shortcut {
    id: String,
    ships: String,
}

struct Manifest {
    /// The shipped steps, in order: they are numbered 1.. in the tour and on the pages.
    steps: Vec<Step>,
    shortcuts: Vec<Shortcut>,
}

fn manifest() -> Manifest {
    let json: Value = serde_json::from_str(STEPS_JSON).unwrap();
    assert_eq!(json["page"]["width"], PAGE_WIDTH);
    assert_eq!(json["page"]["height"], PAGE_HEIGHT);
    let text = |value: &Value| value.as_str().unwrap().to_owned();
    let steps: Vec<Step> = json["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["shipped"].as_bool().unwrap())
        .map(|step| Step {
            id: text(&step["id"]),
            page: text(&step["page"]),
            ships: text(&step["ships"]),
            from: step["from"].as_u64().map(|n| n as usize),
            to: step["to"].as_u64().map(|n| n as usize),
            target: step.get("target").map(|rect| Rect {
                x: rect["x"].as_f64().unwrap(),
                y: rect["y"].as_f64().unwrap(),
                w: rect["w"].as_f64().unwrap(),
                h: rect["h"].as_f64().unwrap(),
            }),
        })
        .collect();
    let shortcuts = json["closingShortcuts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|shortcut| Shortcut {
            id: text(&shortcut["id"]),
            ships: text(&shortcut["ships"]),
        })
        .collect();
    Manifest { steps, shortcuts }
}

impl Manifest {
    fn number(&self, id: &str) -> usize {
        self.steps.iter().position(|step| step.id == id).unwrap() + 1
    }

    fn shipped(&self, id: &str) -> bool {
        self.steps.iter().any(|step| step.id == id)
    }

    fn step(&self, id: &str) -> &Step {
        self.steps.iter().find(|step| step.id == id).unwrap()
    }

    /// The numbers of the shipped steps of page kind `page`.
    fn numbers_on(&self, page: &str) -> Vec<usize> {
        (1..)
            .zip(&self.steps)
            .filter(|(_, step)| step.page == page)
            .map(|(number, _)| number)
            .collect()
    }
}

// --- the editions -------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Welcome,
    Navigate,
    Zoom,
    Markup,
    SignAndSort,
    Closing,
}

/// The pages of the edition, in order (DESIGN 3.14 "Editions"): the kinds that have a shipped step, then the closing page; Navigate
/// joins when there would be fewer than four pages.
fn plan(manifest: &Manifest) -> Vec<Kind> {
    let has = |page: &str| manifest.steps.iter().any(|step| step.page == page);
    let mut kinds = Vec::new();
    if has("W") {
        kinds.push(Kind::Welcome);
    }
    if has("Z") {
        kinds.push(Kind::Zoom);
    }
    if has("M") {
        kinds.push(Kind::Markup);
    }
    if has("S") {
        kinds.push(Kind::SignAndSort);
    }
    if kinds.len() + 1 < 4 {
        // Navigate follows Welcome: the page you reach by turning it.
        kinds.insert(1, Kind::Navigate);
    }
    kinds.push(Kind::Closing);
    kinds
}

/// Drawing content of one page, in PDF operators.
struct Canvas {
    ops: String,
    /// What a `SAND` block is filled with: Sand on the neutral task pages, White on the Sand brand page.
    block: Rgb,
}

fn num(value: f64) -> String {
    let text = format!("{value:.4}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

fn rgb(color: Rgb) -> String {
    color
        .iter()
        .map(|&channel| num(f64::from(channel) / 255.0))
        .collect::<Vec<_>>()
        .join(" ")
}

fn flip(y: f64) -> f64 {
    PAGE_HEIGHT - y
}

impl Canvas {
    fn new() -> Self {
        Self {
            ops: String::new(),
            block: SAND,
        }
    }

    fn raw(&mut self, ops: &str) {
        self.ops.push_str(ops);
        self.ops.push('\n');
    }

    fn point(x: f64, y: f64) -> String {
        format!("{} {}", num(x), num(flip(y)))
    }

    /// A rounded rectangle as a path: lines and four Béziers (`K`).
    fn rounded_rect(&mut self, rect: Rect, r: f64) {
        let Rect { x, y, w, h } = rect;
        let c = K * r;
        let p = Self::point;
        let path = format!(
            "{} m {} l {} {} {} c {} l {} {} {} c {} l {} {} {} c {} l {} {} {} c h",
            p(x + r, y),
            p(x + w - r, y),
            p(x + w - r + c, y),
            p(x + w, y + r - c),
            p(x + w, y + r),
            p(x + w, y + h - r),
            p(x + w, y + h - r + c),
            p(x + w - r + c, y + h),
            p(x + w - r, y + h),
            p(x + r, y + h),
            p(x + r - c, y + h),
            p(x, y + h - r + c),
            p(x, y + h - r),
            p(x, y + r),
            p(x, y + r - c),
            p(x + r - c, y),
            p(x + r, y),
        );
        self.raw(&path);
    }

    fn circle_path(&mut self, cx: f64, cy: f64, r: f64) {
        self.rounded_rect(
            Rect {
                x: cx - r,
                y: cy - r,
                w: 2.0 * r,
                h: 2.0 * r,
            },
            r,
        );
    }

    fn fill_circle(&mut self, cx: f64, cy: f64, r: f64, color: Rgb) {
        self.raw(&format!("{} rg", rgb(color)));
        self.circle_path(cx, cy, r);
        self.raw("f");
    }

    /// A card: fill and a 1 pt stroke.
    fn card(&mut self, rect: Rect, r: f64, fill: Rgb, stroke: Rgb) {
        let fill = if fill == SAND { self.block } else { fill };
        self.raw(&format!("{} rg {} RG 1 w", rgb(fill), rgb(stroke)));
        self.rounded_rect(rect, r);
        self.raw("B");
    }

    fn polyline(&mut self, points: &[(f64, f64)], width: f64, color: Rgb) {
        self.raw(&format!("{} RG {} w 1 J 1 j", rgb(color), num(width)));
        let mut path = String::new();
        for (index, &(x, y)) in points.iter().enumerate() {
            let _ = write!(
                path,
                "{} {} ",
                Self::point(x, y),
                if index == 0 { "m" } else { "l" }
            );
        }
        path.push('S');
        self.raw(&path);
    }

    /// A chevron pointing down, 24 wide, centred on `cx` with its tip at `cy + 6`.
    fn chevron_down(&mut self, cx: f64, cy: f64) {
        self.polyline(
            &[(cx - 12.0, cy - 6.0), (cx, cy + 6.0), (cx + 12.0, cy - 6.0)],
            2.5,
            INK,
        );
    }

    fn line(&mut self, x0: f64, x1: f64, y: f64, width: f64, color: Rgb) {
        self.polyline(&[(x0, y), (x1, y)], width, color);
    }

    /// A line of display text: `tracking` em of letter spacing (negative is tighter), `Tc` in text space.
    #[allow(clippy::too_many_arguments)]
    fn display(
        &mut self,
        font: u8,
        size: f64,
        x: f64,
        y: f64,
        color: Rgb,
        tracking: f64,
        text: &str,
    ) {
        self.raw(&format!(
            "BT /F{font} {} Tf {} Tc {} rg {} Td {} Tj 0 Tc ET",
            num(size),
            num(tracking * size),
            rgb(color),
            Self::point(x, y),
            win_ansi(text)
        ));
    }

    /// One line of text, `font` 1 (Helvetica) or 2 (Helvetica-Bold), with its baseline at `y`.
    fn text(&mut self, font: u8, size: f64, x: f64, y: f64, color: Rgb, text: &str) {
        self.raw(&format!(
            "BT /F{font} {} Tf {} rg {} Td {} Tj ET",
            num(size),
            rgb(color),
            Self::point(x, y),
            win_ansi(text)
        ));
    }
}

/// `text` as lines of at most `max` characters: its own line breaks kept, the rest broken at spaces.
fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        for word in paragraph.split(' ') {
            assert!(
                word.chars().count() <= max,
                "{word:?} is longer than a line"
            );
            if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > max {
                lines.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
        lines.push(line);
    }
    lines
}

/// Asserts that `text` fits `width` pt at `size`, with a margin (`EM`).
fn assert_fits(text: &str, size: f64, width: f64) {
    let used = text.chars().count() as f64 * EM * size;
    assert!(
        used <= width,
        "{text:?} may not fit {width} pt at {size} pt"
    );
}

const MARGIN: f64 = 48.0;
const CONTENT: f64 = 504.0;

struct Doc<'a> {
    strings: &'a Strings,
    manifest: &'a Manifest,
    total: usize,
}

impl Doc<'_> {
    /// The chip of a page: the numbers of its steps.
    fn chip(&self, numbers: &[usize]) -> String {
        match numbers {
            [one] => self
                .strings
                .with("welcomePdf.chip.step", &[("n", one.to_string())]),
            [first, .., last] => self.strings.with(
                "welcomePdf.chip.steps",
                &[("a", first.to_string()), ("b", last.to_string())],
            ),
            [] => panic!("a page with a task has steps"),
        }
    }

    /// Header band, chip, badge, title, instruction and footer (DESIGN 3.14 "Page").
    fn frame(
        &self,
        canvas: &mut Canvas,
        position: usize,
        chip: &str,
        title: &str,
        instruction: &str,
    ) {
        let brand = position == 1;
        if brand {
            // The only brand moment: a Sand page with a soft Solar glow (one radial shading, centre in the lower right).
            canvas.block = WHITE;
            canvas.raw(&format!(
                "q {} rg 0 0 {} {} re f /Sh1 sh Q",
                rgb(SAND),
                num(PAGE_WIDTH),
                num(PAGE_HEIGHT)
            ));
        }
        // Chip.
        canvas.raw(&format!("{} rg", rgb(if brand { WHITE } else { SAND })));
        canvas.rounded_rect(
            Rect {
                x: MARGIN,
                y: 48.0,
                w: 120.0,
                h: 24.0,
            },
            12.0,
        );
        canvas.raw("f");
        assert_fits(chip, 10.0, 96.0);
        canvas.text(2, 10.0, 60.0, 64.0, INK, chip);
        // The printed page number, right aligned (Helvetica digits are 556/1000 em).
        let digits = position.to_string();
        let width = 0.556 * 12.0 * digits.len() as f64;
        canvas.text(1, 12.0, MARGIN + CONTENT - width, 64.0, INK_60, &digits);
        // Title: light display type on the brand page, a plain heading on a task page.
        if brand {
            assert_fits(title, 40.0, 504.0);
            canvas.display(1, 40.0, MARGIN, 140.0, INK, -0.04, title);
        } else {
            assert_fits(title, 28.0, 504.0);
            canvas.display(1, 28.0, MARGIN, 140.0, INK, -0.035, title);
            canvas.line(MARGIN, MARGIN + CONTENT, 168.0, 1.0, RULE);
        }
        for (index, line) in wrap(instruction, 56).iter().enumerate() {
            canvas.text(1, 16.0, MARGIN, 208.0 + 24.0 * index as f64, INK, line);
        }
        // Footer.
        canvas.line(MARGIN, MARGIN + CONTENT, 752.0, 1.0, RULE);
        let footer = self.strings.with(
            "welcomePdf.footer",
            &[
                ("n", position.to_string()),
                ("total", self.total.to_string()),
            ],
        );
        canvas.text(1, 9.0, MARGIN, 772.0, INK_60, &footer);
    }

    /// A task block at `y`: a label and body lines. Returns its bottom edge.
    fn task_block(&self, canvas: &mut Canvas, y: f64, label: &str, body: &str) -> f64 {
        let lines = wrap(body, 64);
        let h = 56.0 + 16.0 * (lines.len() as f64 - 1.0) + 24.0;
        canvas.card(
            Rect {
                x: MARGIN,
                y,
                w: CONTENT,
                h,
            },
            16.0,
            SAND,
            RULE,
        );
        assert_fits(label, 14.0, 360.0);
        canvas.text(1, 14.0, 72.0, y + 32.0, INK, label);
        for (index, line) in lines.iter().enumerate() {
            canvas.text(1, 12.0, 72.0, y + 56.0 + 16.0 * index as f64, INK_60, line);
        }
        y + h
    }

    fn welcome(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let numbers = self.manifest.numbers_on("W");
        let title = s.t("welcomePdf.p1.title");
        self.frame(
            canvas,
            position,
            &self.chip(&numbers),
            &title,
            &s.t("welcomePdf.p1.text"),
        );
        let mut y = 248.0;
        for (&number, id) in numbers.iter().zip(["open", "navigate"]) {
            let label = format!("{number} {}", s.t(&format!("tour.step.{id}.title")));
            let bottom = self.task_block(canvas, y, &label, &s.t(&format!("tour.step.{id}.text")));
            if id == "open" {
                // Done: the file opened by itself.
                let cy = (y + bottom) / 2.0;
                canvas.fill_circle(516.0, cy, 12.0, SOLAR);
                canvas.polyline(
                    &[(510.0, cy), (514.0, cy + 4.5), (522.0, cy - 5.0)],
                    2.0,
                    INK,
                );
            }
            y = bottom + 24.0;
        }
        canvas.chevron_down(300.0, y + 12.0);
        title
    }

    fn navigate(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let step = self.manifest.number("navigate");
        let title = s.t("welcomePdf.nav.title");
        self.frame(
            canvas,
            position,
            &self.chip(&[step]),
            &title,
            &s.t("welcomePdf.nav.text"),
        );
        let lines = wrap(&s.t("welcomePdf.nav.ways"), 64);
        let h = 40.0 + 24.0 * (lines.len() as f64 - 1.0) + 32.0;
        canvas.card(
            Rect {
                x: MARGIN,
                y: 248.0,
                w: CONTENT,
                h,
            },
            16.0,
            SAND,
            RULE,
        );
        for (index, line) in lines.iter().enumerate() {
            canvas.text(
                1,
                12.0,
                72.0,
                248.0 + 40.0 + 24.0 * index as f64,
                INK_60,
                line,
            );
        }
        let below = 248.0 + h + 40.0;
        canvas.chevron_down(300.0, below);
        canvas.text(
            1,
            12.0,
            MARGIN,
            below + 40.0,
            INK_60,
            &s.t("welcomePdf.nav.next"),
        );
        title
    }

    fn zoom(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let step = self.manifest.step("zoom");
        let target = step.target.expect("the zoom step has a target");
        let title = s.t("tour.step.zoom.title");
        let number = self.manifest.number("zoom");
        self.frame(
            canvas,
            position,
            &self.chip(&[number]),
            &title,
            &s.t("welcomePdf.p2.text"),
        );
        canvas.card(target, 16.0, SAND, RULE);
        // Three lines of 5 pt: unreadable at 100 %.
        let lines = wrap(&s.t("welcomePdf.p2.small"), 32);
        assert!(lines.len() <= 3, "{lines:?}");
        // The dashed target frame, 176 x 48, centred in the block (centre 300, 328).
        let (cx, cy) = (target.x + target.w / 2.0, target.y + target.h / 2.0);
        canvas.raw(&format!("{} RG 1 w [4 4] 0 d", rgb(INK_60)));
        canvas.rounded_rect(
            Rect {
                x: cx - 88.0,
                y: cy - 24.0,
                w: 176.0,
                h: 48.0,
            },
            8.0,
        );
        canvas.raw("S [] 0 d");
        // Each line centred (average advance 0.5 em), the lines centred on cy.
        let first = cy - 8.0 * (lines.len() as f64 - 1.0) / 2.0 + 1.75;
        for (index, line) in lines.iter().enumerate() {
            let width = 0.5 * 5.0 * line.chars().count() as f64;
            canvas.text(
                1,
                5.0,
                cx - width / 2.0,
                first + 8.0 * index as f64,
                INK,
                line,
            );
        }
        title
    }

    /// Page M (steps Highlight and Note): the sentence in its frame, the spot for the note, and the order hint when Reorder ships.
    fn markup(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let title = s.t("welcomePdf.p3.title");
        self.frame(
            canvas,
            position,
            &self.chip(&self.manifest.numbers_on("M")),
            &title,
            &s.t("welcomePdf.p3.text"),
        );
        let sentence = self
            .manifest
            .step("highlight")
            .target
            .expect("the highlight step has a target");
        canvas.card(sentence, 16.0, SAND, RULE);
        canvas.text(1, 16.0, 72.0, 282.0, INK, &s.t("welcomePdf.p3.sentence"));
        let mut bottom = sentence.y + sentence.h;
        if self.manifest.shipped("comment") {
            let spot = self
                .manifest
                .step("comment")
                .target
                .expect("the comment step has a target");
            let y = bottom + 24.0;
            let block = Rect {
                x: MARGIN,
                y,
                w: CONTENT,
                h: 96.0,
            };
            canvas.card(block, 16.0, SAND, RULE);
            let label = format!(
                "{} {}",
                self.manifest.number("comment"),
                s.t("tour.step.comment.title")
            );
            canvas.text(1, 14.0, 72.0, y + 32.0, INK, &label);
            canvas.text(
                1,
                12.0,
                72.0,
                y + 56.0,
                INK_60,
                &s.t("tour.step.comment.text"),
            );
            // The spot: a ring and a dot, centred in the target.
            let (cx, cy) = (spot.x + spot.w / 2.0, spot.y + spot.h / 2.0);
            canvas.raw(&format!("{} RG 2 w", rgb(INK)));
            canvas.circle_path(cx, cy, 12.0);
            canvas.raw("S");
            canvas.fill_circle(cx, cy, 4.0, SOLAR);
            bottom = y + block.h;
        }
        if self.manifest.shipped("reorder") {
            let n = self.manifest.number("reorder").to_string();
            let lines = wrap(&s.with("welcomePdf.order", &[("n", n)]), 64);
            let y = bottom + 24.0;
            let h = 32.0 + 16.0 * (lines.len() as f64 - 1.0) + 24.0;
            canvas.card(
                Rect {
                    x: MARGIN,
                    y,
                    w: CONTENT,
                    h,
                },
                16.0,
                SAND,
                RULE,
            );
            for (index, line) in lines.iter().enumerate() {
                canvas.text(1, 12.0, 72.0, y + 32.0 + 16.0 * index as f64, INK_60, line);
            }
        }
        title
    }

    /// Page S (steps Sign and Reorder): the signature frame, then the reorder task.
    fn sign_and_sort(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let signs = self.manifest.shipped("sign");
        let title = if signs {
            s.t("welcomePdf.sign.title")
        } else {
            s.t("tour.step.reorder.title")
        };
        let instruction = if signs {
            s.t("welcomePdf.sign.text")
        } else {
            self.reorder_text()
        };
        self.frame(
            canvas,
            position,
            &self.chip(&self.manifest.numbers_on("S")),
            &title,
            &instruction,
        );
        let mut bottom = 248.0;
        if signs {
            let frame = self
                .manifest
                .step("sign")
                .target
                .expect("the sign step has a target");
            canvas.raw(&format!("{} RG 1 w [4 4] 0 d", rgb(INK_60)));
            canvas.rounded_rect(frame, 8.0);
            canvas.raw("S [] 0 d");
            canvas.line(
                frame.x + 24.0,
                frame.x + frame.w - 24.0,
                frame.y + 72.0,
                1.0,
                STONE,
            );
            canvas.text(
                1,
                9.0,
                frame.x + 24.0,
                frame.y + 88.0,
                INK_60,
                &s.t("welcomePdf.sign.label"),
            );
            bottom = frame.y + frame.h + 48.0;
        }
        if self.manifest.shipped("reorder") && signs {
            let label = format!(
                "{} {}",
                self.manifest.number("reorder"),
                s.t("tour.step.reorder.title")
            );
            self.task_block(canvas, bottom, &label, &self.reorder_text());
        }
        title
    }

    /// The reorder instruction with its two thumbnail positions from `steps.json`.
    fn reorder_text(&self) -> String {
        let step = self.manifest.step("reorder");
        self.strings.with(
            "tour.step.reorder.text",
            &[
                ("from", step.from.expect("reorder has from").to_string()),
                ("to", step.to.expect("reorder has to").to_string()),
            ],
        )
    }

    fn closing(&self, canvas: &mut Canvas, position: usize) -> String {
        let s = self.strings;
        let title = s.t("welcomePdf.end.title");
        self.frame(
            canvas,
            position,
            &s.t("welcomePdf.chip.done"),
            &title,
            &s.t("welcomePdf.end.text"),
        );
        // What next: opening always, then one line per shipped cluster.
        let mut next = vec![s.t("welcomePdf.end.next.open")];
        if self.manifest.shipped("highlight") || self.manifest.shipped("comment") {
            next.push(s.t("welcomePdf.end.next.markup"));
        }
        if self.manifest.shipped("reorder") {
            next.push(s.t("welcomePdf.end.next.organize"));
        }
        if self.manifest.shipped("sign") {
            next.push(s.t("welcomePdf.end.next.sign"));
        }
        let lines: Vec<String> = next.iter().flat_map(|text| wrap(text, 64)).collect();
        let y = 248.0;
        let h = 56.0 + 24.0 * lines.len() as f64;
        canvas.card(
            Rect {
                x: MARGIN,
                y,
                w: CONTENT,
                h,
            },
            16.0,
            SAND,
            RULE,
        );
        canvas.text(
            2,
            14.0,
            72.0,
            y + 32.0,
            INK,
            &s.t("welcomePdf.end.nextTitle"),
        );
        for (index, line) in lines.iter().enumerate() {
            canvas.text(1, 12.0, 72.0, y + 56.0 + 24.0 * index as f64, INK_60, line);
        }
        // Restart.
        let y = y + h + 24.0;
        let restart = wrap(&s.t("welcomePdf.end.restart"), 64);
        let h = 32.0 + 16.0 * (restart.len() as f64 - 1.0) + 24.0;
        canvas.card(
            Rect {
                x: MARGIN,
                y,
                w: CONTENT,
                h,
            },
            16.0,
            SAND,
            RULE,
        );
        for (index, line) in restart.iter().enumerate() {
            canvas.text(1, 12.0, 72.0, y + 32.0 + 16.0 * index as f64, INK_60, line);
        }
        // Shortcuts: key column, then the action. The longest key needs 264 pt of the 432 inside the block.
        let y = y + h + 24.0;
        let rows: Vec<&Shortcut> = self
            .manifest
            .shortcuts
            .iter()
            .filter(|shortcut| {
                shortcut.ships == "M1"
                    || self
                        .manifest
                        .steps
                        .iter()
                        .any(|step| step.ships == shortcut.ships)
            })
            .collect();
        let h = 64.0 + 24.0 * (rows.len() as f64 - 1.0) + 24.0;
        canvas.card(
            Rect {
                x: MARGIN,
                y,
                w: CONTENT,
                h,
            },
            16.0,
            SAND,
            RULE,
        );
        canvas.text(
            2,
            14.0,
            72.0,
            y + 32.0,
            INK,
            &s.t("welcomePdf.end.keysTitle"),
        );
        for (index, row) in rows.iter().enumerate() {
            let baseline = y + 64.0 + 24.0 * index as f64;
            let key = s.t(&format!("welcomePdf.key.{}", row.id));
            assert_fits(&key, 12.0, KEY_COLUMN - 72.0 - 8.0);
            canvas.text(2, 12.0, 72.0, baseline, INK, &key);
            let action = s.t(&format!("welcomePdf.keyAction.{}", row.id));
            assert_fits(&action, 12.0, MARGIN + CONTENT - 24.0 - KEY_COLUMN);
            canvas.text(1, 12.0, KEY_COLUMN, baseline, INK_60, &action);
        }
        assert!(
            y + h < 752.0 - 16.0,
            "the closing page overflows its footer"
        );
        title
    }
}

/// Where the action column of the shortcut rows starts. DESIGN 3.14 first said 240, which the longest key
/// ("Ctrl+Plus / Ctrl+Minus (Cmd on Mac)", bold 12) does not fit.
const KEY_COLUMN: f64 = 344.0;

/// One edition as a PDF file.
fn generate(lang: Lang) -> (Vec<u8>, Vec<String>) {
    let strings = Strings::load(lang);
    let manifest = manifest();
    let kinds = plan(&manifest);
    let doc = Doc {
        strings: &strings,
        manifest: &manifest,
        total: kinds.len(),
    };

    let mut titles = Vec::new();
    let mut contents = Vec::new();
    for (index, &kind) in kinds.iter().enumerate() {
        let position = index + 1;
        // With Reorder shipped M and S print each other's number: dragging S above M puts the printed numbers in order.
        let printed = match kind {
            Kind::Markup
                if manifest.shipped("reorder")
                    && kinds.get(index + 1) == Some(&Kind::SignAndSort) =>
            {
                position + 1
            }
            Kind::SignAndSort
                if manifest.shipped("reorder") && index > 0 && kinds[index - 1] == Kind::Markup =>
            {
                position - 1
            }
            _ => position,
        };
        let mut canvas = Canvas::new();
        let title = match kind {
            Kind::Welcome => doc.welcome(&mut canvas, position),
            Kind::Navigate => doc.navigate(&mut canvas, position),
            Kind::Zoom => doc.zoom(&mut canvas, position),
            Kind::Closing => doc.closing(&mut canvas, position),
            Kind::Markup => doc.markup(&mut canvas, printed),
            Kind::SignAndSort => doc.sign_and_sort(&mut canvas, printed),
        };
        titles.push(title);
        contents.push(canvas.ops);
    }

    let first_page = 20;
    let page_object = |index: usize| first_page + 2 * index as u32;
    let outline_first = 8;
    let mut builder = PdfBuilder::new();
    builder
        .object(
            1,
            &format!(
                "<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /PageMode /UseOutlines /Lang ({}) >>",
                lang.bcp47()
            ),
        )
        .object(
            2,
            &format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                (0..kinds.len())
                    .map(|index| format!("{} 0 R", page_object(index)))
                    .collect::<Vec<_>>()
                    .join(" "),
                kinds.len()
            ),
        )
        .object(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        )
        .object(
            4,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        )
        .object(
            5,
            &format!(
                "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [520 {} 0 520 {} {}]                  /Function << /FunctionType 2 /Domain [0 1] /C0 [{}] /C1 [{}] /N 2.6 >> /Extend [false true] >>",
                num(flip(740.0)),
                num(flip(740.0)),
                num(GLOW_RADIUS * GLOW_FADE),
                rgb(glow_core()),
                rgb(SAND)
            ),
        )
        .object(
            6,
            &format!("<< /Title {} >>", text_string(&strings.t("welcomePdf.p1.title"))),
        )
        .object(
            7,
            &format!(
                "<< /Type /Outlines /First {outline_first} 0 R /Last {} 0 R /Count {} >>",
                outline_first + kinds.len() as u32 - 1,
                kinds.len()
            ),
        );
    for (index, title) in titles.iter().enumerate() {
        let id = outline_first + index as u32;
        let mut entry = format!(
            "<< /Title {} /Parent 7 0 R /Dest [{} 0 R /Fit]",
            text_string(title),
            page_object(index)
        );
        if index > 0 {
            let _ = write!(entry, " /Prev {} 0 R", id - 1);
        }
        if index + 1 < kinds.len() {
            let _ = write!(entry, " /Next {} 0 R", id + 1);
        }
        entry.push_str(" >>");
        builder.object(id, &entry);
    }
    for (index, content) in contents.iter().enumerate() {
        builder.object(
            page_object(index),
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /Shading << /Sh1 5 0 R >> >> >>",
                num(PAGE_WIDTH),
                num(PAGE_HEIGHT),
                page_object(index) + 1
            ),
        );
        builder.stream(page_object(index) + 1, "", content.as_bytes());
    }
    builder.trailer("/Info 6 0 R");
    (builder.finish(1), titles)
}

fn resources_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("welcome")
}

// --- tests --------------------------------------------------------------------------------------------------------------------

#[test]
fn the_committed_welcome_documents_are_what_the_generator_makes() {
    let update = std::env::var_os("UPDATE_WELCOME").is_some();
    let mut stale = Vec::new();
    for lang in Lang::ALL {
        let (bytes, _) = generate(lang);
        let path = resources_dir().join(lang.file_name());
        if update {
            std::fs::create_dir_all(resources_dir()).unwrap();
            std::fs::write(&path, &bytes).unwrap();
        } else if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
            stale.push(lang.file_name());
        }
    }
    assert!(
        stale.is_empty(),
        "resources/welcome/{stale:?} differ from tests/welcome_document.rs, the locale files or steps.json: regenerate with UPDATE_WELCOME=1 (see the top of this file)"
    );
}

#[test]
fn an_edition_is_five_pages_in_m7_and_has_no_images_annotations_links_actions_or_scripts() {
    assert_eq!(
        plan(&manifest()),
        [
            Kind::Welcome,
            Kind::Zoom,
            Kind::Markup,
            Kind::SignAndSort,
            Kind::Closing
        ]
    );
    for lang in Lang::ALL {
        let (bytes, titles) = generate(lang);
        assert_eq!(titles.len(), 5);
        assert!(bytes.starts_with(b"%PDF-1.7\n") && bytes.ends_with(b"%%EOF\n"));
        assert!(bytes.len() < 32 * 1024, "{lang:?} is {} bytes", bytes.len());
        let text = String::from_utf8_lossy(&bytes);
        for forbidden in [
            "/Image",
            "/XObject",
            "/Annot",
            "/Link",
            "/URI",
            "/A ",
            "/AA",
            "/OpenAction",
            "/JS",
            "/JavaScript",
            "/Launch",
            "/EmbeddedFile",
            "/AcroForm",
            "/DeviceCMYK",
            "/ICCBased",
        ] {
            assert!(!text.contains(forbidden), "{lang:?} contains {forbidden}");
        }
        assert!(text.contains(&format!("/Lang ({})", lang.bcp47())));
        assert!(text.contains("/Info 6 0 R"));
        assert_eq!(
            text.matches("/ShadingType 3").count(),
            1,
            "one radial shading"
        );
        assert_eq!(text.matches("/Type /Page ").count(), 5);
    }
}

#[test]
fn every_text_of_the_catalogs_the_pdf_uses_is_in_win_ansi_and_both_editions_have_the_same_layout() {
    // `win_ansi` panics on a character that WinAnsiEncoding lacks, so generating both editions is the check.
    let (en, _) = generate(Lang::En);
    let (de, _) = generate(Lang::De);
    assert_ne!(en, de);
    // The structure (objects, shadings, path operators) is the same: only the strings differ.
    let count = |bytes: &[u8], needle: &str| String::from_utf8_lossy(bytes).matches(needle).count();
    for needle in [" obj\n", " c h", "/Sh1 sh"] {
        assert_eq!(count(&en, needle), count(&de, needle), "{needle:?}");
    }
}

#[test]
fn the_wrapper_keeps_its_own_breaks_and_breaks_at_spaces() {
    assert_eq!(wrap("a b\nc", 10), ["a b", "c"]);
    assert_eq!(wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
    assert_eq!(wrap("", 5), [""]);
}

// --- PDFium opens them ---------------------------------------------------------------------------------------------------------

/// The one state of the process. `None` when the PDFium library has not been fetched.
fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                Some(AppState::new(Engine::start(library)))
            } else {
                eprintln!(
                    "skipping welcome document test: {} not found",
                    library.display()
                );
                None
            }
        })
        .as_ref()
}

/// Opening the welcome document closes the one that is open (a restart), so the tests that open it take turns.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn open_welcome(state: &AppState, lang: Lang) -> DocumentInfo {
    let path = resources_dir().join(lang.file_name());
    match state.open_welcome(path, "Welcome.pdf".to_owned()) {
        AppEvent::Opened { document } => document,
        other => panic!("the welcome document did not open: {other:?}"),
    }
}

#[test]
fn pdfium_opens_each_edition_with_five_pages_and_the_titles_in_text_and_outline() {
    let Some(state) = state() else { return };
    let _serial = serial();
    for lang in Lang::ALL {
        let (_, titles) = generate(lang);
        let info = open_welcome(state, lang);
        assert_eq!(info.kind, DocKind::Welcome);
        assert_eq!(info.page_count, 5, "{lang:?}");
        for (index, title) in (0u32..).zip(&titles) {
            let layer = state.text_layer(info.id, PageId::new(index)).unwrap();
            assert!(
                layer.text.contains(title.as_str()),
                "{lang:?} page {}: {title:?} not in {:?}",
                index + 1,
                layer.text
            );
        }
        let outline = state.outline(info.id).unwrap();
        let outline_titles: Vec<&str> = outline.iter().map(|node| node.title.as_str()).collect();
        assert_eq!(
            outline_titles,
            titles.iter().map(String::as_str).collect::<Vec<_>>()
        );
        for (index, node) in (0u32..).zip(&outline) {
            let target = node.target.as_ref().expect("an outline entry has a page");
            assert_eq!(target.page_id, PageId::new(index));
        }
    }
}

/// Renders every page of both editions to `review/welcome/` (git-ignored) at 2 px per pt, for a look with the eyes. Not part of the
/// normal run: `cargo test --test welcome_document -- --ignored`.
#[test]
#[ignore = "writes PNG renders for a visual review"]
fn render_the_welcome_pages_for_review() {
    let Some(state) = state() else { return };
    let _serial = serial();
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("review")
        .join("welcome");
    std::fs::create_dir_all(&out).unwrap();
    for lang in Lang::ALL {
        let info = open_welcome(state, lang);
        for index in 0..info.page_count {
            let request = serde_json::json!({
                "docId": info.id,
                "pageId": index,
                "bucket": 4,
                "priority": "visible",
                "generation": 1,
            });
            let frame = state
                .render_page(serde_json::from_value(request).unwrap())
                .unwrap();
            // A frame is a 16 byte header and a PNG (`engine::encode`).
            let png = &frame[sheer_lib::engine::encode::FRAME_HEADER_BYTES..];
            std::fs::write(
                out.join(format!("welcome-{}-p{}.png", lang.code(), index + 1)),
                png,
            )
            .unwrap();
        }
    }
}
