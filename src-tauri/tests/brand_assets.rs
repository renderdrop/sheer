//! The brand assets (REDESIGN_BRIEF R1.1/R1.2, BRAND 7 and 8): the word mark and the app icon as SVG, with glyph outlines instead of text.
//!
//! The outlines come from Inter (variable, `wght` 500; `assets/brand/fonts/InterVariable.ttf`, SIL OFL 1.1, tooling only, never shipped)
//! through `skrifa`. The files `assets/brand/{wordmark,wordmark-secondary,wordmark-mono,icon,icon-light,icon-simple}.svg` are committed;
//! the first test fails when they differ from this generator. After changing the generator, rewrite them with
//!
//! ```text
//! UPDATE_BRAND=1 cargo test --manifest-path src-tauri/Cargo.toml --test brand_assets
//! ```
//!
//! The icon centres "s" and "." as one group by their real outline bounds (not the text box); the dot sits on the baseline of the "s".
//! The deviation of the group centre from the icon centre is measured on the emitted coordinates, logged (`-- --nocapture`) and
//! asserted below 1 % of the edge.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Write as _;
use std::path::PathBuf;

use skrifa::instance::Size;
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

const INK: &str = "#0F0F0F";
const MIST: &str = "#DDE2EA";
const SAND: &str = "#F6F5F1";
const SOLAR: &str = "#FFF84D";

const WEIGHT: f32 = 500.0;
/// Tracking of the word mark and of the icon's "s.", in em.
const TRACKING: f64 = -0.045;
/// Tracking of the claim, in em.
const CLAIM_TRACKING: f64 = 0.28;
const CLAIM: &str = "PDFS MADE SIMPLE";
const ICON_EDGE: f64 = 1024.0;
/// Corner radius of the icon: 22.5 % of the edge.
const ICON_RADIUS: f64 = 230.0;
/// Width of the "s." group as a share of the icon edge.
const ICON_GROUP: f64 = 0.44;

#[derive(Clone, Copy)]
enum Seg {
    M(f64, f64),
    L(f64, f64),
    Q(f64, f64, f64, f64),
    C(f64, f64, f64, f64, f64, f64),
    Z,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Bounds {
    const EMPTY: Bounds = Bounds {
        x0: f64::MAX,
        y0: f64::MAX,
        x1: f64::MIN,
        y1: f64::MIN,
    };

    fn add(&mut self, x: f64, y: f64) {
        self.x0 = self.x0.min(x);
        self.y0 = self.y0.min(y);
        self.x1 = self.x1.max(x);
        self.y1 = self.y1.max(y);
    }

    fn union(self, other: Bounds) -> Bounds {
        Bounds {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    fn width(self) -> f64 {
        self.x1 - self.x0
    }
}

/// One glyph outline in font units, y up.
#[derive(Clone)]
struct Glyph {
    segs: Vec<Seg>,
}

struct Pen(Vec<Seg>);

#[allow(clippy::cast_lossless)]
impl OutlinePen for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.push(Seg::M(x as f64, y as f64));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.push(Seg::L(x as f64, y as f64));
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.0
            .push(Seg::Q(cx as f64, cy as f64, x as f64, y as f64));
    }
    fn curve_to(&mut self, a: f32, b: f32, c: f32, d: f32, x: f32, y: f32) {
        self.0.push(Seg::C(
            a as f64, b as f64, c as f64, d as f64, x as f64, y as f64,
        ));
    }
    fn close(&mut self) {
        self.0.push(Seg::Z);
    }
}

impl Glyph {
    fn map(&self, f: impl Fn(f64, f64) -> (f64, f64)) -> Glyph {
        let segs = self
            .segs
            .iter()
            .map(|&seg| match seg {
                Seg::M(x, y) => {
                    let p = f(x, y);
                    Seg::M(p.0, p.1)
                }
                Seg::L(x, y) => {
                    let p = f(x, y);
                    Seg::L(p.0, p.1)
                }
                Seg::Q(a, b, x, y) => {
                    let (c, p) = (f(a, b), f(x, y));
                    Seg::Q(c.0, c.1, p.0, p.1)
                }
                Seg::C(a, b, c, d, x, y) => {
                    let (c0, c1, p) = (f(a, b), f(c, d), f(x, y));
                    Seg::C(c0.0, c0.1, c1.0, c1.1, p.0, p.1)
                }
                Seg::Z => Seg::Z,
            })
            .collect();
        Glyph { segs }
    }

