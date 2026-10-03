//! Compress (ADR-036 §6): a full rewrite that prunes what nothing reaches, shares identical streams, Flate-compresses streams that
//! are stored plain and, for the named presets, re-encodes big images as JPEG at the resolution the page needs. Pure functions on
//! bytes (no PDFium, no files).
//!
//! Only images that are safe to change are touched: 8 bit DeviceGray/DeviceRGB (or ICC with 1/3 components) with a single `DCTDecode`
//! or plain `FlateDecode` filter, no stencil mask, no explicit mask, no `/Decode`. Soft masks stay. JPX, JBIG2, CCITT, Indexed, CMYK,
//! 16 bit and predictor-coded images stay as they are. A re-encoded image replaces the original only if it is smaller.
//!
//! JPEG decoding is `image` with the format fixed (nothing else is ever decoded) and `image::Limits`; Flate decoding stops at a fixed
//! output size. Every image is looked at on its own: one that cannot be decoded is left alone, never an error.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Read, Write};
use std::time::{Duration, Instant};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageBuffer, ImageFormat, ImageReader, Luma, Rgb};
use lopdf::{Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};

use super::produce::{load, Control, Parsed, Phase, Warning};
use super::save::validate;
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// How hard to compress. The wire name is the lower-case word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    /// Nothing is re-encoded.
    Lossless,
    /// 220 dpi, JPEG quality 85.
    Print,
    /// 150 dpi, quality 70.
    Ebook,
    /// 96 dpi, quality 55.
    Screen,
}

impl Preset {
    pub const ALL: [Preset; 4] = [
        Preset::Lossless,
        Preset::Print,
        Preset::Ebook,
        Preset::Screen,
    ];

    /// Pixels per inch and JPEG quality of the images; `None` leaves the images alone.
    pub const fn target(self) -> Option<(u32, u8)> {
        match self {
            Preset::Lossless => None,
            Preset::Print => Some((220, 85)),
            Preset::Ebook => Some((150, 70)),
            Preset::Screen => Some((96, 55)),
        }
    }
}

/// The compressed file.
#[derive(Debug)]
pub struct Compressed {
    pub bytes: Vec<u8>,
    pub pages: u32,
    pub images: u32,
    pub warnings: Vec<Warning>,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

// --- Images -------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Jpeg,
    Flate,
}

/// An image that may be re-encoded, and how big its biggest use is.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    id: ObjectId,
    width: u32,
    height: u32,
    comps: u8,
    encoding: Encoding,
    encoded_len: usize,
    /// The longer side of the largest page that shows it, in points.
    page_long_side_pt: f32,
}

/// A re-encoded image.
struct Recoded {
    content: Vec<u8>,
    width: u32,
    height: u32,
}

fn name_is(object: Option<&Object>, wanted: &[u8]) -> bool {
    object
        .and_then(|object| object.as_name().ok())
        .is_some_and(|name| name == wanted)
}

