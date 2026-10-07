//! The lopdf side of the OCR probe and of the spike's test material (ADR-134 item 5, phase 1): how much of a page's box images cover and
//! at which resolution, the geometry of a page, a `/Rotate 90` copy of a page, and an image-only PDF made from gray bitmaps.

use std::collections::BTreeMap;

use lopdf::{dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::ocr_layer::{page_geom, PageGeom};
use crate::error::{AppError, ErrorCode};

/// The most decompressed bytes of a page's content the probe reads.
const MAX_CONTENT: usize = 256 * 1024 * 1024;
/// How deep Form XObjects are followed, and how many forms one page may enter (a form can draw itself many times).
const MAX_FORM_DEPTH: u32 = 4;
const MAX_FORMS: u32 = 256;

/// How much of a page's box image XObjects cover, and the effective resolution of the largest one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageCover {
    pub fraction: f32,
    pub eff_dpi: f32,
}

/// A document opened for probing: the geometry and the image cover of its pages by file index.
pub struct ProbeDoc {
    doc: Document,
    pages: BTreeMap<u32, ObjectId>,
}

fn failed(what: &str) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("ocr probe: {what}"))
}

type Matrix = [f32; 6];

/// `m` applied first, then `n` (PDF: CTM' = M x CTM).
fn mul(m: Matrix, n: Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

impl ProbeDoc {
    pub fn load(bytes: &[u8]) -> Result<Self, AppError> {
        let doc = super::load_untrusted(bytes)?;
        let pages = doc.get_pages();
        Ok(Self { doc, pages })
    }

    pub fn page_count(&self) -> u32 {
        self.pages.len() as u32
    }

    /// What the text scan finds on page `index` (file order, from 0); `None` for a page the file does not have.
    pub fn text_facts(&self, index: u32) -> Option<TextFacts> {
        let id = *self.pages.get(&index.checked_add(1)?)?;
        Some(page_text_facts(&self.doc, id))
    }

    /// The crop box and rotation of page `index` (file order, from 0).
    pub fn geom(&self, index: u32) -> Option<PageGeom> {
        let id = *self.pages.get(&index.checked_add(1)?)?;
        Some(page_geom(&self.doc, id))
    }

    /// Image XObjects under the page's CTM (bounding boxes, summed, clipped to the box), also those inside Form XObjects (a scan that a
    /// scanner or a PDF printer wraps in a form), followed to a depth of [`MAX_FORM_DEPTH`] with a bounded number of forms and
    /// decompressed bytes. Inline images are not followed.
    pub fn cover(&self, index: u32) -> ImageCover {
        let none = ImageCover {
            fraction: 0.0,
            eff_dpi: 0.0,
        };
        let (Some(geom), Some(page)) = (
            self.geom(index),
            index
                .checked_add(1)
                .and_then(|n| self.pages.get(&n))
                .copied(),
        ) else {
            return none;
        };
        let doc = &self.doc;
        let Ok(bytes) = doc.get_page_content_with_limit(page, MAX_CONTENT) else {
            return none;
        };
        let Ok((resources, ids)) = doc.get_page_resources(page) else {
            return none;
        };
        let mut xobjects: Option<Dictionary> = None;
        for d in resources
            .into_iter()
            .chain(ids.iter().filter_map(|i| doc.get_dictionary(*i).ok()))
        {
            if let Some(Ok((_, Object::Dictionary(x)))) =
                d.get(b"XObject").ok().map(|x| doc.dereference(x))
            {
                xobjects = Some(x.clone());
                break;
            }
        }
        let Some(xobjects) = xobjects else {
            return none;
        };
        let crop = geom.crop;
        let mut acc = Cover {
            crop,
            covered: 0.0,
            best_dpi: 0.0,
            best_area: 0.0,
            budget: MAX_CONTENT,
            forms: MAX_FORMS,
        };
        self.walk(
            &bytes,
            &xobjects,
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            0,
            &mut acc,
        );
        let area = (crop[2] - crop[0]) * (crop[3] - crop[1]);
        ImageCover {
            fraction: if area > 0.0 {
                (acc.covered / area).min(1.0)
            } else {
                0.0
            },
            eff_dpi: acc.best_dpi,
        }
    }

    /// The `Do` operators of `bytes` under `start`, images added to `acc`, forms entered with their own matrix and resources.
    fn walk(
        &self,
        bytes: &[u8],
        xobjects: &Dictionary,
        start: Matrix,
        depth: u32,
        acc: &mut Cover,
    ) {
        let doc = &self.doc;
        let Ok(content) = lopdf::content::Content::decode(bytes) else {
            return;
        };
        let mut ctm = start;
        let mut stack: Vec<Matrix> = Vec::new();
        for op in &content.operations {
            match op.operator.as_str() {
                "q" => stack.push(ctm),
                "Q" => ctm = stack.pop().unwrap_or(ctm),
                "cm" => {
                    let v: Vec<f32> = op
                        .operands
                        .iter()
                        .filter_map(|o| o.as_float().ok())
                        .collect();
                    if let [a, b, c, d, e, f] = v[..] {
                        ctm = mul([a, b, c, d, e, f], ctm);
                    }
                }
                "Do" => {
                    let Some(Object::Name(name)) = op.operands.first() else {
                        continue;
                    };
                    let Some(Ok((_, Object::Stream(xobject)))) =
                        xobjects.get(name).ok().map(|o| doc.dereference(o))
                    else {
                        continue;
                    };
                    let subtype = xobject
                        .dict
                        .get(b"Subtype")
                        .ok()
                        .and_then(|o| o.as_name().ok());
                    if subtype == Some(b"Form".as_slice()) {
                        self.enter_form(xobject, xobjects, ctm, depth, acc);
                        continue;
                    }
                    if subtype != Some(b"Image".as_slice()) {
                        continue;
                    }
                    let px = |key: &[u8]| {
                        xobject
                            .dict
                            .get(key)
                            .ok()
                            .and_then(|o| o.as_float().ok())
                            .unwrap_or(0.0)
                    };
                    acc.add_image(ctm, px(b"Width"), px(b"Height"));
                }
                _ => {}
            }
        }
    }

    fn enter_form(
        &self,
        form: &Stream,
        outer: &Dictionary,
        ctm: Matrix,
        depth: u32,
        acc: &mut Cover,
    ) {
        if depth >= MAX_FORM_DEPTH || acc.forms == 0 {
            return;
        }
        acc.forms -= 1;
        let doc = &self.doc;
        let Ok(bytes) = form.decompressed_content_with_limit(acc.budget) else {
            return;
        };
        acc.budget = acc.budget.saturating_sub(bytes.len());
        let matrix = form
            .dict
            .get(b"Matrix")
            .ok()
            .and_then(|o| doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_array().ok())
            .map(|a| {
                a.iter()
                    .filter_map(|o| doc.dereference(o).ok().and_then(|(_, o)| o.as_float().ok()))
                    .collect::<Vec<f32>>()
            })
            .and_then(|v| <[f32; 6]>::try_from(v).ok())
            .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        // the form's own resources, else the ones it is drawn from
        let own = form
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|o| doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_dict().ok())
            .and_then(|r| r.get(b"XObject").ok())
            .and_then(|o| doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_dict().ok())
            .cloned();
        let xobjects = own.as_ref().unwrap_or(outer);
        self.walk(&bytes, xobjects, mul(matrix, ctm), depth + 1, acc);
    }
}