    /// The exact bounds of the curves (sampled; control points would overshoot).
    fn bounds(&self) -> Bounds {
        let mut b = Bounds::EMPTY;
        let mut cur = (0.0, 0.0);
        let mut start = (0.0, 0.0);
        for &seg in &self.segs {
            match seg {
                Seg::M(x, y) => {
                    cur = (x, y);
                    start = cur;
                    b.add(x, y);
                }
                Seg::L(x, y) => {
                    cur = (x, y);
                    b.add(x, y);
                }
                Seg::Q(cx, cy, x, y) => {
                    for i in 1..=256 {
                        let t = f64::from(i) / 256.0;
                        let u = 1.0 - t;
                        b.add(
                            u * u * cur.0 + 2.0 * u * t * cx + t * t * x,
                            u * u * cur.1 + 2.0 * u * t * cy + t * t * y,
                        );
                    }
                    cur = (x, y);
                }
                Seg::C(a, c, d, e, x, y) => {
                    for i in 1..=256 {
                        let t = f64::from(i) / 256.0;
                        let u = 1.0 - t;
                        b.add(
                            u * u * u * cur.0
                                + 3.0 * u * u * t * a
                                + 3.0 * u * t * t * d
                                + t * t * t * x,
                            u * u * u * cur.1
                                + 3.0 * u * u * t * c
                                + 3.0 * u * t * t * e
                                + t * t * t * y,
                        );
                    }
                    cur = (x, y);
                }
                Seg::Z => cur = start,
            }
        }
        b
    }

    fn svg_path(&self) -> String {
        let mut d = String::new();
        for &seg in &self.segs {
            match seg {
                Seg::M(x, y) => write!(d, "M{} {}", n(x), n(y)),
                Seg::L(x, y) => write!(d, "L{} {}", n(x), n(y)),
                Seg::Q(a, b, x, y) => write!(d, "Q{} {} {} {}", n(a), n(b), n(x), n(y)),
                Seg::C(a, b, c, e, x, y) => {
                    write!(d, "C{} {} {} {} {} {}", n(a), n(b), n(c), n(e), n(x), n(y))
                }
                Seg::Z => write!(d, "Z"),
            }
            .unwrap();
        }
        d
    }
}

/// A number with at most two decimals.
fn n(value: f64) -> String {
    let text = format!("{value:.2}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

struct Typeface {
    data: Vec<u8>,
}

/// A line of glyphs in em units (1 em = 1.0), y up, baseline at 0, starting at x = 0.
struct Line {
    glyphs: Vec<Glyph>,
}

impl Line {
    fn bounds(&self) -> Bounds {
        self.glyphs
            .iter()
            .fold(Bounds::EMPTY, |acc, g| acc.union(g.bounds()))
    }
}

impl Typeface {
    fn load() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("brand")
            .join("fonts")
            .join("InterVariable.ttf");
        Self {
            data: std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
        }
    }

    /// `text` at `wght` 500 with `tracking` em after each character but the last, in em units.
    fn line(&self, text: &str, tracking: f64) -> Line {
        let font = FontRef::new(&self.data).unwrap();
        let location = font.axes().location([("wght", WEIGHT)]);
        let upem = f64::from(font.head().unwrap().units_per_em());
        let charmap = font.charmap();
        let outlines = font.outline_glyphs();
        let metrics = font.glyph_metrics(Size::unscaled(), &location);
        let count = text.chars().count();
        let mut x = 0.0;
        let mut glyphs = Vec::new();
        for (index, c) in text.chars().enumerate() {
            let id = charmap
                .map(c)
                .unwrap_or_else(|| panic!("no glyph for {c:?}"));
            let advance = f64::from(metrics.advance_width(id).unwrap());
            if let Some(outline) = outlines.get(id) {
                let mut pen = Pen(Vec::new());
                outline
                    .draw(
                        DrawSettings::unhinted(Size::unscaled(), &location),
                        &mut pen,
                    )
                    .unwrap();
                let dx = x;
                glyphs.push(Glyph { segs: pen.0 }.map(|px, py| ((px + dx) / upem, py / upem)));
            }
            x += advance;
            if index + 1 < count {
                x += tracking * upem;
            }
        }
        // `x` is the pen position; the glyph coordinates were divided by `upem` above.
        Line { glyphs }
    }
}

/// `line` in an SVG: scaled by `size`, moved so that the ink starts at `(left, top)`, y down.
fn place(line: &Line, size: f64, origin: (f64, f64)) -> Vec<Glyph> {
    line.glyphs
        .iter()
        .map(|g| g.map(|x, y| (origin.0 + x * size, origin.1 - y * size)))
        .collect()
}

fn path_elements(glyphs: &[Glyph], fill: &str) -> String {
    let d: String = glyphs.iter().map(Glyph::svg_path).collect();
    format!("<path fill=\"{fill}\" d=\"{d}\"/>")
}

fn svg(width: f64, height: f64, title: &str, body: &str) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" role=\"img\" aria-label=\"{title}\">\n{body}\n</svg>\n",
        w = n(width),
        h = n(height)
    )
}

