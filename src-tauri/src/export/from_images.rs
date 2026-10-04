//! Images to PDF (ADR-049 §3): options, the open dialog or a dropped batch, geometry and the job.
//!
//! Every image goes through `content::image::prepare_bytes` unchanged (M5 limits, EXIF orientation, metadata dropped, re-encoded). An
//! image that fails is left out and counted; all failing is `invalid_argument` `image`. The page size and the place of the image are
//! worked out by [`layout`] (pure), the file by `pdfwrite::images_pdf::build`, then the merge pattern: the file the user chose in Save As
//! is written atomically and opens as a tab.

use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::commands::jobs::{jobs, EventSink, JobDone, JobId, JobRegistry};
use crate::commands::AppState;
use crate::content::image::{self, ImageAsset};
use crate::documents::image_batch::{self, ImageBatch};
use crate::documents::intake;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::Rect;
use crate::pdfwrite::images_pdf::{self, ImagePage};
use crate::pdfwrite::produce::{Control, Phase, Warning};

/// The page size of every page: the image's own (`fit`), A4 or Letter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaperSize {
    Fit,
    A4,
    Letter,
}

/// Page orientation: by the image's aspect (`auto`) or fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

/// Where the images come from: the Rust open dialog, or a batch held from a drop (`AppEvent::ImagesDropped`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ImageSource {
    Dialog,
    Batch { batch: u32 },
}

/// What `images_to_pdf` takes. `margin_pt` is 0..=72.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImagesToPdfOptions {
    pub source: ImageSource,
    pub paper: PaperSize,
    pub orientation: Orientation,
    pub margin_pt: f32,
}

/// The images a job reads.
pub enum Inputs {
    /// Paths from the open dialog (they never leave Rust), in the order to use.
    Paths(Vec<PathBuf>),
    /// A dropped or picked batch, all images in batch order.
    Batch(Arc<ImageBatch>),
    /// A batch read in the given order (indices into it, checked by [`validate_order`]).
    Ordered(Arc<ImageBatch>, Vec<usize>),
}

impl Inputs {
    fn len(&self) -> usize {
        match self {
            Self::Paths(paths) => paths.len(),
            Self::Batch(batch) => batch.images.len(),
            Self::Ordered(_, order) => order.len(),
        }
    }

    fn open(&self, index: usize) -> Result<File, AppError> {
        match self {
            Self::Paths(paths) => {
                let path = paths.get(index).ok_or(AppError::invalid("image"))?;
                image::open_picked(path)
            }
            Self::Batch(batch) => batch
                .images
                .get(index)
                .ok_or(AppError::invalid("image"))?
                .reopen(),
            Self::Ordered(batch, order) => order
                .get(index)
                .and_then(|i| batch.images.get(*i))
                .ok_or(AppError::invalid("image"))?
                .reopen(),
        }
    }
}

// --- Geometry -----------------------------------------------------------------------------------------------------

/// A4 and Letter in points, portrait.
const A4_PT: [f32; 2] = [595.276, 841.89];
const LETTER_PT: [f32; 2] = [612.0, 792.0];

/// What the header of an image file says about its size and density.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct HeaderInfo {
    /// The size in pixels the file declares (before EXIF orientation and downsizing).
    pub size: Option<(u32, u32)>,
    /// The horizontal density in dots per inch, if the file states one with a known unit.
    pub dpi: Option<f32>,
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(
        bytes.get(at..at + 2)?.try_into().ok()?,
    )))
}

