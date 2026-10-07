//! What an OCR layer says before it is in the file (ADR-134 item 8): the text of a page, its search hits, the lines smart links read, and
//! what is left of it after a redaction, all answered in the app process from an [`OcrPageLayer`] and in the shapes the engine
//! answers in. Until the save the engine knows nothing of the layer; after it the engine reads the real one and this is not asked.
//!
//! Boxes come out in page space (ADR-003: points, top left of the unrotated page, y down). The layer's words are in displayed space
//! (after `/Rotate`), so each box goes through the page's rotation first. A word has no per-character boxes of its own: its box is
//! split evenly over its characters, which is what the glyphless font of the saved layer does too (one `Tz` per word).
//!
//! Pure: nothing here reads a file or asks the engine, so the rules are tested without PDFium.

use crate::engine::{SearchSpec, TextPage};
use crate::limits;
use crate::model::find::find;
use crate::model::geometry::{Point, Quad, Rect};
use crate::ocr::{OcrLine, OcrPageLayer, OcrWord};
use crate::pdfwrite::ocr_layer::PageGeom;
use crate::smartlinks::model::{Line, PageText, PtRect, Run};

/// Where a page is: its size before the rotation (the crop size) and its `/Rotate` as the session has it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub size: [f32; 2],
    pub rotation: u16,
}

impl Shape {
    fn geom(self) -> PageGeom {
        PageGeom {
            crop: [0.0, 0.0, self.size[0], self.size[1]],
            rotate: self.rotation,
        }
    }

    /// A box of the layer `[x0, y0, x1, y1]` in page space. A stored layer is already in page space (see [`canonical`]), so this only
    /// puts the corners in order; the shape's rotation does not matter to it.
    fn to_page(self, r: [f32; 4]) -> [f32; 4] {
        [
            r[0].min(r[2]),
            r[1].min(r[3]),
            r[0].max(r[2]),
            r[1].max(r[3]),
        ]
    }

    /// A box of the displayed page (after `/Rotate`) as a box in page space.
    fn display_to_page(self, r: [f32; 4]) -> [f32; 4] {
        let geom = self.geom();
        let a = geom.display_to_page(r[0], r[1]);
        let b = geom.display_to_page(r[2], r[3]);
        [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)]
    }

    /// A box in page space as a box of the displayed page (the inverse of [`Shape::display_to_page`]).
    fn page_to_display(self, r: [f32; 4]) -> [f32; 4] {
        let [w, h] = self.size;
        let map = |px: f32, py: f32| match self.rotation % 360 {
            90 => (h - py, px),
            180 => (w - px, h - py),
            270 => (py, w - px),
            _ => (px, py),
        };
        let a = map(r[0], r[1]);
        let b = map(r[2], r[3]);
        [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)]
    }
}

fn map_rects(layer: &OcrPageLayer, f: impl Fn([f32; 4]) -> [f32; 4]) -> OcrPageLayer {
    OcrPageLayer {
        lines: layer
            .lines
            .iter()
            .map(|line| OcrLine {
                words: line
                    .words
                    .iter()
                    .map(|w| OcrWord {
                        text: w.text.clone(),
                        rect: if valid(&w.rect) { f(w.rect) } else { w.rect },
                    })
                    .collect(),
            })
            .collect(),
        ..layer.clone()
    }
}

/// A fresh layer (boxes of the displayed page, as the recognizer made them) in the form the model keeps it: in page space, so that a
/// later rotation of the page does not move it (ADR-134 item 8).
pub fn canonical(layer: &OcrPageLayer, shape: Shape) -> OcrPageLayer {
    map_rects(layer, |r| shape.display_to_page(r))
}

/// A kept layer as boxes of the displayed page with the rotation `shape` has now: what the writer takes (`pdfwrite::ocr_layer`).
pub fn displayed(layer: &OcrPageLayer, shape: Shape) -> OcrPageLayer {
    map_rects(layer, |r| shape.page_to_display(r))
}

