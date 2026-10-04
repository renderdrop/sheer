//! A fresh PDF from images (ADR-049 §3): one page per image, one image XObject each, `/Producer` only.

use std::fmt::Write as _;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use crate::content::image::{ImageAsset, Pixels};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::Rect;

/// One page: the stored image (`content::image` output), the page size and where the image sits, both in points. `place` is in the page's
/// user space (origin bottom left).
#[derive(Debug, Clone, PartialEq)]
pub struct ImagePage {
    pub image: ImageAsset,
    pub size_pt: [f32; 2],
    pub place: Rect,
}

fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

fn real(value: f32) -> Object {
    Object::Real(value)
}

fn image_object(doc: &mut Document, asset: &ImageAsset) -> ObjectId {
    let base = |space: &str, filter: &str| {
        let mut dict = Dictionary::new();
        dict.set("Type", name("XObject"));
        dict.set("Subtype", name("Image"));
        dict.set("Width", i64::from(asset.width));
        dict.set("Height", i64::from(asset.height));
        dict.set("ColorSpace", name(space));
        dict.set("BitsPerComponent", 8);
        dict.set("Filter", name(filter));
        dict
    };
    match &asset.pixels {
        Pixels::Jpeg(bytes) => {
            doc.add_object(Stream::new(base("DeviceRGB", "DCTDecode"), bytes.clone()))
        }
        Pixels::Flate { rgb, alpha } => {
            let mask = doc.add_object(Stream::new(
                base("DeviceGray", "FlateDecode"),
                alpha.clone(),
            ));
            let mut dict = base("DeviceRGB", "FlateDecode");
            dict.set("SMask", Object::Reference(mask));
            doc.add_object(Stream::new(dict, rgb.clone()))
        }
    }
}