/// Reads the size and density from the first chunks (PNG: IHDR, `pHYs`) or segments (JPEG: start of frame, JFIF) without decoding.
/// Anything unreadable is `None` for that part.
#[allow(clippy::cast_precision_loss)]
pub fn header_info(bytes: &[u8]) -> HeaderInfo {
    let mut info = HeaderInfo::default();
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut at = 8;
        // The chunks that matter come before the first IDAT; a bounded walk.
        for _ in 0..32 {
            let (Some(len), Some(kind)) = (be32(bytes, at), bytes.get(at + 4..at + 8)) else {
                break;
            };
            let data = at + 8;
            match kind {
                b"IHDR" => info.size = be32(bytes, data).zip(be32(bytes, data + 4)),
                b"pHYs" => {
                    if let (Some(x), Some(&unit)) = (be32(bytes, data), bytes.get(data + 8)) {
                        if unit == 1 {
                            info.dpi = Some(x as f32 * 0.0254);
                        }
                    }
                }
                b"IDAT" | b"IEND" => break,
                _ => {}
            }
            let Some(next) = usize::try_from(len)
                .ok()
                .and_then(|len| data.checked_add(len)?.checked_add(4))
            else {
                break;
            };
            at = next;
        }
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut at = 2;
        while at + 4 <= bytes.len() && bytes[at] == 0xFF {
            let marker = bytes[at + 1];
            match marker {
                0xFF => at += 1,
                0x01 | 0xD0..=0xD8 => at += 2,
                0xE0 if bytes.get(at + 4..at + 9) == Some(b"JFIF\0") => {
                    if let (Some(&units), Some(x)) = (bytes.get(at + 11), be16(bytes, at + 12)) {
                        match units {
                            1 => info.dpi = Some(x as f32),
                            2 => info.dpi = Some(x as f32 * 2.54),
                            _ => {}
                        }
                    }
                    at += 2 + be16(bytes, at + 2).unwrap_or(0) as usize;
                }
                0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                    info.size = be16(bytes, at + 7).zip(be16(bytes, at + 5));
                    break;
                }
                0xD9 | 0xDA => break,
                _ => match be16(bytes, at + 2) {
                    Some(len) => at += 2 + len as usize,
                    None => break,
                },
            }
        }
    }
    info
}

/// The density to use: the file's own when it is in `72..=1200` dpi, else 150.
pub fn trusted_dpi(dpi: Option<f32>) -> f32 {
    match dpi {
        Some(d)
            if d.is_finite()
                && (limits::MIN_IMAGE_DENSITY_DPI..=limits::MAX_IMAGE_DENSITY_DPI).contains(&d) =>
        {
            d
        }
        _ => limits::DEFAULT_IMAGE_DENSITY_DPI,
    }
}

/// The page size and the place of the image on it, in points (origin bottom left).
///
/// `size` is the stored image in pixels, `declared_long` the long side of the file before downsizing (`None`: the stored one) and
/// `dpi` the density of the file. `fit` makes the page the image at its density plus the margin (each side within 72..=14 400 pt); A4 and
/// Letter are fixed. `auto` picks landscape for a wide image. The image is scaled to fit inside the margin, centred, never cropped.
#[allow(clippy::cast_precision_loss)]
pub fn layout(
    size: (u32, u32),
    declared_long: Option<u32>,
    dpi: Option<f32>,
    paper: PaperSize,
    orientation: Orientation,
    margin: f32,
) -> ([f32; 2], Rect) {
    let (w, h) = (size.0.max(1) as f32, size.1.max(1) as f32);
    let aspect = w / h;
    let wide = w > h;
    let mut page = match paper {
        PaperSize::A4 => A4_PT,
        PaperSize::Letter => LETTER_PT,
        PaperSize::Fit => {
            let long_px = declared_long.map_or(w.max(h), |l| l.max(1) as f32);
            let long_pt = long_px * 72.0 / trusted_dpi(dpi);
            let (iw, ih) = if wide {
                (long_pt, long_pt / aspect)
            } else {
                (long_pt * aspect, long_pt)
            };
            [
                (iw + 2.0 * margin).clamp(limits::MIN_IMAGE_PAGE_PT, limits::MAX_IMAGE_PAGE_PT),
                (ih + 2.0 * margin).clamp(limits::MIN_IMAGE_PAGE_PT, limits::MAX_IMAGE_PAGE_PT),
            ]
        }
    };
    let landscape = match orientation {
        Orientation::Auto => wide && paper != PaperSize::Fit,
        Orientation::Portrait => false,
        Orientation::Landscape => true,
    };
    match (paper, orientation) {
        // Fit keeps the image's own shape unless told otherwise.
        (PaperSize::Fit, Orientation::Auto) => {}
        _ => {
            if landscape != (page[0] > page[1]) {
                page.swap(0, 1);
            }
        }
    }
    let avail_w = (page[0] - 2.0 * margin).max(1.0);
    let avail_h = (page[1] - 2.0 * margin).max(1.0);
    let place_w = avail_w.min(avail_h * aspect);
    let place_h = place_w / aspect;
    let place = Rect {
        x: (page[0] - place_w) / 2.0,
        y: (page[1] - place_h) / 2.0,
        w: place_w,
        h: place_h,
    };
    (page, place)
}

