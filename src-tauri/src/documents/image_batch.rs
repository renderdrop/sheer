//! Dropped image files held for Create PDF from images (ADR-049 §3): opened once, judged as regular files, PNG or JPEG by their
//! magic bytes; at most `limits::MAX_IMAGE_BATCH` per batch, kept `limits::IMAGE_BATCH_TTL`.
//!
//! A batch keeps the open handles, not the paths: the file that was judged is the file that is read, and a path never reaches the
//! webview (SECURITY T9). A job reads through a duplicate of the handle, so a failed job leaves the batch for another try.

use std::cmp::Ordering;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Instant;

use crate::error::AppError;
use crate::limits;

/// What a dropped file is, judged on its handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dropped {
    /// PNG or JPEG by the first bytes.
    Image,
    /// Starts like a PDF (`%PDF-` within the first KiB).
    Pdf,
    /// Anything else, or not a regular file, or unreadable.
    Other,
}

/// Judges what `head` (the first bytes of a file) is.
pub fn classify_head(head: &[u8]) -> Dropped {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") || head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Dropped::Image
    } else if head.windows(5).any(|w| w == b"%PDF-") {
        Dropped::Pdf
    } else {
        Dropped::Other
    }
}

/// One held image: its file name's stem for the default target name, and the handle.
#[derive(Debug)]
pub struct HeldImage {
    pub stem: String,
    file: File,
}

impl HeldImage {
    /// A second handle on the same file, positioned at the start.
    pub fn reopen(&self) -> Result<File, AppError> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
}

/// The files of one drop that are images, in natural name order.
#[derive(Debug)]
pub struct ImageBatch {
    pub images: Vec<HeldImage>,
}

/// Opens `path` as a dropped file (a plain local spelling, a regular file) and says what it is. The handle is positioned at the start.
pub fn sniff(path: &Path) -> Option<(File, Dropped)> {
    if !crate::documents::intake::spelling_is_plain(path) {
        return None;
    }
    let mut file = crate::storage::open_without_blocking(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut head = [0u8; 1024];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    file.seek(SeekFrom::Start(0)).ok()?;
    Some((file, classify_head(&head[..filled])))
}

fn digits_of(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(c) = it.next_if(char::is_ascii_digit) {
        digits.push(c);
    }
    digits
}

/// Natural order of file names: runs of digits compare as numbers, the rest case-insensitively (`img2` before `img10`).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (da, db) = (digits_of(&mut a), digits_of(&mut b));
                let (da, db) = (da.trim_start_matches('0'), db.trim_start_matches('0'));
                let order = da.len().cmp(&db.len()).then_with(|| da.cmp(db));
                if order.is_ne() {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order.is_ne() {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Sorts paths by the natural order of their file names.
pub fn sort_natural(paths: &mut [PathBuf]) {
    paths.sort_by(|a, b| natural_cmp(&file_name_of(a), &file_name_of(b)).then_with(|| a.cmp(b)));
}

/// The stem of the file at `path` for a name suggestion (`photo.JPG` is `photo`); `images` when there is none.
pub fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "images".to_owned())
}

struct Held {
    id: u32,
    at: Instant,
    batch: Arc<ImageBatch>,
}

#[derive(Default)]
struct Inner {
    last: u32,
    held: Vec<Held>,
}

/// The batches of the app: ids are never reused, a batch expires after `IMAGE_BATCH_TTL`.
#[derive(Default)]
pub struct ImageBatches {
    inner: Mutex<Inner>,
}

impl ImageBatches {
    pub fn new() -> Self {
        Self::default()
    }

    fn purge(held: &mut Vec<Held>, now: Instant) {
        held.retain(|h| now.duration_since(h.at) < limits::IMAGE_BATCH_TTL);
    }

    /// Holds `batch` (images from the drop, already in order) and returns its id. At most `MAX_IMAGE_BATCH` images are kept.
    pub fn add(&self, mut batch: ImageBatch) -> u32 {
        batch.images.truncate(limits::MAX_IMAGE_BATCH);
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        Self::purge(&mut inner.held, now);
        inner.last = inner.last.wrapping_add(1);
        let id = inner.last;
        inner.held.push(Held {
            id,
            at: now,
            batch: Arc::new(batch),
        });
        id
    }

    /// The batch `id`, if it is held and has not expired.
    pub fn get(&self, id: u32) -> Option<Arc<ImageBatch>> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        Self::purge(&mut inner.held, Instant::now());
        inner
            .held
            .iter()
            .find(|h| h.id == id)
            .map(|h| Arc::clone(&h.batch))
    }

    /// Lets go of a batch; an unknown id is nothing.
    pub fn release(&self, id: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.held.retain(|h| h.id != id);
    }

    #[cfg(test)]
    fn age(&self, id: u32, by: std::time::Duration) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        for h in &mut inner.held {
            if h.id == id {
                h.at = h.at.checked_sub(by).unwrap_or(h.at);
            }
        }
    }
}

/// The batches of the app.
pub fn batches() -> &'static ImageBatches {
    static BATCHES: OnceLock<ImageBatches> = OnceLock::new();
    BATCHES.get_or_init(ImageBatches::new)
}