// --- word mark -----------------------------------------------------------------------------------------------------------------

const MARK_SIZE: f64 = 256.0;
const PAD: f64 = 0.5 * MARK_SIZE;
const CLAIM_GAP: f64 = 0.42 * MARK_SIZE;

fn wordmark(face: &Typeface, claim: bool, fill: &str) -> String {
    let word = face.line("sheer.", TRACKING);
    let wb = word.bounds();
    let ink_w = wb.width() * MARK_SIZE;
    // The ink of the word mark runs from x = PAD to PAD + ink_w; its baseline is below the ascender of the "h".
    let left = PAD - wb.x0 * MARK_SIZE;
    let baseline = PAD + wb.y1 * MARK_SIZE;
    let mut body = path_elements(&place(&word, MARK_SIZE, (left, baseline)), fill);
    let mut height = baseline - wb.y0 * MARK_SIZE + PAD;
    if claim {
        let caps = face.line(CLAIM, CLAIM_TRACKING);
        let cb = caps.bounds();
        // The claim is as wide as the word mark.
        let size = ink_w / cb.width();
        let claim_baseline = baseline - wb.y0 * MARK_SIZE + CLAIM_GAP + cb.y1 * size;
        body.push('\n');
        body.push_str(&path_elements(
            &place(&caps, size, (PAD - cb.x0 * size, claim_baseline)),
            fill,
        ));
        height = claim_baseline - cb.y0 * size + PAD;
    }
    svg(ink_w + 2.0 * PAD, height, "sheer.", &body)
}

// --- icon ----------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Variant {
    Standard,
    Light,
    Simple,
}

struct IconLayout {
    glyphs: Vec<Glyph>,
    /// Deviation of the centre of the group from the icon centre, in px.
    deviation: (f64, f64),
    /// The dot's bottom minus the "s" bottom, in px.
    baseline_gap: f64,
}

fn icon_layout(face: &Typeface) -> IconLayout {
    let line = face.line("s.", TRACKING);
    // The dot sits on the baseline of the "s": its lowest point moves to the lowest point of the "s" (both overshoot a little).
    let s_bottom = line.glyphs[0].bounds().y0;
    let dot_bottom = line.glyphs[1].bounds().y0;
    let lift = s_bottom - dot_bottom;
    let mut glyphs = line.glyphs.clone();
    glyphs[1] = glyphs[1].map(|x, y| (x, y + lift));
    let line = Line { glyphs };
    let b = line.bounds();
    let size = ICON_GROUP * ICON_EDGE / b.width();
    // Centre the real ink bounds of the group on the icon centre.
    let (cx, cy) = ((b.x0 + b.x1) / 2.0, (b.y0 + b.y1) / 2.0);
    let origin = (ICON_EDGE / 2.0 - cx * size, ICON_EDGE / 2.0 + cy * size);
    let glyphs = place(&line, size, origin);
    // Measure on the placed outlines, independently of the construction above.
    let placed = glyphs
        .iter()
        .fold(Bounds::EMPTY, |acc, g| acc.union(g.bounds()));
    let deviation = (
        (placed.x0 + placed.x1) / 2.0 - ICON_EDGE / 2.0,
        (placed.y0 + placed.y1) / 2.0 - ICON_EDGE / 2.0,
    );
    let baseline_gap = glyphs[1].bounds().y1 - glyphs[0].bounds().y1;
    IconLayout {
        glyphs,
        deviation,
        baseline_gap,
    }
}