/// The running sums of a cover walk.
struct Cover {
    crop: [f32; 4],
    covered: f32,
    best_dpi: f32,
    best_area: f32,
    /// Decompressed bytes of forms still allowed.
    budget: usize,
    /// Forms still allowed to be entered.
    forms: u32,
}

impl Cover {
    /// An `iw` x `ih` pixel image drawn on the unit square under `ctm`.
    fn add_image(&mut self, ctm: Matrix, iw: f32, ih: f32) {
        if !ctm.iter().all(|v| v.is_finite()) {
            return;
        }
        let crop = self.crop;
        let corners = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].map(|(x, y): (f32, f32)| {
            (
                x * ctm[0] + y * ctm[2] + ctm[4],
                x * ctm[1] + y * ctm[3] + ctm[5],
            )
        });
        let lo = |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::MAX, f32::min);
        let hi = |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::MIN, f32::max);
        let (x0, x1) = (lo(|c| c.0).max(crop[0]), hi(|c| c.0).min(crop[2]));
        let (y0, y1) = (lo(|c| c.1).max(crop[1]), hi(|c| c.1).min(crop[3]));
        if x1 > x0 && y1 > y0 {
            let a = (x1 - x0) * (y1 - y0);
            self.covered += a;
            let full = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
            if a > self.best_area && full > 1.0 {
                self.best_area = a;
                self.best_dpi = 72.0 * (iw * ih / full).sqrt();
            }
        }
    }
}