// --- The job ------------------------------------------------------------------------------------------------------

fn check_options(opts: &ImagesToPdfOptions) -> Result<(), AppError> {
    let margin = opts.margin_pt;
    if !margin.is_finite()
        || !(limits::MIN_IMAGE_MARGIN_PT..=limits::MAX_IMAGE_MARGIN_PT).contains(&margin)
    {
        return Err(AppError::invalid("margin"));
    }
    Ok(())
}

/// The bytes of an opened image file: a regular file of at most the intake limit, read once.
fn read_file(file: File) -> Result<Vec<u8>, AppError> {
    let meta = file.metadata()?;
    let max = limits::MAX_IMAGE_FILE_BYTES;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::invalid("image"));
    }
    if meta.len() > max {
        return Err(AppError::too_large("image", max));
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AppError::too_large("image", max));
    }
    Ok(bytes)
}

struct Prepared {
    asset: ImageAsset,
    info: HeaderInfo,
}

/// Runs the job body: reads and prepares every image, lays the pages out, writes the file and opens it.
fn run(
    ctx: &dyn Control,
    state: &AppState,
    inputs: &Inputs,
    opts: &ImagesToPdfOptions,
    target: &std::path::Path,
    producer: &str,
) -> Result<JobDone, AppError> {
    let total = u32::try_from(inputs.len()).unwrap_or(u32::MAX);
    let mut pages: Vec<ImagePage> = Vec::with_capacity(inputs.len());
    let (mut skipped, mut stored, mut read_bytes) = (0u32, 0u64, 0u64);
    for index in 0..inputs.len() {
        ctx.check()?;
        let prepared = inputs.open(index).and_then(read_file).and_then(|bytes| {
            read_bytes += bytes.len() as u64;
            let info = header_info(&bytes);
            let asset = image::prepare_bytes(&bytes)?;
            Ok(Prepared { asset, info })
        });
        match prepared {
            Ok(Prepared { asset, info }) => {
                stored += asset.byte_size() as u64;
                if stored > limits::MAX_IMAGES_PDF_STORED_BYTES {
                    return Err(AppError::too_large(
                        "images",
                        limits::MAX_IMAGES_PDF_STORED_BYTES,
                    ));
                }
                let declared_long = info.size.map(|(w, h)| w.max(h));
                let (size_pt, place) = layout(
                    (asset.width, asset.height),
                    declared_long,
                    info.dpi,
                    opts.paper,
                    opts.orientation,
                    opts.margin_pt,
                );
                pages.push(ImagePage {
                    image: asset,
                    size_pt,
                    place,
                });
            }
            Err(error) => {
                // A cancelled job or a limit of the whole job ends it; a bad image is left out.
                if error.code() == ErrorCode::Cancelled {
                    return Err(error);
                }
                skipped += 1;
            }
        }
        ctx.progress(
            Phase::Images,
            u32::try_from(index + 1).unwrap_or(u32::MAX),
            total,
        );
    }
    if pages.is_empty() {
        return Err(AppError::invalid("image"));
    }
    ctx.check()?;
    ctx.progress(Phase::Write, 0, 1);
    let bytes = images_pdf::build(&pages, producer)?;
    drop(pages);
    ctx.check()?;
    let after = bytes.len() as u64;
    let opened = state.publish(target, &bytes)?;
    ctx.progress(Phase::Write, 1, 1);
    Ok(JobDone {
        outputs: 1,
        bytes_before: read_bytes,
        bytes_after: after,
        warnings: if skipped > 0 {
            vec![Warning::ImagesSkipped]
        } else {
            Vec::new()
        },
        opened,
        changes: None,
        skipped,
        print: None,
    })
}

/// Starts the job on `jobs` for `inputs` and the Save As choice `target` (checked here: a plain local path, not an open document).
pub fn start_job(
    state: &AppState,
    registry: &Arc<JobRegistry>,
    inputs: Inputs,
    opts: &ImagesToPdfOptions,
    target: &std::path::Path,
    producer: &str,
    sink: Arc<dyn EventSink>,
) -> Result<JobId, AppError> {
    check_options(opts)?;
    if inputs.len() == 0 {
        return Err(AppError::invalid("image"));
    }
    if inputs.len() > limits::MAX_IMAGES_PER_PDF {
        return Err(AppError::limit("images", limits::MAX_IMAGES_PER_PDF as u64));
    }
    let target = intake::admit_target(target)?;
    if state.target_is_open(&target) {
        return Err(AppError::new(ErrorCode::IoInUse));
    }
    let (state, opts, producer) = (state.clone(), *opts, producer.to_owned());
    registry.start(sink, move |ctx| {
        run(ctx, &state, &inputs, &opts, &target, &producer)
    })
}