fn icon(face: &Typeface, variant: Variant) -> String {
    let layout = icon_layout(face);
    let e = n(ICON_EDGE);
    let r = n(ICON_RADIUS);
    let (defs, background) = match variant {
        Variant::Standard => (
            format!(
                "<defs>\n<linearGradient id=\"bg\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"{e}\" y2=\"{e}\"><stop offset=\"0\" stop-color=\"{MIST}\"/><stop offset=\"1\" stop-color=\"{SAND}\"/></linearGradient>\n\
                 <radialGradient id=\"glow\" gradientUnits=\"userSpaceOnUse\" cx=\"819\" cy=\"870\" r=\"820\"><stop offset=\"0\" stop-color=\"{SOLAR}\" stop-opacity=\".95\"/><stop offset=\".22\" stop-color=\"{SOLAR}\" stop-opacity=\".55\"/><stop offset=\".55\" stop-color=\"{SOLAR}\" stop-opacity=\"0\"/></radialGradient>\n</defs>"
            ),
            format!(
                "<rect width=\"{e}\" height=\"{e}\" rx=\"{r}\" fill=\"url(#bg)\"/>\n<rect width=\"{e}\" height=\"{e}\" rx=\"{r}\" fill=\"url(#glow)\"/>"
            ),
        ),
        Variant::Light => (
            String::new(),
            format!("<rect width=\"{e}\" height=\"{e}\" rx=\"{r}\" fill=\"{SAND}\"/>"),
        ),
        Variant::Simple => (
            String::new(),
            format!("<rect width=\"{e}\" height=\"{e}\" rx=\"{r}\" fill=\"{SOLAR}\"/>"),
        ),
    };
    let mut body = String::new();
    if !defs.is_empty() {
        body.push_str(&defs);
        body.push('\n');
    }
    body.push_str(&background);
    body.push('\n');
    body.push_str(&path_elements(&layout.glyphs, INK));
    svg(ICON_EDGE, ICON_EDGE, "s.", &body)
}

// --- files ---------------------------------------------------------------------------------------------------------------------

fn files() -> Vec<(&'static str, String)> {
    let face = Typeface::load();
    vec![
        ("wordmark.svg", wordmark(&face, true, INK)),
        ("wordmark-secondary.svg", wordmark(&face, false, INK)),
        ("wordmark-mono.svg", wordmark(&face, false, "currentColor")),
        ("icon.svg", icon(&face, Variant::Standard)),
        ("icon-light.svg", icon(&face, Variant::Light)),
        ("icon-simple.svg", icon(&face, Variant::Simple)),
    ]
}

fn brand_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("assets")
        .join("brand")
}

#[test]
fn the_committed_brand_assets_are_what_the_generator_makes() {
    let update = std::env::var_os("UPDATE_BRAND").is_some();
    let mut stale = Vec::new();
    for (name, content) in files() {
        let path = brand_dir().join(name);
        if update {
            std::fs::write(&path, &content).unwrap();
        } else if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
            stale.push(name);
        }
    }
    assert!(
        stale.is_empty(),
        "assets/brand/{stale:?} differ from tests/brand_assets.rs: regenerate with UPDATE_BRAND=1 (see the top of this file)"
    );
}

#[test]
fn the_icon_group_is_centred_by_its_outline_bounds_within_one_percent() {
    let face = Typeface::load();
    let layout = icon_layout(&face);
    let (dx, dy) = layout.deviation;
    let percent = dx.abs().max(dy.abs()) / ICON_EDGE * 100.0;
    println!(
        "icon centring: dx = {dx:.4} px, dy = {dy:.4} px, {percent:.5} % of the {ICON_EDGE} px edge; dot on baseline: gap {:.4} px",
        layout.baseline_gap
    );
    assert!(percent < 1.0, "{percent} %");
    // The dot sits on the baseline of the "s": the lowest points agree.
    assert!(layout.baseline_gap.abs() < 0.01, "{}", layout.baseline_gap);
}

#[test]
fn the_assets_are_paths_not_text_and_follow_the_palette() {
    for (name, content) in files() {
        assert!(
            !content.contains("<text") && !content.contains("font-family"),
            "{name}"
        );
        assert!(content.contains("<path"), "{name}");
        assert!(!content.contains("stroke"), "{name} has a border");
        assert!(!content.contains("filter"), "{name} has a shadow");
    }
    let all: std::collections::HashMap<_, _> = files().into_iter().collect();
    assert!(all["wordmark-mono.svg"].contains("currentColor"));
    assert!(all["wordmark.svg"].contains(INK));
    assert!(all["icon.svg"].contains("radialGradient"));
    assert!(!all["icon-light.svg"].contains("Gradient"));
    assert!(all["icon-simple.svg"].contains(SOLAR));
    // The claim is the only difference between the primary and the secondary word mark.
    assert!(all["wordmark.svg"].matches("<path").count() == 2);
    assert!(all["wordmark-secondary.svg"].matches("<path").count() == 1);
}
