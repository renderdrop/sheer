//! The one wrapper for every layer Sheer appends to a page's content (ARCHITECTURE §16.2): the invisible OCR text layer
//! (`/SheerOcr`, `ocr_layer`) and the header/footer layer (`/SHR_HF`, `header_footer`). A page that has them reads
//! `[q, original..., Q, ocr?, hf?]`; the original is wrapped once so that a stray `q` or `cm` in it cannot move the layers.
//!
//! [`split`] takes the layers of an earlier run apart from the original (only streams of our own shape, named by our own page keys,
//! at the end of `/Contents`), [`assemble`] puts the kept and the new ones back. Re-applying or removing one layer therefore never
//! duplicates or loses the other. Also here: the page geometry both writers need.

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

/// The largest coordinate or side of a page box (points); PDF viewers stop at 14 400, a box beyond this is hostile or broken and is
/// read as absent (the page then falls back to Letter).
const MAX_COORD: f32 = 200_000.0;
/// The most a stream of ours is decompressed to when its shape is checked.
const SHAPE_LIMIT: usize = 16 * 1024 * 1024;

/// The page key of the OCR layer and the first bytes of its stream.
pub const OCR_KEY: &[u8] = b"SheerOcr";
const OCR_HEAD: &[u8] = b"q\nBT\n3 Tr\n";
/// The page key of the header/footer layer and the first bytes of its stream.
pub const HF_KEY: &[u8] = b"SHR_HF";
pub const HF_HEAD: &[u8] = b"q\n/Artifact << /Type /Pagination /SHR_HF true >> BDC\n";

/// Where a page is in user space: its crop box `[x0, y0, x1, y1]` and its `/Rotate` (0, 90, 180, 270).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeom {
    pub crop: [f32; 4],
    pub rotate: u16,
}

impl PageGeom {
    /// The size of the unrotated page (the crop box).
    pub fn size(&self) -> (f32, f32) {
        (self.crop[2] - self.crop[0], self.crop[3] - self.crop[1])
    }

    /// The size of the page as it is shown.
    pub fn display_size(&self) -> (f32, f32) {
        let (w, h) = self.size();
        if self.rotate % 180 == 90 {
            (h, w)
        } else {
            (w, h)
        }
    }

    /// A point of the displayed page (points from the top left, y down) in user space.
    pub fn display_to_user(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (w, h) = self.size();
        let [x0, y0, ..] = self.crop;
        match self.rotate % 360 {
            90 => (x0 + dy, y0 + dx),
            180 => (x0 + w - dx, y0 + dy),
            270 => (x0 + w - dy, y0 + h - dx),
            _ => (x0 + dx, y0 + h - dy),
        }
    }

    /// A point of the displayed page in the page space of the engine (ADR-003: top left of the unrotated crop box, y down).
    pub fn display_to_page(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (ux, uy) = self.display_to_user(dx, dy);
        (ux - self.crop[0], self.crop[3] - uy)
    }

    /// The directions of the displayed x axis and of "up" in user space; they make the rows of the text matrix.
    pub fn axes(&self) -> ([f32; 2], [f32; 2]) {
        match self.rotate % 360 {
            90 => ([0.0, 1.0], [-1.0, 0.0]),
            180 => ([-1.0, 0.0], [0.0, -1.0]),
            270 => ([0.0, -1.0], [1.0, 0.0]),
            _ => ([1.0, 0.0], [0.0, 1.0]),
        }
    }
}

/// A number as short PDF text (three decimals at most); not finite is `0`.
pub fn num(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" {
        "0".into()
    } else {
        s.to_owned()
    }
}

fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..64 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, v)| v);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn read_box(doc: &Document, object: &Object) -> Option<[f32; 4]> {
    let array = object.as_array().ok()?;
    if array.len() != 4 {
        return None;
    }
    let mut v = [0.0f32; 4];
    for (slot, item) in v.iter_mut().zip(array) {
        let n = doc.dereference(item).ok()?.1.as_float().ok()?;
        if !n.is_finite() || n.abs() > MAX_COORD {
            return None;
        }
        *slot = n;
    }
    let r = [
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ];
    (r[2] > r[0] && r[3] > r[1] && r[2] - r[0] <= MAX_COORD && r[3] - r[1] <= MAX_COORD)
        .then_some(r)
}

/// The crop box inside the media box and the `/Rotate` of `page`.
pub fn page_geom(doc: &Document, page: ObjectId) -> PageGeom {
    let media = inherited(doc, page, b"MediaBox")
        .and_then(|o| read_box(doc, o))
        .unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = inherited(doc, page, b"CropBox")
        .and_then(|o| read_box(doc, o))
        .map(|c| {
            [
                c[0].max(media[0]),
                c[1].max(media[1]),
                c[2].min(media[2]),
                c[3].min(media[3]),
            ]
        })
        .filter(|c| c[2] > c[0] && c[3] > c[1])
        .unwrap_or(media);
    let rotate = inherited(doc, page, b"Rotate")
        .and_then(|o| o.as_i64().ok())
        .map_or(0, |r| r.rem_euclid(360) as u16);
    PageGeom {
        crop,
        rotate: rotate - rotate % 90,
    }
}