/// Picks or takes the images, asks for the target and starts the job; `None` when a dialog was cancelled.
pub fn start(
    state: &AppState,
    window: &WebviewWindow,
    opts: &ImagesToPdfOptions,
    order: Option<&[u32]>,
    sink: Arc<dyn EventSink>,
) -> Result<Option<JobId>, AppError> {
    check_options(opts)?;
    let (inputs, stem) = match opts.source {
        ImageSource::Dialog => {
            if order.is_some() {
                return Err(AppError::invalid("order"));
            }
            let picked = window
                .dialog()
                .file()
                .set_parent(window)
                .add_filter("Image", &["png", "jpg", "jpeg"])
                .blocking_pick_files();
            let Some(picked) = picked else {
                return Ok(None);
            };
            // One past the limit, so that too many is told apart without holding thousands of paths.
            let mut paths: Vec<PathBuf> = picked
                .into_iter()
                .take(limits::MAX_IMAGES_PER_PDF + 1)
                .filter_map(|file| {
                    file.into_path()
                        .map_err(|error| AppError::logged(ErrorCode::Internal, error).log())
                        .ok()
                })
                .collect();
            if paths.len() > limits::MAX_IMAGES_PER_PDF {
                return Err(AppError::limit("images", limits::MAX_IMAGES_PER_PDF as u64));
            }
            image_batch::sort_natural(&mut paths);
            let Some(first) = paths.first() else {
                return Ok(None);
            };
            let stem = image_batch::stem_of(first);
            (Inputs::Paths(paths), stem)
        }
        ImageSource::Batch { batch } => {
            let held = image_batch::batches()
                .get(batch)
                .ok_or(AppError::not_found("imageBatch"))?;
            match order {
                Some(order) => {
                    let order = validate_order(order, held.images.len())?;
                    let stem = held.images[order[0]].stem.clone();
                    (Inputs::Ordered(held, order), stem)
                }
                None => {
                    let stem = held
                        .images
                        .first()
                        .map(|image| image.stem.clone())
                        .ok_or(AppError::invalid("image"))?;
                    (Inputs::Batch(held), stem)
                }
            }
        }
    };
    let name = format!("{}.pdf", crate::commands::jobs::file_stem(&stem));
    let chosen = window
        .dialog()
        .file()
        .set_parent(window)
        .add_filter("PDF", &["pdf"])
        .set_file_name(&name)
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let target = chosen
        .into_path()
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    let producer = crate::menu::app_name(window.app_handle());
    start_job(state, jobs(), inputs, opts, &target, &producer, sink).map(Some)
}

/// Checks an `order` over a batch of `len` images: not empty, at most `MAX_IMAGES_PER_PDF`, every index in range and used once.
pub fn validate_order(order: &[u32], len: usize) -> Result<Vec<usize>, AppError> {
    if order.is_empty() {
        return Err(AppError::invalid("image"));
    }
    if order.len() > limits::MAX_IMAGES_PER_PDF {
        return Err(AppError::limit("images", limits::MAX_IMAGES_PER_PDF as u64));
    }
    let mut seen = vec![false; len];
    let mut out = Vec::with_capacity(order.len());
    for &index in order {
        let index = index as usize;
        match seen.get_mut(index) {
            Some(slot) if !*slot => *slot = true,
            _ => return Err(AppError::invalid("order")),
        }
        out.push(index);
    }
    Ok(out)
}

/// One row of `list_image_batch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub index: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

/// What `pick_images` returns: the batch, how many images it holds now and how many picked files were left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedImages {
    pub batch: u32,
    pub count: u32,
    pub added: u32,
    pub skipped: u32,
}