fn page_long_side(doc: &Document, page: ObjectId) -> f32 {
    let mut current = Some(page);
    let mut seen = HashSet::new();
    for _ in 0..limits::MAX_PARENT_CHAIN {
        let Some(id) = current else { break };
        if !seen.insert(id) {
            break;
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Ok(array) = dict.get_deref(b"MediaBox", doc).and_then(Object::as_array) {
            let numbers: Vec<f32> = array
                .iter()
                .filter_map(|value| doc.dereference(value).ok()?.1.as_float().ok())
                .collect();
            if let [x1, y1, x2, y2] = numbers[..] {
                let side = (x2 - x1).abs().max((y2 - y1).abs());
                if side.is_finite() && side >= 1.0 {
                    return side.min(limits::MAX_PAGE_SIDE_PT);
                }
            }
            break;
        }
        current = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }
    limits::DEFAULT_PAGE_SIZE_PT[1]
}

/// Records the images of `resources` and of the forms it names, each with the longest page side it was found under.
fn walk_resources(
    doc: &Document,
    resources: Option<&Object>,
    long_side: f32,
    depth: usize,
    images: &mut HashMap<ObjectId, f32>,
    forms: &mut HashMap<ObjectId, f32>,
) {
    let Some(resources) = resources
        .and_then(|r| doc.dereference(r).ok())
        .and_then(|(_, r)| r.as_dict().ok())
    else {
        return;
    };
    let Some(xobjects) = resources
        .get_deref(b"XObject", doc)
        .ok()
        .and_then(|x| x.as_dict().ok())
    else {
        return;
    };
    for (_, value) in xobjects.iter() {
        let Ok(id) = value.as_reference() else {
            continue;
        };
        let Some(stream) = doc.get_object(id).ok().and_then(|o| o.as_stream().ok()) else {
            continue;
        };
        let subtype = stream.dict.get(b"Subtype").ok();
        if name_is(subtype, b"Image") {
            let best = images.entry(id).or_insert(0.0);
            *best = best.max(long_side);
        } else if name_is(subtype, b"Form") && depth < 4 {
            let seen = forms.get(&id).copied().unwrap_or(0.0);
            if long_side > seen {
                forms.insert(id, long_side);
                walk_resources(
                    doc,
                    stream.dict.get(b"Resources").ok(),
                    long_side,
                    depth + 1,
                    images,
                    forms,
                );
            }
        }
    }
}

fn component_count(doc: &Document, space: &Object) -> Option<u8> {
    match doc.dereference(space).ok()?.1 {
        Object::Name(name) if name == b"DeviceGray" => Some(1),
        Object::Name(name) if name == b"DeviceRGB" => Some(3),
        Object::Array(items) => {
            let first = doc.dereference(items.first()?).ok()?.1;
            if !name_is(Some(first), b"ICCBased") {
                return None;
            }
            let profile = doc.dereference(items.get(1)?).ok()?.1.as_stream().ok()?;
            match profile.dict.get(b"N").ok()?.as_i64().ok()? {
                1 => Some(1),
                3 => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Whether the image can be re-encoded, and as what it is stored. See the module documentation.
fn describe(doc: &Document, id: ObjectId, page_long_side_pt: f32) -> Option<Candidate> {
    let stream = doc.get_object(id).ok()?.as_stream().ok()?;
    let dict = &stream.dict;
    if !name_is(dict.get(b"Subtype").ok(), b"Image")
        || dict.has(b"Mask")
        || dict.has(b"Decode")
        || dict
            .get(b"ImageMask")
            .ok()
            .and_then(|v| v.as_bool().ok())
            .unwrap_or(false)
    {
        return None;
    }
    if dict.get(b"BitsPerComponent").ok()?.as_i64().ok()? != 8 {
        return None;
    }
    let side = |key: &[u8]| -> Option<u32> {
        let value = u32::try_from(dict.get(key).ok()?.as_i64().ok()?).ok()?;
        (1..=limits::MAX_IMAGE_SIDE_PX)
            .contains(&value)
            .then_some(value)
    };
    let (width, height) = (side(b"Width")?, side(b"Height")?);
    if u64::from(width) * u64::from(height) > limits::MAX_IMAGE_PIXELS {
        return None;
    }
    let comps = component_count(doc, dict.get(b"ColorSpace").ok()?)?;
    let filters = stream.filters().ok()?;
    let [filter] = filters[..] else { return None };
    let encoding = match filter {
        b"DCTDecode" => Encoding::Jpeg,
        b"FlateDecode" => Encoding::Flate,
        _ => return None,
    };
    if let Ok(params) = dict.get(b"DecodeParms") {
        let params = doc.dereference(params).ok()?.1;
        let params = match params {
            Object::Array(items) if items.len() == 1 => doc.dereference(items.first()?).ok()?.1,
            other => other,
        };
        match params {
            Object::Null => {}
            Object::Dictionary(params) if encoding == Encoding::Flate => {
                let predictor = params
                    .get(b"Predictor")
                    .ok()
                    .and_then(|p| p.as_i64().ok())
                    .unwrap_or(1);
                if predictor > 1 {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(Candidate {
        id,
        width,
        height,
        comps,
        encoding,
        encoded_len: stream.content.len(),
        page_long_side_pt,
    })
}

/// The images of the document that may be re-encoded, in object order.
fn candidates(parsed: &Parsed) -> Vec<Candidate> {
    let doc = &parsed.doc;
    let mut images: HashMap<ObjectId, f32> = HashMap::new();
    let mut forms: HashMap<ObjectId, f32> = HashMap::new();
    for &page in &parsed.pages {
        let long_side = page_long_side(doc, page);
        // The page's own resources, else the ones it inherits.
        let mut resources = None;
        let mut current = Some(page);
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id) || seen.len() > limits::MAX_PARENT_CHAIN {
                break;
            }
            let Ok(dict) = doc.get_dictionary(id) else {
                break;
            };
            if let Ok(found) = dict.get(b"Resources") {
                resources = Some(found);
                break;
            }
            current = dict.get(b"Parent").and_then(Object::as_reference).ok();
        }
        walk_resources(doc, resources, long_side, 0, &mut images, &mut forms);
    }
    let ordered: BTreeMap<ObjectId, f32> = images.into_iter().collect();
    ordered
        .into_iter()
        .filter_map(|(id, long_side)| describe(doc, id, long_side))
        .collect()
}

fn decode_pixels(stream: &Stream, candidate: &Candidate) -> Option<Vec<u8>> {
    match candidate.encoding {
        Encoding::Jpeg => {
            let mut reader =
                ImageReader::with_format(Cursor::new(&stream.content), ImageFormat::Jpeg);
            let mut image_limits = image::Limits::default();
            image_limits.max_image_width = Some(limits::MAX_IMAGE_SIDE_PX);
            image_limits.max_image_height = Some(limits::MAX_IMAGE_SIDE_PX);
            image_limits.max_alloc = Some(limits::MAX_IMAGE_ALLOC_BYTES);
            reader.limits(image_limits);
            let decoded = reader.decode().ok()?;
            let (width, height) = (decoded.width(), decoded.height());
            if (width, height) != (candidate.width, candidate.height) {
                return None;
            }
            match (candidate.comps, decoded) {
                (1, DynamicImage::ImageLuma8(buffer)) => Some(buffer.into_raw()),
                (3, DynamicImage::ImageRgb8(buffer)) => Some(buffer.into_raw()),
                _ => None,
            }
        }
        Encoding::Flate => {
            let expected = usize::try_from(
                u64::from(candidate.width)
                    * u64::from(candidate.height)
                    * u64::from(candidate.comps),
            )
            .ok()?;
            if expected > limits::MAX_FLATE_OUTPUT_BYTES {
                return None;
            }
            let mut pixels = Vec::with_capacity(expected);
            ZlibDecoder::new(&stream.content[..])
                .take(expected as u64 + 1)
                .read_to_end(&mut pixels)
                .ok()?;
            (pixels.len() == expected).then_some(pixels)
        }
    }
}

/// The image at `dpi` and `quality`, if that is smaller than what is stored.
fn recode(doc: &Document, candidate: &Candidate, dpi: u32, quality: u8) -> Option<Recoded> {
    let stream = doc.get_object(candidate.id).ok()?.as_stream().ok()?;
    let (width, height) = (candidate.width, candidate.height);
    // Small graphics are line art or icons: the gain is nothing and the loss shows.
    if u64::from(width) * u64::from(height) < 10_000 {
        return None;
    }
    // The page's longer side at `dpi` is the most pixels any use of the image can show.
    let wanted_long = (f64::from(candidate.page_long_side_pt) / 72.0 * f64::from(dpi)).max(1.0);
    let long = f64::from(width.max(height));
    let scale = (wanted_long / long).min(1.0);
    let scaled = |side: u32| ((f64::from(side) * scale).round() as u32).max(1);
    let (new_width, new_height) = if scale < 1.0 {
        (scaled(width), scaled(height))
    } else {
        (width, height)
    };
    let pixels = decode_pixels(stream, candidate)?;
    let raw = if (new_width, new_height) == (width, height) {
        pixels
    } else if candidate.comps == 1 {
        let buffer = ImageBuffer::<Luma<u8>, _>::from_raw(width, height, pixels)?;
        image::imageops::resize(&buffer, new_width, new_height, FilterType::Triangle).into_raw()
    } else {
        let buffer = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, pixels)?;
        image::imageops::resize(&buffer, new_width, new_height, FilterType::Triangle).into_raw()
    };
    let mut content = Vec::new();
    let color = if candidate.comps == 1 {
        ExtendedColorType::L8
    } else {
        ExtendedColorType::Rgb8
    };
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut content, quality)
        .encode(&raw, new_width, new_height, color)
        .ok()?;
    // A JPEG that is run through the encoder again loses for little: it has to gain a tenth at the same size.
    let needed = if candidate.encoding == Encoding::Jpeg && scale >= 1.0 {
        candidate.encoded_len / 10 * 9
    } else {
        candidate.encoded_len
    };
    (content.len() < needed).then_some(Recoded {
        content,
        width: new_width,
        height: new_height,
    })
}

fn apply(doc: &mut Document, id: ObjectId, recoded: Recoded) {
    if let Some(Object::Stream(stream)) = doc.objects.get_mut(&id) {
        stream
            .dict
            .set("Filter", Object::Name(b"DCTDecode".to_vec()));
        stream.dict.remove(b"DecodeParms");
        stream.dict.set("Width", i64::from(recoded.width));
        stream.dict.set("Height", i64::from(recoded.height));
        stream.dict.set("BitsPerComponent", 8);
        stream.allows_compression = false;
        stream.set_content(recoded.content);
    }
}

// --- Streams ------------------------------------------------------------------------------------------------------

fn is_structural(stream: &Stream) -> bool {
    stream
        .dict
        .get(b"Type")
        .and_then(Object::as_name)
        .is_ok_and(|name| name == b"XRef" || name == b"ObjStm")
}

fn content_hash(content: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// Streams that are the same as an earlier one (same dictionary, same bytes), and the object they are the same as. Never a stream
/// whose id is the lowest of its kind: that one stays.
fn duplicates(
    doc: &Document,
    control: &dyn Control,
) -> Result<HashMap<ObjectId, ObjectId>, AppError> {
    let mut first: HashMap<(usize, u64, String), ObjectId> = HashMap::new();
    let mut redirect = HashMap::new();
    for (n, (&id, object)) in doc.objects.iter().enumerate() {
        if n.is_multiple_of(1024) {
            control.check()?;
        }
        let Object::Stream(stream) = object else {
            continue;
        };
        if is_structural(stream) {
            continue;
        }
        let key = (
            stream.content.len(),
            content_hash(&stream.content),
            format!("{:?}", stream.dict),
        );
        match first.get(&key) {
            Some(&kept) => {
                let same = matches!(doc.objects.get(&kept), Some(Object::Stream(other)) if other.content == stream.content);
                if same {
                    redirect.insert(id, kept);
                }
            }
            None => {
                first.insert(key, id);
            }
        }
    }
    Ok(redirect)
}

fn redirect_refs(object: &mut Object, redirect: &HashMap<ObjectId, ObjectId>, depth: usize) {
    if depth > limits::MAX_COPY_NESTING {
        return;
    }
    match object {
        Object::Reference(id) => {
            if let Some(&to) = redirect.get(id) {
                *id = to;
            }
        }
        Object::Array(items) => {
            for item in items {
                redirect_refs(item, redirect, depth + 1);
            }
        }
        Object::Dictionary(dict) => {
            for (_, value) in dict.iter_mut() {
                redirect_refs(value, redirect, depth + 1);
            }
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter_mut() {
                redirect_refs(value, redirect, depth + 1);
            }
        }
        _ => {}
    }
}

fn flate(content: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content).ok()?;
    encoder.finish().ok()
}

/// Whether a stream is stored plain and worth trying to compress.
fn plain_candidate(stream: &Stream) -> bool {
    stream.allows_compression
        && stream.content.len() >= 128
        && !stream.dict.has(b"Filter")
        && !is_structural(stream)
        && !stream
            .dict
            .get(b"Type")
            .and_then(Object::as_name)
            .is_ok_and(|name| name == b"Metadata")
}

fn flate_plain_streams(doc: &mut Document, control: &dyn Control) -> Result<(), AppError> {
    for (n, object) in doc.objects.values_mut().enumerate() {
        if n.is_multiple_of(256) {
            control.check()?;
        }
        let Object::Stream(stream) = object else {
            continue;
        };
        if !plain_candidate(stream) {
            continue;
        }
        if let Some(packed) = flate(&stream.content) {
            if packed.len() < stream.content.len() {
                stream
                    .dict
                    .set("Filter", Object::Name(b"FlateDecode".to_vec()));
                stream.set_content(packed);
            }
        }
    }
    Ok(())
}

/// Takes the signature values out (they would not verify in a rewritten file). Whether there were any.
fn strip_signatures(doc: &mut Document) -> bool {
    let mut removed = false;
    for object in doc.objects.values_mut() {
        let dict = match object {
            Object::Dictionary(dict) => dict,
            Object::Stream(stream) => &mut stream.dict,
            _ => continue,
        };
        if name_is(dict.get(b"FT").ok(), b"Sig") && dict.remove(b"V").is_some() {
            removed = true;
        }
    }
    if let Ok(catalog) = doc.catalog_mut() {
        if catalog.remove(b"Perms").is_some() {
            removed = true;
        }
    }
    removed
}

/// Removes the objects nothing reaches from the trailer (lopdf's own `prune_objects` searches a list for every reference, which is
/// quadratic on a document with a million objects).
fn prune_unreachable(doc: &mut Document, control: &dyn Control) -> Result<(), AppError> {
    fn references(object: &Object, found: &mut Vec<ObjectId>, depth: usize) {
        if depth > limits::MAX_COPY_NESTING {
            return;
        }
        match object {
            Object::Reference(id) => found.push(*id),
            Object::Array(items) => items.iter().for_each(|i| references(i, found, depth + 1)),
            Object::Dictionary(dict) => dict
                .iter()
                .for_each(|(_, v)| references(v, found, depth + 1)),
            Object::Stream(stream) => stream
                .dict
                .iter()
                .for_each(|(_, v)| references(v, found, depth + 1)),
            _ => {}
        }
    }
    let mut reached: HashSet<ObjectId> = HashSet::new();
    let mut stack = Vec::new();
    for (_, value) in doc.trailer.iter() {
        references(value, &mut stack, 0);
    }
    let mut steps = 0u32;
    while let Some(id) = stack.pop() {
        if !reached.insert(id) {
            continue;
        }
        steps += 1;
        if steps.is_multiple_of(1024) {
            control.check()?;
        }
        if let Some(object) = doc.objects.get(&id) {
            references(object, &mut stack, 0);
        }
    }
    doc.objects.retain(|id, _| reached.contains(id));
    Ok(())
}

// --- The jobs -----------------------------------------------------------------------------------------------------

/// Compresses `bytes` (a PDF that is not encrypted) as `preset` says.
pub fn compress(
    bytes: &[u8],
    preset: Preset,
    control: &dyn Control,
) -> Result<Compressed, AppError> {
    control.progress(Phase::Read, 0, 1);
    let mut parsed = load(bytes)?;
    control.progress(Phase::Read, 1, 1);
    let pages = u32::try_from(parsed.pages.len()).map_err(|_| AppError::invalid("pages"))?;

    let mut images = 0u32;
    if let Some((dpi, quality)) = preset.target() {
        let found = candidates(&parsed);
        let total = u32::try_from(found.len()).unwrap_or(u32::MAX);
        for (n, candidate) in found.iter().enumerate() {
            control.check()?;
            if let Some(recoded) = recode(&parsed.doc, candidate, dpi, quality) {
                apply(&mut parsed.doc, candidate.id, recoded);
                images += 1;
            }
            control.progress(Phase::Images, u32::try_from(n + 1).unwrap_or(total), total);
        }
    }

    let mut warnings = Vec::new();
    if strip_signatures(&mut parsed.doc) {
        warnings.push(Warning::SignaturesRemoved);
    }
    let redirect = duplicates(&parsed.doc, control)?;
    if !redirect.is_empty() {
        for object in parsed.doc.objects.values_mut() {
            redirect_refs(object, &redirect, 0);
        }
        for (_, value) in parsed.doc.trailer.iter_mut() {
            redirect_refs(value, &redirect, 0);
        }
    }
    flate_plain_streams(&mut parsed.doc, control)?;
    control.check()?;
    prune_unreachable(&mut parsed.doc, control)?;

    let mut out = Vec::new();
    parsed.doc.save_to(&mut out).map_err(failed)?;
    control.progress(Phase::Validate, 0, 1);
    validate(&out, pages)?;
    control.progress(Phase::Validate, 1, 1);
    Ok(Compressed {
        bytes: out,
        pages,
        images,
        warnings,
    })
}

/// Bytes the lossless steps would save, from the duplicates (exact) and a sample of the plain streams (the biggest, until the time is
/// up; the rest by the ratio the sample gave).
fn lossless_savings(
    doc: &Document,
    control: &dyn Control,
    budget: Duration,
) -> Result<u64, AppError> {
    let mut saved = 0u64;
    for (&id, &kept) in &duplicates(doc, control)? {
        if let (Some(Object::Stream(a)), true) = (doc.objects.get(&id), kept != id) {
            saved += a.content.len() as u64;
        }
    }
    let started = Instant::now();
    let mut streams: Vec<&Stream> = doc
        .objects
        .values()
        .filter_map(|object| match object {
            Object::Stream(stream) if plain_candidate(stream) => Some(stream),
            _ => None,
        })
        .collect();
    streams.sort_unstable_by_key(|stream| std::cmp::Reverse(stream.content.len()));
    let total: u64 = streams.iter().map(|s| s.content.len() as u64).sum();
    let (mut sampled, mut gain) = (0u64, 0u64);
    for stream in streams {
        if sampled > 0 && started.elapsed() > budget {
            break;
        }
        control.check()?;
        sampled += stream.content.len() as u64;
        if let Some(packed) = flate(&stream.content) {
            gain += (stream.content.len() as u64).saturating_sub(packed.len() as u64);
        }
    }
    if sampled > 0 {
        saved += (u128::from(total) * u128::from(gain) / u128::from(sampled)) as u64;
    }
    Ok(saved)
}

/// How big `bytes` would be after each of `presets`, estimated from a sample (a few of the biggest images, the biggest plain streams) in
/// about [`limits::ESTIMATE_BUDGET`]. Never more than the size now.
pub fn estimate(
    bytes: &[u8],
    presets: &[Preset],
    control: &dyn Control,
) -> Result<Vec<(Preset, u64)>, AppError> {
    let parsed = load(bytes)?;
    let before = bytes.len() as u64;
    let lossless = lossless_savings(&parsed.doc, control, limits::ESTIMATE_BUDGET / 3)?;
    let mut found = candidates(&parsed);
    found.sort_unstable_by_key(|candidate| std::cmp::Reverse(candidate.encoded_len));
    let candidate_bytes: u64 = found.iter().map(|c| c.encoded_len as u64).sum();
    let lossy = presets
        .iter()
        .filter(|p| p.target().is_some())
        .count()
        .max(1);
    let share = limits::ESTIMATE_BUDGET / u32::try_from(lossy).unwrap_or(1);
    let mut out = Vec::with_capacity(presets.len());
    for &preset in presets {
        control.check()?;
        let mut saved = lossless;
        if let Some((dpi, quality)) = preset.target() {
            let started = Instant::now();
            let (mut sampled, mut gain) = (0u64, 0u64);
            for candidate in found.iter().take(limits::ESTIMATE_SAMPLE_IMAGES) {
                if sampled > 0 && started.elapsed() > share {
                    break;
                }
                sampled += candidate.encoded_len as u64;
                if let Some(recoded) = recode(&parsed.doc, candidate, dpi, quality) {
                    gain +=
                        (candidate.encoded_len as u64).saturating_sub(recoded.content.len() as u64);
                }
            }
            if sampled > 0 {
                saved +=
                    (u128::from(candidate_bytes) * u128::from(gain) / u128::from(sampled)) as u64;
            }
        }
        out.push((preset, before.saturating_sub(saved.min(before)).max(1)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfwrite::produce::Unattended;
    use lopdf::Dictionary;

    /// A document with one page that shows `image` (an XObject stream), `pages` pages in all.
    fn document_with_image(image: Stream) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let image_id = doc.add_object(Object::Stream(image));
        let mut xobjects = Dictionary::new();
        xobjects.set("Im0", Object::Reference(image_id));
        let mut resources = Dictionary::new();
        resources.set("XObject", Object::Dictionary(xobjects));
        let content = doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            b"q 612 0 0 792 0 0 cm /Im0 Do Q ".repeat(20),
        )));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages));
        page.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
        page.set("Resources", Object::Dictionary(resources));
        page.set("Contents", Object::Reference(content));
        let page_id = doc.add_object(Object::Dictionary(page));
        let mut tree = Dictionary::new();
        tree.set("Type", Object::Name(b"Pages".to_vec()));
        tree.set("Kids", vec![Object::Reference(page_id)]);
        tree.set("Count", 1);
        doc.objects.insert(pages, Object::Dictionary(tree));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages));
        let root = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(root));
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn rgb_image_dict(width: i64, height: i64, filter: &str) -> Dictionary {
        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"XObject".to_vec()));
        dict.set("Subtype", Object::Name(b"Image".to_vec()));
        dict.set("Width", width);
        dict.set("Height", height);
        dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        dict.set("BitsPerComponent", 8);
        if !filter.is_empty() {
            dict.set("Filter", Object::Name(filter.as_bytes().to_vec()));
        }
        dict
    }

    /// Noisy pixels: a JPEG of them is big, and a smaller picture of them is smaller.
    fn noise(width: u32, height: u32) -> Vec<u8> {
        let mut state = 0x1234_5678u32;
        (0..width * height * 3)
            .map(|n| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 24) as u8) / 2 + (n % 3) as u8 * 20
            })
            .collect()
    }

    fn jpeg(width: u32, height: u32, quality: u8) -> Vec<u8> {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode(
                &noise(width, height),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    fn image_of(bytes: &[u8]) -> (i64, i64, Vec<u8>, String) {
        let parsed = load(bytes).unwrap();
        for object in parsed.doc.objects.values() {
            if let Object::Stream(stream) = object {
                if name_is(stream.dict.get(b"Subtype").ok(), b"Image") {
                    return (
                        stream.dict.get(b"Width").unwrap().as_i64().unwrap(),
                        stream.dict.get(b"Height").unwrap().as_i64().unwrap(),
                        stream.content.clone(),
                        String::from_utf8_lossy(stream.filters().unwrap()[0]).into_owned(),
                    );
                }
            }
        }
        panic!("no image");
    }

    #[test]
    fn a_big_jpeg_is_scaled_down_to_the_page_resolution_and_is_smaller() {
        let data = jpeg(1600, 1600, 95);
        let original = document_with_image(Stream::new(
            rgb_image_dict(1600, 1600, "DCTDecode"),
            data.clone(),
        ));
        let result = compress(&original, Preset::Screen, &Unattended).unwrap();
        assert_eq!(result.images, 1);
        assert!(result.bytes.len() < original.len());
        let (width, height, content, filter) = image_of(&result.bytes);
        // A 792 pt page at 96 dpi: at most 1056 px on the long side.
        assert_eq!((width, height), (1056, 1056));
        assert_eq!(filter, "DCTDecode");
        assert!(content.len() < data.len());
        // It is still a JPEG that decodes.
        assert!(image::load_from_memory_with_format(&content, ImageFormat::Jpeg).is_ok());
    }

    #[test]
    fn a_flate_image_becomes_a_jpeg_and_lossless_leaves_images_alone() {
        let pixels = noise(400, 400);
        let packed = flate(&pixels).unwrap();
        let original = document_with_image(Stream::new(
            rgb_image_dict(400, 400, "FlateDecode"),
            packed.clone(),
        ));
        let result = compress(&original, Preset::Ebook, &Unattended).unwrap();
        assert_eq!(result.images, 1);
        let (width, _, _, filter) = image_of(&result.bytes);
        assert_eq!((width, filter.as_str()), (400, "DCTDecode"));
        assert!(result.bytes.len() < original.len());

        let lossless = compress(&original, Preset::Lossless, &Unattended).unwrap();
        assert_eq!(lossless.images, 0);
        let (_, _, content, filter) = image_of(&lossless.bytes);
        assert_eq!((content, filter.as_str()), (packed, "FlateDecode"));
    }

    #[test]
    fn images_that_are_not_safe_to_change_stay_as_they_are() {
        let data = jpeg(300, 300, 95);
        let variants: Vec<(&str, Dictionary)> = {
            let mut cmyk = rgb_image_dict(300, 300, "DCTDecode");
            cmyk.set("ColorSpace", Object::Name(b"DeviceCMYK".to_vec()));
            let mut mask = rgb_image_dict(300, 300, "DCTDecode");
            mask.set("ImageMask", true);
            let mut decode = rgb_image_dict(300, 300, "DCTDecode");
            decode.set(
                "Decode",
                vec![1.into(), 0.into(), 1.into(), 0.into(), 1.into(), 0.into()],
            );
            let mut sixteen = rgb_image_dict(300, 300, "DCTDecode");
            sixteen.set("BitsPerComponent", 16);
            let jpx = rgb_image_dict(300, 300, "JPXDecode");
            let mut wrong_size = rgb_image_dict(301, 300, "DCTDecode");
            wrong_size.set("Width", 301);
            vec![
                ("cmyk", cmyk),
                ("mask", mask),
                ("decode", decode),
                ("16 bit", sixteen),
                ("jpx", jpx),
                ("size lies", wrong_size),
            ]
        };
        for (label, dict) in variants {
            let original = document_with_image(Stream::new(dict, data.clone()));
            let result = compress(&original, Preset::Screen, &Unattended).unwrap();
            assert_eq!(result.images, 0, "{label}");
        }
    }

    #[test]
    fn a_hostile_image_is_left_alone_not_an_error() {
        for content in [
            vec![],
            vec![0xFF, 0xD8, 0xFF],
            b"garbage".to_vec(),
            vec![0u8; 5000],
        ] {
            for filter in ["DCTDecode", "FlateDecode"] {
                let original = document_with_image(Stream::new(
                    rgb_image_dict(900, 900, filter),
                    content.clone(),
                ));
                let result = compress(&original, Preset::Screen, &Unattended).unwrap();
                assert_eq!(result.images, 0, "{filter}");
            }
        }
        // A bomb: a few bytes that inflate to far more than the image says.
        let bomb = flate(&vec![0u8; 20_000_000]).unwrap();
        let original =
            document_with_image(Stream::new(rgb_image_dict(100, 100, "FlateDecode"), bomb));
        assert_eq!(
            compress(&original, Preset::Screen, &Unattended)
                .unwrap()
                .images,
            0
        );
    }

    #[test]
    fn identical_streams_are_shared_and_plain_ones_compressed() {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let data = b"BT /F1 12 Tf (hello hello hello) Tj ET ".repeat(50);
        let first = doc.add_object(Object::Stream(Stream::new(Dictionary::new(), data.clone())));
        let second = doc.add_object(Object::Stream(Stream::new(Dictionary::new(), data.clone())));
        let mut kids = Vec::new();
        for content in [first, second] {
            let mut page = Dictionary::new();
            page.set("Type", Object::Name(b"Page".to_vec()));
            page.set("Parent", Object::Reference(pages));
            page.set("MediaBox", vec![0.into(), 0.into(), 100.into(), 100.into()]);
            page.set("Contents", Object::Reference(content));
            kids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
        }
        let mut tree = Dictionary::new();
        tree.set("Type", Object::Name(b"Pages".to_vec()));
        tree.set("Kids", kids);
        tree.set("Count", 2);
        doc.objects.insert(pages, Object::Dictionary(tree));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages));
        let root = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(root));
        let mut original = Vec::new();
        doc.save_to(&mut original).unwrap();

        let result = compress(&original, Preset::Lossless, &Unattended).unwrap();
        assert_eq!(result.pages, 2);
        assert!(result.bytes.len() * 2 < original.len());
        let parsed = load(&result.bytes).unwrap();
        let streams = parsed
            .doc
            .objects
            .values()
            .filter(|o| matches!(o, Object::Stream(s) if !is_structural(s)))
            .count();
        assert_eq!(streams, 1);
    }

    #[test]
    fn the_estimate_is_never_more_than_the_file_and_is_close_for_images() {
        let original = document_with_image(Stream::new(
            rgb_image_dict(1600, 1600, "DCTDecode"),
            jpeg(1600, 1600, 95),
        ));
        let estimates = estimate(&original, &Preset::ALL, &Unattended).unwrap();
        assert_eq!(estimates.len(), 4);
        for (_, size) in &estimates {
            assert!(*size <= original.len() as u64 && *size >= 1);
        }
        let screen = estimates
            .iter()
            .find(|(p, _)| *p == Preset::Screen)
            .unwrap()
            .1;
        let real = compress(&original, Preset::Screen, &Unattended)
            .unwrap()
            .bytes
            .len() as u64;
        assert!(screen.abs_diff(real) * 10 < real, "{screen} vs {real}");
        let ebook = estimates
            .iter()
            .find(|(p, _)| *p == Preset::Ebook)
            .unwrap()
            .1;
        let print = estimates
            .iter()
            .find(|(p, _)| *p == Preset::Print)
            .unwrap()
            .1;
        assert!(screen <= ebook && ebook <= print);
    }

    #[test]
    fn presets_use_the_documented_resolutions() {
        assert_eq!(Preset::Screen.target(), Some((96, 55)));
        assert_eq!(Preset::Ebook.target(), Some((150, 70)));
        assert_eq!(Preset::Print.target(), Some((220, 85)));
        assert_eq!(Preset::Lossless.target(), None);
        assert_eq!(serde_json::to_string(&Preset::Ebook).unwrap(), "\"ebook\"");
    }
}