/// The page's `/Contents` as a list of references.
pub fn content_refs(doc: &Document, page: &Dictionary) -> Vec<Object> {
    let Ok(contents) = page.get(b"Contents") else {
        return Vec::new();
    };
    match contents {
        Object::Reference(id) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Object::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// The content of a stream as plain bytes (decompressed when it has a filter, bounded); `None` if that fails.
fn plain(stream: &Stream) -> Option<Vec<u8>> {
    if stream.dict.has(b"Filter") {
        stream.decompressed_content_with_limit(SHAPE_LIMIT).ok()
    } else {
        Some(stream.content.clone())
    }
}

/// Whether `item` is a stream with exactly `body` as its content.
fn is_stream_of(doc: &Document, item: &Object, body: &[u8]) -> bool {
    let Object::Reference(id) = item else {
        return false;
    };
    doc.get_object(*id)
        .ok()
        .and_then(|o| o.as_stream().ok())
        .and_then(plain)
        .is_some_and(|c| c == body)
}

/// The stream a page key of ours (`/SheerOcr`, `/SHR_HF`) names in `/S`, when it is a stream that starts like ours: a hostile key must
/// not make a writer drop real page content.
fn own_layer(doc: &Document, page: &Dictionary, key: &[u8], head: &[u8]) -> Option<ObjectId> {
    let id = page
        .get(key)
        .ok()
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok())
        .and_then(|d| d.get(b"S").ok())
        .and_then(|o| o.as_reference().ok())?;
    let stream = doc.get_object(id).ok()?.as_stream().ok()?;
    plain(stream)?.starts_with(head).then_some(id)
}

/// The header/footer layer stream of `page`, if it has one of our shape (`ops_walk` leaves it out of the text it walks).
pub fn own_header_layer(doc: &Document, page: &Dictionary) -> Option<ObjectId> {
    own_layer(doc, page, HF_KEY, HF_HEAD)
}

/// A page's content taken apart: what is the original, and which layers of ours it carries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Split {
    /// The original contents (without our wrap and layers). A page that has no layer of ours is returned whole.
    pub base: Vec<Object>,
    /// The OCR layer stream of an earlier run.
    pub ocr: Option<ObjectId>,
    /// The header/footer layer stream of an earlier run.
    pub hf: Option<ObjectId>,
}

/// Takes `page`'s `/Contents` apart (see [`Split`]): our layers are the streams `/SheerOcr /S` and `/SHR_HF /S` name, if they are of
/// our shape and at the end of the contents; then the `q` and `Q` streams that wrapped the original around them go too. Contents of
/// another shape are returned as they are, with no layer.
pub fn split(doc: &Document, page: &Dictionary) -> Split {
    let mut refs = content_refs(doc, page);
    let ocr = own_layer(doc, page, OCR_KEY, OCR_HEAD);
    let hf = own_layer(doc, page, HF_KEY, HF_HEAD);
    let (mut found_ocr, mut found_hf) = (None, None);
    while let Some(Object::Reference(last)) = refs.last() {
        let last = *last;
        if found_ocr.is_none() && ocr == Some(last) {
            found_ocr = ocr;
        } else if found_hf.is_none() && hf == Some(last) {
            found_hf = hf;
        } else {
            break;
        }
        refs.pop();
    }
    if found_ocr.is_none() && found_hf.is_none() {
        return Split {
            base: refs,
            ..Split::default()
        };
    }
    if refs.len() >= 2
        && is_stream_of(doc, &refs[0], b"q\n")
        && is_stream_of(doc, &refs[refs.len() - 1], b"Q\n")
    {
        refs.pop();
        refs.remove(0);
    }
    Split {
        base: refs,
        ocr: found_ocr,
        hf: found_hf,
    }
}

/// The two streams that wrap the original (`q` and `Q`), added once for all pages of an update.
#[derive(Debug, Clone, Copy)]
pub struct Wrap {
    open: ObjectId,
    close: ObjectId,
}

impl Wrap {
    pub fn add(inc: &mut IncrementalDocument) -> Self {
        let open = inc
            .new_document
            .add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
        let close = inc
            .new_document
            .add_object(Stream::new(Dictionary::new(), b"Q\n".to_vec()));
        Self { open, close }
    }
}

/// `[q, base..., Q, ocr?, hf?]`; with no layer left, the original alone.
pub fn assemble(
    base: Vec<Object>,
    wrap: Wrap,
    ocr: Option<ObjectId>,
    hf: Option<ObjectId>,
) -> Vec<Object> {
    if ocr.is_none() && hf.is_none() {
        return base;
    }
    let mut contents = Vec::with_capacity(base.len() + 4);
    contents.push(Object::Reference(wrap.open));
    contents.extend(base);
    contents.push(Object::Reference(wrap.close));
    contents.extend(ocr.map(Object::Reference));
    contents.extend(hf.map(Object::Reference));
    contents
}

/// A page-local copy of the resources with `font` added under `name` (the inherited or shared dictionary stays as it is).
pub fn resources_with_font(
    doc: &Document,
    page: ObjectId,
    name: &str,
    font: ObjectId,
) -> Dictionary {
    let mut resources = inherited(doc, page, b"Resources")
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let mut fonts = resources
        .get(b"Font")
        .ok()
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    fonts.set(name, Object::Reference(font));
    resources.set("Font", Object::Dictionary(fonts));
    resources
}