/// A copy of `original` whose page `index` (rotation 0) is `/Rotate 90` on a box that is landscape in user space, its content turned so
/// that the displayed page is the same upright page: displayed (dx, dy) is user (dy, dx). Incremental, so the original is a prefix.
pub fn rotated_copy(original: &[u8], index: u32) -> Result<Vec<u8>, AppError> {
    let doc = super::load_untrusted(original)?;
    let page = *doc
        .get_pages()
        .get(&index.saturating_add(1))
        .ok_or_else(|| failed("page"))?;
    let geom = page_geom(&doc, page);
    let mut dict = doc
        .get_dictionary(page)
        .map_err(|_| failed("page dictionary"))?
        .clone();
    let (w, h) = geom.size();
    let mut inc = IncrementalDocument::create_from(original.to_vec(), doc);
    let prev = inc.get_prev_documents();
    let contents: Vec<Object> = match dict.get(b"Contents") {
        Ok(Object::Reference(id)) => match prev.get_object(*id) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Ok(Object::Array(a)) => a.clone(),
        _ => return Err(failed("contents")),
    };
    // u = y1 - y, v = x - x0  ->  [a b c d e f] = [0 1 -1 0 y1 -x0]
    let head = format!("q 0 1 -1 0 {} {} cm\n", geom.crop[3], -geom.crop[0]);
    let a = inc
        .new_document
        .add_object(Stream::new(Dictionary::new(), head.into_bytes()));
    let b = inc
        .new_document
        .add_object(Stream::new(Dictionary::new(), b"Q\n".to_vec()));
    let mut all = vec![Object::Reference(a)];
    all.extend(contents);
    all.push(Object::Reference(b));
    dict.set("Contents", Object::Array(all));
    dict.set(
        "MediaBox",
        Object::Array(vec![0.into(), 0.into(), Object::Real(h), Object::Real(w)]),
    );
    dict.remove(b"CropBox");
    dict.set("Rotate", 90);
    inc.new_document.set_object(page, Object::Dictionary(dict));
    let mut out = Vec::new();
    inc.save_to(&mut out).map_err(|_| failed("save"))?;
    Ok(out)
}

/// One gray bitmap and the size in points of the page it fills.
pub struct ScanPage {
    pub size_pt: [f32; 2],
    pub px: [u32; 2],
    pub gray: Vec<u8>,
}