/// The images of batch `id`, with names and declared sizes (`0` when a header cannot be read).
pub fn list_batch(id: u32) -> Result<Vec<BatchItem>, AppError> {
    let held = image_batch::batches()
        .get(id)
        .ok_or(AppError::not_found("imageBatch"))?;
    Ok(held
        .images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let (width, height) = image.declared_size();
            BatchItem {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                name: image.name.clone(),
                width,
                height,
            }
        })
        .collect())
}

/// The SHR1 frame of image `index` of batch `id`, at most `max_px` (16..=512) on the long side; decoded under the intake limits and
/// cached per batch.
pub fn batch_preview(id: u32, index: u32, max_px: u16) -> Result<Arc<Vec<u8>>, AppError> {
    if !(limits::MIN_BATCH_PREVIEW_PX..=limits::MAX_BATCH_PREVIEW_PX).contains(&max_px) {
        return Err(AppError::invalid("maxPx"));
    }
    let batches = image_batch::batches();
    let held = batches.get(id).ok_or(AppError::not_found("imageBatch"))?;
    if let Some(frame) = batches.cached_preview(id, index, max_px) {
        return Ok(frame);
    }
    let image = held
        .images
        .get(index as usize)
        .ok_or(AppError::not_found("image"))?;
    let bytes = read_file(image.reopen()?)?;
    let asset = image::prepare_bytes(&bytes)?;
    let frame = Arc::new(image::asset_frame(&asset, u32::from(max_px))?);
    batches.cache_preview(id, index, max_px, Arc::clone(&frame));
    Ok(frame)
}

/// Asks for images in the open dialog and holds them in batch `batch` (a new one when `None`). `None`: the dialog was cancelled or
/// nothing usable was picked.
pub fn pick_images(
    window: &WebviewWindow,
    batch: Option<u32>,
) -> Result<Option<PickedImages>, AppError> {
    let picked = window
        .dialog()
        .file()
        .set_parent(window)
        .add_filter("Image", &["png", "jpg", "jpeg"])
        .blocking_pick_files();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let paths: Vec<PathBuf> = picked
        .into_iter()
        .take(limits::MAX_IMAGES_PER_PDF + 1)
        .filter_map(|file| {
            file.into_path()
                .map_err(|error| AppError::logged(ErrorCode::Internal, error).log())
                .ok()
        })
        .collect();
    add_to_batch(batch, paths)
}

/// Judges `paths` as dropped files and appends the images to the batch.
pub fn add_to_batch(
    batch: Option<u32>,
    paths: Vec<PathBuf>,
) -> Result<Option<PickedImages>, AppError> {
    let total = paths.len();
    let sorted = image_batch::sort_drop(paths);
    if sorted.images.is_empty() {
        return Ok(None);
    }
    let Some((id, kept)) = image_batch::batches().append(batch, sorted.images)? else {
        return Err(AppError::not_found("imageBatch"));
    };
    let count = image_batch::batches()
        .get(id)
        .map_or(0, |held| held.images.len());
    let to_u32 = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Some(PickedImages {
        batch: id,
        count: to_u32(count),
        added: to_u32(kept),
        skipped: to_u32(total.saturating_sub(kept)),
    }))
}