/// What a drop turned into.
#[derive(Debug, Default)]
pub struct Sorted {
    pub pdfs: Vec<PathBuf>,
    pub images: Vec<HeldImage>,
    /// Files that are neither (only counted when images were dropped too: a drop without images opens everything as before).
    pub skipped: u32,
}

/// Splits dropped `paths`: PNG/JPEG handles in natural name order, PDF paths in drop order. A drop without any image is returned
/// whole as `pdfs` (the open path judges and reports each file as it always did).
pub fn sort_drop(paths: Vec<PathBuf>) -> Sorted {
    let mut pdfs = Vec::new();
    let mut images: Vec<(PathBuf, File)> = Vec::new();
    let mut others = Vec::new();
    for path in paths {
        match sniff(&path) {
            Some((file, Dropped::Image)) => images.push((path, file)),
            Some((_, Dropped::Pdf)) => pdfs.push(path),
            _ => others.push(path),
        }
    }
    if images.is_empty() {
        pdfs.extend(others);
        return Sorted {
            pdfs,
            ..Sorted::default()
        };
    }
    images.sort_by(|a, b| {
        natural_cmp(&file_name_of(&a.0), &file_name_of(&b.0)).then_with(|| a.0.cmp(&b.0))
    });
    let too_many = images.len().saturating_sub(limits::MAX_IMAGE_BATCH);
    images.truncate(limits::MAX_IMAGE_BATCH);
    let skipped = others.len() + too_many;
    Sorted {
        pdfs,
        images: images
            .into_iter()
            .map(|(path, file)| HeldImage {
                stem: stem_of(&path),
                file,
            })
            .collect(),
        skipped: u32::try_from(skipped).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    #[test]
    fn heads_are_told_apart() {
        assert_eq!(classify_head(b"\x89PNG\r\n\x1a\nrest"), Dropped::Image);
        assert_eq!(classify_head(&[0xFF, 0xD8, 0xFF, 0xE0]), Dropped::Image);
        assert_eq!(classify_head(b"%PDF-1.7\n"), Dropped::Pdf);
        assert_eq!(classify_head(b"\xEF\xBB\xBF%PDF-1.4"), Dropped::Pdf);
        assert_eq!(classify_head(b"hello"), Dropped::Other);
        assert_eq!(classify_head(b""), Dropped::Other);
    }

    #[test]
    fn names_sort_naturally() {
        assert_eq!(natural_cmp("img2.png", "img10.png"), Ordering::Less);
        assert_eq!(natural_cmp("IMG2.png", "img2.PNG"), Ordering::Equal);
        assert_eq!(natural_cmp("a01", "a1"), Ordering::Equal);
        assert_eq!(natural_cmp("a", "ab"), Ordering::Less);
        let mut paths: Vec<PathBuf> = ["p10.png", "p9.png", "p1.png"]
            .iter()
            .map(Into::into)
            .collect();
        sort_natural(&mut paths);
        assert_eq!(paths[0].to_str(), Some("p1.png"));
        assert_eq!(paths[2].to_str(), Some("p10.png"));
    }

    #[test]
    fn a_mixed_drop_splits_into_pdfs_images_and_skipped() {
        let dir = TempDir::new();
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let png = b"\x89PNG\r\n\x1a\n0000";
        let paths = vec![
            write("b10.png", png),
            write("doc.pdf", b"%PDF-1.4\n"),
            write("b9.PNG", png),
            write("notes.txt", b"text"),
            dir.path().join("gone.png"),
        ];
        let sorted = sort_drop(paths);
        assert_eq!(sorted.pdfs.len(), 1);
        let stems: Vec<&str> = sorted.images.iter().map(|i| i.stem.as_str()).collect();
        assert_eq!(stems, ["b9", "b10"]);
        assert_eq!(sorted.skipped, 2);
    }

    #[test]
    fn a_drop_without_images_is_left_to_the_open_path() {
        let dir = TempDir::new();
        let text = dir.path().join("notes.pdf");
        std::fs::write(&text, b"plain").unwrap();
        let sorted = sort_drop(vec![text.clone()]);
        assert_eq!(sorted.pdfs, [text]);
        assert!(sorted.images.is_empty());
        assert_eq!(sorted.skipped, 0);
    }

    #[test]
    fn batches_expire_and_can_be_released() {
        let batches = ImageBatches::new();
        let one = batches.add(ImageBatch { images: Vec::new() });
        let two = batches.add(ImageBatch { images: Vec::new() });
        assert_ne!(one, two);
        assert!(batches.get(one).is_some());
        batches.release(one);
        batches.release(one);
        assert!(batches.get(one).is_none());
        batches.age(two, limits::IMAGE_BATCH_TTL + Duration::from_secs(1));
        assert!(batches.get(two).is_none());
    }

    #[test]
    fn a_held_image_can_be_read_again_from_the_start() {
        let dir = TempDir::new();
        let path = dir.path().join("a.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nabc").unwrap();
        let sorted = sort_drop(vec![path]);
        for _ in 0..2 {
            let mut bytes = Vec::new();
            sorted.images[0]
                .reopen()
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            assert!(bytes.starts_with(b"\x89PNG"));
        }
    }
}