/// A kept layer moved by (`dx`, `dy`) points: the page's crop moved its origin.
pub fn shifted(layer: &OcrPageLayer, dx: f32, dy: f32) -> OcrPageLayer {
    map_rects(layer, |r| [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
}

/// A hundredth of a point, like every box the engine sends.
fn quantize(v: f32) -> f32 {
    if v.is_finite() {
        (v * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn valid(r: &[f32; 4]) -> bool {
    r.iter().all(|n| n.is_finite())
}

/// One character of the layer's text and its box in page space (`[x0, y0, x1, y1]`; all zero for a line break).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ch {
    c: char,
    r: [f32; 4],
    line: usize,
}

/// The characters of the layer in reading order: the words of a line joined by a space whose box is the gap between them, the lines by a
/// line feed (which has no box). Characters that are controls are left out; a word with none is skipped.
fn chars(layer: &OcrPageLayer, shape: Shape) -> Vec<Ch> {
    const NONE: [f32; 4] = [0.0; 4];
    let mut out: Vec<Ch> = Vec::new();
    for (line_no, line) in layer.lines.iter().enumerate() {
        let mut previous: Option<[f32; 4]> = None;
        let mut started = false;
        for word in &line.words {
            let letters: Vec<char> = word.text.chars().filter(|c| !c.is_control()).collect();
            if letters.is_empty() || !valid(&word.rect) {
                continue;
            }
            if !started {
                if !out.is_empty() {
                    let line = out.last().map_or(0, |ch| ch.line);
                    out.push(Ch {
                        c: '\n',
                        r: NONE,
                        line,
                    });
                }
                started = true;
            }
            let [x0, y0, x1, y1] = word.rect;
            if let Some(before) = previous {
                let left = before[2].min(x0);
                let gap = [
                    left,
                    before[1].min(y0),
                    x0.max(before[2]).max(left),
                    before[3].max(y1),
                ];
                out.push(Ch {
                    c: ' ',
                    r: shape.to_page(gap),
                    line: line_no,
                });
            }
            let n = letters.len() as f32;
            let step = (x1 - x0) / n;
            for (i, c) in letters.into_iter().enumerate() {
                let cx0 = x0 + step * i as f32;
                out.push(Ch {
                    c,
                    r: shape.to_page([cx0, y0, cx0 + step, y1]),
                    line: line_no,
                });
            }
            previous = Some(word.rect);
        }
    }
    out
}

fn rect_of(r: [f32; 4]) -> Rect {
    Rect {
        x: quantize(r[0]),
        y: quantize(r[1]),
        w: quantize((r[2] - r[0]).max(0.0)),
        h: quantize((r[3] - r[1]).max(0.0)),
    }
}

/// The text layer of a page as the engine would answer it: the text, four numbers per UTF-16 code unit, and whether it was cut at
/// `limits::MAX_TEXT_CHARS`.
pub fn text_page(layer: &OcrPageLayer, shape: Shape) -> TextPage {
    let mut text = String::new();
    let mut boxes: Vec<f32> = Vec::new();
    let mut units = 0usize;
    let mut truncated = false;
    for ch in chars(layer, shape) {
        let width = ch.c.len_utf16();
        if units + width > limits::MAX_TEXT_CHARS {
            truncated = true;
            break;
        }
        let rect = rect_of(ch.r);
        text.push(ch.c);
        for _ in 0..width {
            boxes.extend([rect.x, rect.y, rect.w, rect.h]);
        }
        units += width;
    }
    TextPage {
        text,
        boxes,
        truncated,
        rotation: shape.rotation,
    }
}

/// The corners of a rectangle: top left, top right, bottom left, bottom right.
fn quad_of(r: [f32; 4]) -> Quad {
    let rect = rect_of(r);
    let (left, right) = (rect.x, rect.x + rect.w);
    let (top, bottom) = (rect.y, rect.y + rect.h);
    [
        Point { x: left, y: top },
        Point { x: right, y: top },
        Point { x: left, y: bottom },
        Point {
            x: right,
            y: bottom,
        },
    ]
}

/// The first `limit` hits of `spec` in the layer, in reading order, each as one quad per line it runs over (page space).
pub fn search_page(
    layer: &OcrPageLayer,
    shape: Shape,
    spec: &SearchSpec,
    limit: usize,
) -> Vec<Vec<Quad>> {
    let all: Vec<Ch> = chars(layer, shape)
        .into_iter()
        .take(limits::MAX_SEARCH_PAGE_CHARS)
        .collect();
    let text: Vec<char> = all.iter().map(|ch| ch.c).collect();
    find(&text, &spec.text, spec.match_case, spec.whole_word, limit)
        .into_iter()
        .filter_map(|(first, last)| {
            let mut rects: Vec<(usize, [f32; 4])> = Vec::new();
            for ch in all.get(first..=last)? {
                // A line break has no box.
                if ch.r[2] <= ch.r[0] && ch.r[3] <= ch.r[1] {
                    continue;
                }
                match rects.last_mut() {
                    Some((line, r)) if *line == ch.line => {
                        r[0] = r[0].min(ch.r[0]);
                        r[1] = r[1].min(ch.r[1]);
                        r[2] = r[2].max(ch.r[2]);
                        r[3] = r[3].max(ch.r[3]);
                    }
                    _ => rects.push((ch.line, ch.r)),
                }
            }
            let quads: Vec<Quad> = rects
                .into_iter()
                .take(limits::MAX_QUADS_PER_HIT)
                .map(|(_, r)| quad_of(r))
                .collect();
            (!quads.is_empty()).then_some(quads)
        })
        .collect()
}

/// The page as lines and runs for smart links (`index` is the page's number in the file, as the engine's reading would say): a line of the
/// layer is a line with one run, whose size is the line's height.
pub fn page_text(layer: &OcrPageLayer, shape: Shape, index: u32) -> PageText {
    let mut lines: Vec<Line> = Vec::new();
    let mut sizes: Vec<f32> = Vec::new();
    for line in layer.lines.iter().take(limits::MAX_SMART_LINES_PER_PAGE) {
        let words: Vec<&OcrWord> = line
            .words
            .iter()
            .filter(|w| valid(&w.rect) && w.text.chars().any(|c| !c.is_control()))
            .collect();
        if words.is_empty() {
            continue;
        }
        let text: String = words
            .iter()
            .map(|w| {
                w.text
                    .chars()
                    .filter(|c| !c.is_control())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" ");
        let mut r = shape.to_page(words[0].rect);
        for w in &words[1..] {
            let n = shape.to_page(w.rect);
            r = [
                r[0].min(n[0]),
                r[1].min(n[1]),
                r[2].max(n[2]),
                r[3].max(n[3]),
            ];
        }
        let rect = rect_of(r);
        let size = rect.h.max(1.0);
        sizes.push(size);
        let pt = PtRect {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
        };
        lines.push(Line {
            runs: vec![Run {
                text,
                rect: pt,
                size,
                baseline: quantize(rect.y + rect.h * 0.8),
                bold: false,
            }],
            rect: pt,
        });
    }
    sizes.sort_by(f32::total_cmp);
    PageText {
        page: index,
        width: shape.size[0],
        height: shape.size[1],
        lines,
        body_size: sizes.get(sizes.len() / 2).copied().unwrap_or(0.0),
    }
}

/// The layer without the words that lie under `burn` (page space rectangles): a word goes if its box touches one. `None` if nothing
/// was under them (the layer stays as it is). Lines left without a word are dropped.
pub fn without_covered(layer: &OcrPageLayer, shape: Shape, burn: &[Rect]) -> Option<OcrPageLayer> {
    let covered = |word: &OcrWord| {
        let w = shape.to_page(word.rect);
        burn.iter()
            .any(|b| w[0] < b.x + b.w && w[2] > b.x && w[1] < b.y + b.h && w[3] > b.y)
            || !valid(&word.rect)
    };
    if !layer.lines.iter().flat_map(|l| &l.words).any(covered) {
        return None;
    }
    let lines = layer
        .lines
        .iter()
        .filter_map(|line| {
            let words: Vec<OcrWord> = line.words.iter().filter(|w| !covered(w)).cloned().collect();
            (!words.is_empty()).then_some(OcrLine { words })
        })
        .collect();
    Some(OcrPageLayer {
        lines,
        ..layer.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, x0: f32, y0: f32, x1: f32, y1: f32) -> OcrWord {
        OcrWord {
            text: text.into(),
            rect: [x0, y0, x1, y1],
        }
    }

    fn layer() -> OcrPageLayer {
        OcrPageLayer {
            lang: "en-US".into(),
            angle_deg: 0.0,
            dpi: 300.0,
            lines: vec![
                OcrLine {
                    words: vec![
                        word("Hello", 10.0, 10.0, 60.0, 22.0),
                        word("world", 70.0, 10.0, 120.0, 22.0),
                    ],
                },
                OcrLine {
                    words: vec![word("second", 10.0, 30.0, 70.0, 42.0)],
                },
            ],
        }
    }

    const UPRIGHT: Shape = Shape {
        size: [200.0, 300.0],
        rotation: 0,
    };

    fn spec(text: &str) -> SearchSpec {
        SearchSpec {
            text: text.into(),
            match_case: false,
            whole_word: false,
        }
    }

    #[test]
    fn the_text_has_spaces_between_words_line_feeds_between_lines_and_a_box_per_unit() {
        let page = text_page(&layer(), UPRIGHT);
        assert_eq!(page.text, "Hello world\nsecond");
        assert_eq!(page.boxes.len(), 4 * page.text.encode_utf16().count());
        assert!(!page.truncated);
        // First letter: a fifth of the first word, page space equals displayed space when upright.
        assert_eq!(&page.boxes[0..4], &[10.0, 10.0, 10.0, 12.0]);
        // The space spans the gap between the words.
        assert_eq!(&page.boxes[20..24], &[60.0, 10.0, 10.0, 12.0]);
        // The line feed has no box.
        assert_eq!(&page.boxes[44..48], &[0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_rotated_page_gets_boxes_before_the_rotation() {
        // Rotated by 90 the page is shown 300 wide; the displayed top left is the unrotated bottom left.
        let shape = Shape {
            size: [200.0, 300.0],
            rotation: 90,
        };
        let layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![word("a", 0.0, 0.0, 30.0, 10.0)],
            }],
            ..OcrPageLayer::default()
        };
        let page = text_page(&canonical(&layer, shape), shape);
        assert_eq!(page.rotation, 90);
        let r = &page.boxes[0..4];
        // PageGeom: display (dx, dy) -> user (x0 + dy, y0 + dx) -> page (dy, h - dx).
        assert_eq!(r, &[0.0, 270.0, 10.0, 30.0]);
    }

    #[test]
    fn a_character_of_two_code_units_has_two_boxes_and_a_long_page_is_cut() {
        let layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![word("a\u{1f600}", 0.0, 0.0, 20.0, 10.0)],
            }],
            ..OcrPageLayer::default()
        };
        let page = text_page(&layer, UPRIGHT);
        assert_eq!(page.text.encode_utf16().count(), 3);
        assert_eq!(page.boxes.len(), 12);
        let long = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![word(
                    &"x".repeat(limits::MAX_TEXT_CHARS + 5),
                    0.0,
                    0.0,
                    20.0,
                    10.0,
                )],
            }],
            ..OcrPageLayer::default()
        };
        let page = text_page(&long, UPRIGHT);
        assert!(page.truncated);
        assert_eq!(page.text.len(), limits::MAX_TEXT_CHARS);
    }

    #[test]
    fn controls_and_non_finite_boxes_never_reach_the_text() {
        let layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![
                    word("a\u{0}b", 0.0, 0.0, 20.0, 10.0),
                    word("bad", f32::NAN, 0.0, 20.0, 10.0),
                ],
            }],
            ..OcrPageLayer::default()
        };
        let page = text_page(&layer, UPRIGHT);
        assert_eq!(page.text, "ab");
    }

    #[test]
    fn search_finds_words_across_a_gap_one_quad_per_line() {
        let hits = search_page(&layer(), UPRIGHT, &spec("LO WO"), 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].len(), 1);
        // From the "l" of Hello (x = 10 + 3 * 10) to the end of the "o" of world... "lo wo" = l o space w o.
        assert_eq!(hits[0][0][0], Point { x: 40.0, y: 10.0 });
        assert_eq!(hits[0][0][3], Point { x: 90.0, y: 22.0 });
        let across = search_page(&layer(), UPRIGHT, &spec("world second"), 10);
        assert_eq!(across.len(), 1);
        assert_eq!(across[0].len(), 2, "one quad per line");
        assert!(search_page(&layer(), UPRIGHT, &spec("nothing"), 10).is_empty());
        assert_eq!(search_page(&layer(), UPRIGHT, &spec("o"), 2).len(), 2);
    }

    #[test]
    fn smart_links_read_a_run_per_line() {
        let page = page_text(&layer(), UPRIGHT, 4);
        assert_eq!(page.page, 4);
        assert_eq!((page.width, page.height), (200.0, 300.0));
        assert_eq!(page.lines.len(), 2);
        assert_eq!(page.lines[0].runs[0].text, "Hello world");
        assert_eq!(page.lines[0].rect.w, 110.0);
        assert_eq!(page.body_size, 12.0);
    }

    #[test]
    fn a_redaction_takes_the_words_it_touches_and_nothing_else() {
        let burn = [Rect {
            x: 65.0,
            y: 8.0,
            w: 10.0,
            h: 20.0,
        }];
        let kept = without_covered(&layer(), UPRIGHT, &burn).unwrap();
        assert_eq!(kept.lines.len(), 2);
        assert_eq!(kept.lines[0].words.len(), 1);
        assert_eq!(kept.lines[0].words[0].text, "Hello");
        assert_eq!(kept.lang, "en-US");
        // A whole line goes: the line goes.
        let burn = [Rect {
            x: 0.0,
            y: 28.0,
            w: 200.0,
            h: 20.0,
        }];
        assert_eq!(
            without_covered(&layer(), UPRIGHT, &burn)
                .unwrap()
                .lines
                .len(),
            1
        );
        // Nothing under the box: no change.
        let burn = [Rect {
            x: 150.0,
            y: 150.0,
            w: 10.0,
            h: 10.0,
        }];
        assert!(without_covered(&layer(), UPRIGHT, &burn).is_none());
        // Touching edges are not under it.
        let burn = [Rect {
            x: 120.0,
            y: 10.0,
            w: 10.0,
            h: 12.0,
        }];
        assert!(without_covered(&layer(), UPRIGHT, &burn).is_none());
    }

    #[test]
    fn a_redaction_box_is_in_page_space_also_on_a_rotated_page() {
        let shape = Shape {
            size: [200.0, 300.0],
            rotation: 90,
        };
        let layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![word("a", 0.0, 0.0, 30.0, 10.0)],
            }],
            ..OcrPageLayer::default()
        };
        // The word is at page x 0..10, y 270..300.
        let hit = [Rect {
            x: 2.0,
            y: 280.0,
            w: 2.0,
            h: 2.0,
        }];
        assert!(without_covered(&canonical(&layer, shape), shape, &hit).is_some());
        let miss = [Rect {
            x: 2.0,
            y: 10.0,
            w: 2.0,
            h: 2.0,
        }];
        assert!(without_covered(&canonical(&layer, shape), shape, &miss).is_none());
    }

    #[test]
    fn a_kept_layer_does_not_move_when_the_page_is_rotated_later() {
        let layer = layer();
        let at_zero = Shape {
            size: [200.0, 300.0],
            rotation: 0,
        };
        let kept = canonical(&layer, at_zero);
        // The text boxes are the same whatever the page's rotation is now; only the reported rotation differs.
        let turned = Shape {
            size: [200.0, 300.0],
            rotation: 90,
        };
        let (a, b) = (text_page(&kept, at_zero), text_page(&kept, turned));
        assert_eq!(a.boxes, b.boxes);
        assert_eq!(b.rotation, 90);
        // The writer gets it in the displayed space of the rotation the page has when it is saved, and that maps back.
        for rotation in [0, 90, 180, 270] {
            let shape = Shape {
                size: [200.0, 300.0],
                rotation,
            };
            let shown = displayed(&kept, shape);
            assert_eq!(canonical(&shown, shape), kept, "{rotation}");
        }
        // A layer recognized on a page shown at 90 is the same layer in page space as the one recognized upright.
        let side = displayed(&kept, turned);
        assert_eq!(canonical(&side, turned), kept);
    }

    #[test]
    fn a_crop_shifts_the_kept_layer() {
        let moved = shifted(&layer(), 5.0, -3.0);
        assert_eq!(moved.lines[0].words[0].rect, [15.0, 7.0, 65.0, 19.0]);
    }
}