/// Lets go of a dropped batch; an unknown id is not an error.
#[allow(clippy::unnecessary_wraps)] // the command's shape
pub fn release_batch(_state: &AppState, batch: u32) -> Result<(), AppError> {
    image_batch::batches().release(batch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(w: u32, h: u32, phys: Option<(u32, u8)>) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&ihdr);
        bytes.extend_from_slice(&[0; 4]);
        if let Some((ppu, unit)) = phys {
            bytes.extend_from_slice(&9u32.to_be_bytes());
            bytes.extend_from_slice(b"pHYs");
            bytes.extend_from_slice(&ppu.to_be_bytes());
            bytes.extend_from_slice(&ppu.to_be_bytes());
            bytes.push(unit);
            bytes.extend_from_slice(&[0; 4]);
        }
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(b"IDAT");
        bytes
    }

    fn jfif(w: u16, h: u16, units: u8, density: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        bytes.extend_from_slice(b"JFIF\0");
        bytes.extend_from_slice(&[1, 1, units]);
        bytes.extend_from_slice(&density.to_be_bytes());
        bytes.extend_from_slice(&density.to_be_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(&[0xFF, 0xC0, 0, 17, 8]);
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes
    }

    #[test]
    fn options_parse_from_the_wire() {
        let opts: ImagesToPdfOptions = serde_json::from_str(
            r#"{"source":{"type":"batch","batch":3},"paper":"letter","orientation":"auto","marginPt":34}"#,
        )
        .unwrap();
        assert_eq!(opts.source, ImageSource::Batch { batch: 3 });
        assert_eq!(opts.paper, PaperSize::Letter);
        let dialog: ImagesToPdfOptions = serde_json::from_str(
            r#"{"source":{"type":"dialog"},"paper":"fit","orientation":"landscape","marginPt":0}"#,
        )
        .unwrap();
        assert_eq!(dialog.source, ImageSource::Dialog);
        assert!(serde_json::from_str::<ImagesToPdfOptions>(
            r#"{"source":{"type":"dialog"},"paper":"a3","orientation":"auto","marginPt":0}"#
        )
        .is_err());
    }

    #[test]
    fn an_order_is_a_bounded_selection_without_repeats() {
        assert_eq!(validate_order(&[2, 0], 3).unwrap(), [2, 0]);
        for bad in [&[][..], &[0, 0][..], &[3][..]] {
            assert!(validate_order(bad, 3).is_err());
        }
        let many: Vec<u32> = (0..501).collect();
        assert!(validate_order(&many, 600).is_err());
    }

    #[test]
    fn margins_are_bounded() {
        let mut opts = ImagesToPdfOptions {
            source: ImageSource::Dialog,
            paper: PaperSize::Fit,
            orientation: Orientation::Auto,
            margin_pt: 72.0,
        };
        assert!(check_options(&opts).is_ok());
        for bad in [-1.0, 72.5, f32::NAN, f32::INFINITY] {
            opts.margin_pt = bad;
            assert!(check_options(&opts).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_header_gives_density_and_size() {
        let png = header_info(&png_header(300, 200, Some((11811, 1))));
        assert_eq!(png.size, Some((300, 200)));
        assert!((png.dpi.unwrap() - 300.0).abs() < 0.1);
        // Unit unknown: no density.
        assert_eq!(header_info(&png_header(3, 2, Some((11811, 0)))).dpi, None);
        assert_eq!(header_info(&png_header(3, 2, None)).dpi, None);
        let jpeg = header_info(&jfif(640, 480, 1, 96));
        assert_eq!(jpeg.size, Some((640, 480)));
        assert_eq!(jpeg.dpi, Some(96.0));
        let per_cm = header_info(&jfif(640, 480, 2, 100));
        assert!((per_cm.dpi.unwrap() - 254.0).abs() < 0.01);
        assert_eq!(header_info(&jfif(1, 1, 0, 1)).dpi, None);
        // Garbage and truncation never panic.
        let (p, j) = (png_header(1, 1, Some((1, 1))), jfif(1, 1, 1, 1));
        for len in 0..40 {
            header_info(&p[..len.min(p.len())]);
            header_info(&j[..len.min(j.len())]);
        }
        assert_eq!(header_info(b"nothing"), HeaderInfo::default());
    }

    #[test]
    fn density_outside_the_range_means_150() {
        assert_eq!(trusted_dpi(Some(300.0)), 300.0);
        assert_eq!(trusted_dpi(Some(72.0)), 72.0);
        assert_eq!(trusted_dpi(Some(1200.0)), 1200.0);
        for bad in [Some(71.9), Some(1200.1), Some(0.0), Some(f32::NAN), None] {
            assert_eq!(trusted_dpi(bad), 150.0);
        }
    }

    #[test]
    fn fit_is_the_image_at_its_density_plus_the_margin() {
        // 600 x 300 px at 300 dpi is 144 x 72 pt.
        let (page, place) = layout(
            (600, 300),
            None,
            Some(300.0),
            PaperSize::Fit,
            Orientation::Auto,
            0.0,
        );
        assert_eq!(page, [144.0, 72.0]);
        assert_eq!(
            (place.x, place.y, place.w, place.h),
            (0.0, 0.0, 144.0, 72.0)
        );
        let (page, place) = layout(
            (600, 300),
            None,
            Some(300.0),
            PaperSize::Fit,
            Orientation::Auto,
            10.0,
        );
        assert_eq!(page, [164.0, 92.0]);
        assert!((place.w - 144.0).abs() < 0.01 && (place.x - 10.0).abs() < 0.01);
        // No density: 150 dpi. 1500 px is 720 pt.
        let (page, _) = layout(
            (1500, 750),
            None,
            None,
            PaperSize::Fit,
            Orientation::Auto,
            0.0,
        );
        assert_eq!(page, [720.0, 360.0]);
    }

    #[test]
    fn fit_uses_the_declared_size_when_the_image_was_shrunk() {
        // Stored at 4096, the file was 8192 wide at 150 dpi: 8192 * 72 / 150 = 3932.16 pt.
        let (page, _) = layout(
            (4096, 2048),
            Some(8192),
            None,
            PaperSize::Fit,
            Orientation::Auto,
            0.0,
        );
        assert!((page[0] - 3932.16).abs() < 0.01 && (page[1] - 1966.08).abs() < 0.01);
    }

    #[test]
    fn fit_clamps_the_page_sides() {
        let (page, place) = layout(
            (10, 10),
            None,
            Some(1200.0),
            PaperSize::Fit,
            Orientation::Auto,
            0.0,
        );
        assert_eq!(page, [72.0, 72.0]);
        assert!(place.w <= 72.0);
        let (page, place) = layout(
            (10_000, 100),
            Some(20_000),
            Some(72.0),
            PaperSize::Fit,
            Orientation::Auto,
            0.0,
        );
        assert_eq!(page[0], 14_400.0);
        assert_eq!(page[1], 200.0);
        assert!(place.w <= 14_400.0 && place.x >= 0.0);
        // Never cropped: the image stays inside the page.
        assert!(place.y >= 0.0 && place.y + place.h <= page[1] + 0.001);
    }

    #[test]
    fn a4_and_letter_scale_to_fit_and_centre() {
        let (page, place) = layout(
            (2000, 1000),
            None,
            None,
            PaperSize::A4,
            Orientation::Auto,
            36.0,
        );
        // Wide image: landscape A4.
        assert!((page[0] - 841.89).abs() < 0.01 && (page[1] - 595.276).abs() < 0.01);
        assert!((place.w - (841.89 - 72.0)).abs() < 0.01);
        assert!((place.h - place.w / 2.0).abs() < 0.01);
        assert!((place.x - 36.0).abs() < 0.01);
        assert!((place.y - (page[1] - place.h) / 2.0).abs() < 0.01);
        // Tall image: portrait Letter; the height decides.
        let (page, place) = layout(
            (500, 2000),
            None,
            None,
            PaperSize::Letter,
            Orientation::Auto,
            0.0,
        );
        assert_eq!(page, [612.0, 792.0]);
        assert!((place.h - 792.0).abs() < 0.01 && place.w < 612.0);
        assert!((place.x - (612.0 - place.w) / 2.0).abs() < 0.01);
    }

    #[test]
    fn orientation_can_be_forced() {
        let wide = (2000, 1000);
        let (page, place) = layout(
            wide,
            None,
            None,
            PaperSize::Letter,
            Orientation::Portrait,
            0.0,
        );
        assert_eq!(page, [612.0, 792.0]);
        assert!((place.w - 612.0).abs() < 0.01 && place.h < 792.0);
        let (page, _) = layout(
            (1000, 2000),
            None,
            None,
            PaperSize::A4,
            Orientation::Landscape,
            0.0,
        );
        assert!(page[0] > page[1]);
        // Fit with a forced orientation swaps the page and keeps the image inside it.
        let (page, place) = layout(
            wide,
            None,
            Some(200.0),
            PaperSize::Fit,
            Orientation::Portrait,
            0.0,
        );
        assert!(page[1] >= page[0]);
        assert!(place.w <= page[0] + 0.001 && place.h <= page[1] + 0.001);
    }

    #[test]
    fn the_largest_margin_leaves_room_on_every_page() {
        for paper in [PaperSize::Fit, PaperSize::A4, PaperSize::Letter] {
            for size in [(1, 1), (1, 8000), (8000, 1), (500, 500)] {
                let (page, place) = layout(size, None, None, paper, Orientation::Auto, 72.0);
                assert!(place.w > 0.0 && place.h > 0.0, "{paper:?} {size:?}");
                assert!(place.x >= 0.0 && place.y >= 0.0);
                assert!(place.x + place.w <= page[0] + 0.01);
                assert!(place.y + place.h <= page[1] + 0.01);
            }
        }
    }
}
