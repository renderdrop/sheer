//! The lopdf side of the OCR probe and of the spike's test material (ADR-134 item 5, phase 1): how much of a page's box images cover and
//! at which resolution, the geometry of a page, a `/Rotate 90` copy of a page, and an image-only PDF made from gray bitmaps.

use std::collections::BTreeMap;

use lopdf::{dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::ocr_layer::{page_geom, PageGeom};
use crate::error::{AppError, ErrorCode};

/// The most decompressed bytes of a page's content the probe reads.
const MAX_CONTENT: usize = 256 * 1024 * 1024;

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

    /// The crop box and rotation of page `index` (file order, from 0).
    pub fn geom(&self, index: u32) -> Option<PageGeom> {
        let id = *self.pages.get(&index.checked_add(1)?)?;
        Some(page_geom(&self.doc, id))
    }

    /// Image XObjects under the page's CTM (bounding boxes, summed, clipped to the box). Form XObjects and inline images are not
    /// followed: a scan wrapped in a form reads as no cover (phase 2 does this in the engine's probe).
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
        let Ok(content) = lopdf::content::Content::decode(&bytes) else {
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
        let mut ctm: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut stack: Vec<Matrix> = Vec::new();
        let crop = geom.crop;
        let area = (crop[2] - crop[0]) * (crop[3] - crop[1]);
        let (mut covered, mut best_dpi, mut best_area) = (0.0f32, 0.0f32, 0.0f32);
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
                    let Some(Ok((_, Object::Stream(image)))) =
                        xobjects.get(name).ok().map(|o| doc.dereference(o))
                    else {
                        continue;
                    };
                    if image
                        .dict
                        .get(b"Subtype")
                        .ok()
                        .and_then(|o| o.as_name().ok())
                        != Some(b"Image".as_slice())
                    {
                        continue;
                    }
                    let px = |key: &[u8]| {
                        image
                            .dict
                            .get(key)
                            .ok()
                            .and_then(|o| o.as_float().ok())
                            .unwrap_or(0.0)
                    };
                    let (iw, ih) = (px(b"Width"), px(b"Height"));
                    let corners = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].map(
                        |(x, y): (f32, f32)| {
                            (
                                x * ctm[0] + y * ctm[2] + ctm[4],
                                x * ctm[1] + y * ctm[3] + ctm[5],
                            )
                        },
                    );
                    let lo =
                        |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::MAX, f32::min);
                    let hi =
                        |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::MIN, f32::max);
                    let (x0, x1) = (lo(|c| c.0).max(crop[0]), hi(|c| c.0).min(crop[2]));
                    let (y0, y1) = (lo(|c| c.1).max(crop[1]), hi(|c| c.1).min(crop[3]));
                    if x1 > x0 && y1 > y0 {
                        let a = (x1 - x0) * (y1 - y0);
                        covered += a;
                        let full = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
                        if a > best_area && full > 1.0 {
                            best_area = a;
                            best_dpi = 72.0 * (iw * ih / full).sqrt();
                        }
                    }
                }
                _ => {}
            }
        }
        ImageCover {
            fraction: if area > 0.0 {
                (covered / area).min(1.0)
            } else {
                0.0
            },
            eff_dpi: best_dpi,
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
    fn a_bitmap_of_the_wrong_size_is_refused() {
        let page = ScanPage {
            size_pt: [1.0, 1.0],
            px: [2, 2],
            gray: vec![0; 3],
        };
        assert!(image_only_pdf(&[page]).is_err());
    }
}