/// An image-only PDF, one page per bitmap, no text: what a scanner makes.
pub fn image_only_pdf(pages: &[ScanPage]) -> Result<Vec<u8>, AppError> {
    use std::io::Write;
    let mut out = Document::with_version("1.7");
    let tree = out.new_object_id();
    let mut kids = Vec::new();
    for p in pages {
        if p.gray.len() as u64 != u64::from(p.px[0]) * u64::from(p.px[1]) {
            return Err(failed("bitmap size"));
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(&p.gray).map_err(|_| failed("deflate"))?;
        let data = z.finish().map_err(|_| failed("deflate"))?;
        let image = out.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(p.px[0]), "Height" => i64::from(p.px[1]),
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "FlateDecode",
            },
            data,
        ));
        let content = out.add_object(Stream::new(
            Dictionary::new(),
            format!("q {} 0 0 {} 0 0 cm /Im0 Do Q\n", p.size_pt[0], p.size_pt[1]).into_bytes(),
        ));
        let page = out.add_object(dictionary! {
            "Type" => "Page", "Parent" => tree,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(p.size_pt[0]), Object::Real(p.size_pt[1])],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
            "Contents" => content,
        });
        kids.push(Object::Reference(page));
    }
    let n = kids.len() as i64;
    out.set_object(
        tree,
        dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n },
    );
    let catalog = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => tree });
    out.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    out.save_to(&mut bytes).map_err(|_| failed("save"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_only_page_is_covered_and_its_resolution_is_read() {
        // 300 x 400 px over 72 x 96 pt = 300 dpi
        let page = ScanPage {
            size_pt: [72.0, 96.0],
            px: [300, 400],
            gray: vec![255; 300 * 400],
        };
        let bytes = image_only_pdf(&[page]).unwrap();
        let doc = ProbeDoc::load(&bytes).unwrap();
        assert_eq!(doc.page_count(), 1);
        let cover = doc.cover(0);
        assert!(cover.fraction > 0.99, "{cover:?}");
        assert!((cover.eff_dpi - 300.0).abs() < 1.0, "{cover:?}");
        assert_eq!(doc.geom(0).map(|g| g.rotate), Some(0));
    }

    #[test]
    fn a_rotated_copy_is_incremental_and_rotated() {
        let page = ScanPage {
            size_pt: [72.0, 96.0],
            px: [30, 40],
            gray: vec![0; 30 * 40],
        };
        let original = image_only_pdf(&[page]).unwrap();
        let copy = rotated_copy(&original, 0).unwrap();
        assert_eq!(&copy[..original.len()], &original[..]);
        let doc = ProbeDoc::load(&copy).unwrap();
        let geom = doc.geom(0).unwrap();
        assert_eq!(geom.rotate, 90);
        assert_eq!(geom.crop, [0.0, 0.0, 96.0, 72.0]);
        assert_eq!(geom.display_size(), (72.0, 96.0));
        // the image still covers the page
        assert!(doc.cover(0).fraction > 0.99);
    }

    #[test]
    fn a_scan_inside_a_form_xobject_counts() {
        let mut doc = Document::with_version("1.7");
        let tree = doc.new_object_id();
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 300, "Height" => 400,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            vec![255; 300 * 400],
        ));
        // the form maps the unit square to 72 x 96 pt through its own matrix
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Matrix" => vec![72.into(), 0.into(), 0.into(), 96.into(), 0.into(), 0.into()],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
            },
            b"/Im0 Do\n".to_vec(),
        ));
        let content = doc.add_object(Stream::new(Dictionary::new(), b"q /Fm0 Do Q\n".to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => tree,
            "MediaBox" => vec![0.into(), 0.into(), 72.into(), 96.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Fm0" => form } },
            "Contents" => content,
        });
        doc.set_object(
            tree,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => tree });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let cover = ProbeDoc::load(&bytes).unwrap().cover(0);
        assert!(cover.fraction > 0.99, "{cover:?}");
        assert!((cover.eff_dpi - 300.0).abs() < 1.0, "{cover:?}");
    }

    #[test]
    fn a_bitmap_of_the_wrong_size_is_refused() {
        let page = ScanPage {
            size_pt: [1.0, 1.0],
            px: [2, 2],
            gray: vec![0; 3],
        };
        assert!(image_only_pdf(&[page]).is_err());
    }
}