/// Writes the document: `pages` in order, `producer` as the only entry of the information dictionary. Page sizes are clamped to the
/// page limits, a page whose numbers are not finite is refused.
pub fn build(pages: &[ImagePage], producer: &str) -> Result<Vec<u8>, AppError> {
    if pages.is_empty() || pages.len() > limits::MAX_IMAGES_PER_PDF {
        return Err(AppError::invalid("image"));
    }
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();
    let mut kids = Vec::with_capacity(pages.len());
    for page in pages {
        let numbers = [
            page.size_pt[0],
            page.size_pt[1],
            page.place.x,
            page.place.y,
            page.place.w,
            page.place.h,
        ];
        if numbers.iter().any(|n| !n.is_finite()) {
            return Err(AppError::invalid("image"));
        }
        let [width, height] = limits::sanitize_page_size(page.size_pt[0], page.size_pt[1]);
        let image = image_object(&mut doc, &page.image);
        let mut ops = String::new();
        let _ = writeln!(
            ops,
            "q {} 0 0 {} {} {} cm /Im0 Do Q\n",
            page.place.w, page.place.h, page.place.x, page.place.y
        );
        let content = doc.add_object(Stream::new(Dictionary::new(), ops.into_bytes()));
        let mut xobjects = Dictionary::new();
        xobjects.set("Im0", Object::Reference(image));
        let mut resources = Dictionary::new();
        resources.set("XObject", Object::Dictionary(xobjects));
        let mut dict = Dictionary::new();
        dict.set("Type", name("Page"));
        dict.set("Parent", Object::Reference(tree));
        dict.set(
            "MediaBox",
            vec![0.into(), 0.into(), real(width), real(height)],
        );
        dict.set("Resources", Object::Dictionary(resources));
        dict.set("Contents", Object::Reference(content));
        kids.push(Object::Reference(doc.add_object(Object::Dictionary(dict))));
    }
    let mut tree_dict = Dictionary::new();
    tree_dict.set("Type", name("Pages"));
    tree_dict.set("Count", i64::try_from(kids.len()).unwrap_or(0));
    tree_dict.set("Kids", Object::Array(kids));
    doc.objects.insert(tree, Object::Dictionary(tree_dict));
    let mut catalog = Dictionary::new();
    catalog.set("Type", name("Catalog"));
    catalog.set("Pages", Object::Reference(tree));
    let root = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(root));
    let mut info = Dictionary::new();
    info.set(
        "Producer",
        Object::string_literal(producer.as_bytes().to_vec()),
    );
    let info = doc.add_object(Object::Dictionary(info));
    doc.trailer.set("Info", Object::Reference(info));
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("images pdf: {error}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(alpha: bool) -> ImageAsset {
        ImageAsset {
            width: 2,
            height: 1,
            pixels: if alpha {
                Pixels::Flate {
                    rgb: vec![1, 2, 3],
                    alpha: vec![4],
                }
            } else {
                Pixels::Jpeg(vec![0xFF, 0xD8, 0xFF, 0xD9])
            },
        }
    }

    fn page(alpha: bool) -> ImagePage {
        ImagePage {
            image: asset(alpha),
            size_pt: [200.0, 100.0],
            place: Rect {
                x: 10.0,
                y: 10.0,
                w: 180.0,
                h: 80.0,
            },
        }
    }

    #[test]
    fn writes_pages_in_order_with_only_a_producer() {
        let bytes = build(&[page(false), page(true)], "Sheer").unwrap();
        let doc = crate::pdfwrite::produce::load(&bytes).unwrap().doc;
        assert_eq!(doc.get_pages().len(), 2);
        let info = doc
            .trailer
            .get(b"Info")
            .and_then(Object::as_reference)
            .unwrap();
        let info = doc.get_dictionary(info).unwrap();
        assert_eq!(info.len(), 1);
        assert_eq!(info.get(b"Producer").unwrap().as_str().unwrap(), b"Sheer");
        let smasks = doc
            .objects
            .values()
            .filter(|o| matches!(o, Object::Stream(s) if s.dict.has(b"SMask")))
            .count();
        assert_eq!(smasks, 1);
    }

    #[test]
    fn refuses_nothing_and_nonsense() {
        assert!(build(&[], "Sheer").is_err());
        let mut bad = page(false);
        bad.place.w = f32::NAN;
        assert!(build(&[bad], "Sheer").is_err());
    }

    #[test]
    fn the_page_size_is_clamped() {
        let mut huge = page(false);
        huge.size_pt = [100_000.0, 10.0];
        let bytes = build(&[huge], "Sheer").unwrap();
        let doc = crate::pdfwrite::produce::load(&bytes).unwrap().doc;
        let (_, id) = doc.get_pages().into_iter().next().unwrap();
        let media = doc.get_dictionary(id).unwrap().get(b"MediaBox").unwrap();
        let media = media.as_array().unwrap();
        assert_eq!(media[2].as_float().unwrap(), limits::MAX_PAGE_SIDE_PT);
        assert_eq!(media[3].as_float().unwrap(), 10.0);
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use crate::documents::image_batch::sort_drop;
    use crate::storage::atomic::testutil::TempDir;
    use image::codecs::jpeg::JpegEncoder;
    use image::ExtendedColorType;

    fn jpeg(width: u32, height: u32, gray: bool, exif_orientation: Option<u8>) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut out, 85);
        if gray {
            let px: Vec<u8> = (0..width * height).map(|i| (i % 256) as u8).collect();
            encoder
                .encode(&px, width, height, ExtendedColorType::L8)
                .unwrap();
        } else {
            let px: Vec<u8> = (0..width * height * 3).map(|i| (i % 253) as u8).collect();
            encoder
                .encode(&px, width, height, ExtendedColorType::Rgb8)
                .unwrap();
        }
        if let Some(o) = exif_orientation {
            // APP1 Exif with one IFD0 entry (orientation), inserted right after SOI.
            let mut tiff = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
            tiff.extend_from_slice(&[0, o, 0, 0, 0, 0, 0, 0]);
            let mut seg = vec![0xFF, 0xE1];
            let len = u16::try_from(2 + 6 + tiff.len()).unwrap();
            seg.extend_from_slice(&len.to_be_bytes());
            seg.extend_from_slice(b"Exif\0\0");
            seg.extend_from_slice(&tiff);
            out.splice(2..2, seg);
        }
        out
    }

    #[test]
    fn ten_mixed_jpegs_read_concurrently_make_ten_pages() {
        let dir = TempDir::new();
        let specs = [
            (4000, 3000, false, None),
            (640, 480, false, Some(6)),
            (100, 300, true, None),
            (1920, 1080, false, Some(3)),
            (50, 50, false, None),
            (3000, 4000, false, Some(8)),
            (800, 800, true, None),
            (1200, 900, false, None),
            (4000, 2000, false, None),
            (321, 123, false, Some(6)),
        ];
        let paths: Vec<_> = specs
            .iter()
            .enumerate()
            .map(|(i, &(w, h, g, o))| {
                let path = dir.path().join(format!("p{i:02}.jpg"));
                std::fs::write(&path, jpeg(w, h, g, o)).unwrap();
                path
            })
            .collect();
        let sorted = sort_drop(paths);
        assert_eq!(sorted.images.len(), 10);
        let images = &sorted.images;
        // Previews, the list and the job read the same handles at the same time.
        let pages: Vec<ImagePage> = std::thread::scope(|scope| {
            for image in images {
                scope.spawn(move || {
                    let _ = image.declared_size();
                    let bytes = image.read_limited(limits::MAX_IMAGE_FILE_BYTES).unwrap();
                    crate::content::image::prepare_bytes(&bytes).unwrap();
                });
            }
            images
                .iter()
                .map(|image| {
                    let bytes = image.read_limited(limits::MAX_IMAGE_FILE_BYTES).unwrap();
                    let asset = crate::content::image::prepare_bytes(&bytes).unwrap();
                    ImagePage {
                        image: asset,
                        size_pt: [595.0, 842.0],
                        place: Rect {
                            x: 0.0,
                            y: 0.0,
                            w: 100.0,
                            h: 100.0,
                        },
                    }
                })
                .collect()
        });
        // EXIF orientation 6 turns 640x480 into 480x640.
        assert_eq!((pages[1].image.width, pages[1].image.height), (480, 640));
        assert_eq!(pages[0].image.width, 4000);
        let bytes = build(&pages, "Sheer").unwrap();
        let doc = crate::pdfwrite::produce::load(&bytes).unwrap().doc;
        assert_eq!(doc.get_pages().len(), 10);
        let streams = doc
            .objects
            .values()
            .filter(|o| matches!(o, Object::Stream(s) if s.dict.has(b"Subtype")))
            .count();
        assert_eq!(streams, 10);
    }
}