/// The most decompressed bytes of a page's content the text scan reads.
const MAX_TEXT_CONTENT: usize = 64 * 1024 * 1024;

/// What the text scan of a page's content found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TextFacts {
    /// Non-blank bytes shown in a visible render mode.
    pub visible: usize,
    /// Non-blank bytes shown with `Tr` 3 (invisible) or 7 (invisible, clip): somebody else's OCR layer.
    pub invisible: usize,
    /// The page carries our `/SheerOcr` key (a layer of an earlier session, saved).
    pub sheer_key: bool,
}

/// The string bytes a text operator shows, `None` for operators that show nothing.
fn shown_bytes(operator: &str, operands: &[Object]) -> usize {
    let blank = |s: &[u8]| s.iter().filter(|b| **b > 0x20).count();
    match operator {
        "Tj" | "'" | "\"" => match operands.last() {
            Some(Object::String(s, _)) => blank(s),
            _ => 0,
        },
        "TJ" => match operands.first() {
            Some(Object::Array(items)) => items
                .iter()
                .map(|o| match o {
                    Object::String(s, _) => blank(s),
                    _ => 0,
                })
                .sum(),
            _ => 0,
        },
        _ => 0,
    }
}

/// Scans a page's own content (forms are not entered) for shown text by render mode.
fn page_text_facts(doc: &Document, page: ObjectId) -> TextFacts {
    let mut facts = TextFacts {
        sheer_key: doc
            .get_dictionary(page)
            .is_ok_and(|d| d.get(b"SheerOcr").is_ok()),
        ..TextFacts::default()
    };
    let Ok(bytes) = doc.get_page_content_with_limit(page, MAX_TEXT_CONTENT) else {
        return facts;
    };
    let Ok(content) = lopdf::content::Content::decode(&bytes) else {
        return facts;
    };
    // Tr belongs to the graphics state: q saves it, Q restores it.
    let mut mode: i64 = 0;
    let mut stack: Vec<i64> = Vec::new();
    for op in &content.operations {
        match op.operator.as_str() {
            "q" => stack.push(mode),
            "Q" => mode = stack.pop().unwrap_or(mode),
            "Tr" => {
                if let Some(Ok(m)) = op.operands.first().map(Object::as_i64) {
                    mode = m;
                }
            }
            other => {
                let n = shown_bytes(other, &op.operands);
                if n > 0 {
                    if matches!(mode, 3 | 7) {
                        facts.invisible += n;
                    } else {
                        facts.visible += n;
                    }
                }
            }
        }
    }
    facts
}

#[cfg(test)]
mod text_tests {
    use super::*;

    #[test]
    fn text_is_counted_by_render_mode_with_q_restoring_it() {
        use lopdf::content::Operation;
        use lopdf::dictionary;
        let ops = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tj", vec![Object::string_literal("abc de")]),
            Operation::new("q", vec![]),
            Operation::new("Tr", vec![3.into()]),
            Operation::new("Tj", vec![Object::string_literal("hidden")]),
            Operation::new("Q", vec![]),
            Operation::new("Tj", vec![Object::string_literal("xy")]),
            Operation::new("Tr", vec![7.into()]),
            Operation::new(
                "TJ",
                vec![Object::Array(vec![
                    Object::string_literal("ab"),
                    Object::Integer(-20),
                    Object::string_literal("c"),
                ])],
            ),
            Operation::new("ET", vec![]),
        ];
        let mut doc = Document::with_version("1.5");
        let content = lopdf::content::Content { operations: ops };
        let stream = lopdf::Stream::new(lopdf::Dictionary::new(), content.encode().unwrap());
        let cid = doc.add_object(stream);
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => cid,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            }),
        );
        let facts = page_text_facts(&doc, page);
        // "abcde" + "xy" visible (the Tr 3 is undone by Q); "hidden" + "abc" invisible.
        assert_eq!(
            facts,
            TextFacts {
                visible: 7,
                invisible: 9,
                sheer_key: false
            }
        );
    }
}
