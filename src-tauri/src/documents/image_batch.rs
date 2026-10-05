//! Dropped image files held for Create PDF from images (ADR-049 §3): opened once, judged as regular files, PNG or JPEG by their
//! magic bytes; at most `limits::MAX_IMAGE_BATCH` per batch, kept `limits::IMAGE_BATCH_TTL`.
//!
//! A batch keeps the open handles, not the paths: the file that was judged is the file that is read, and a path never reaches the
//! webview (SECURITY T9). A job reads through a duplicate of the handle, so a failed job leaves the batch for another try.

use std::cmp::Ordering;
use std::collections::HashMap;
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

/// One held image: its file name's stem for the default target name, the display name, and the handle.
#[derive(Debug)]
pub struct HeldImage {
    pub stem: String,
    /// The file name only (no folder), without control characters, at most `MAX_BATCH_NAME_CHARS` characters.
    pub name: String,
    file: File,
    size: OnceLock<(u32, u32)>,
}

impl HeldImage {
    pub fn new(path: &Path, file: File) -> Self {
        Self {
            stem: stem_of(path),
            name: display_name(path),
            file,
            size: OnceLock::new(),
        }
    }

    /// A second handle on the same file, positioned at the start. A duplicated handle SHARES the file offset with the original, so
    /// reading through it is only safe for one reader at a time; the readers use [`Self::read_limited`] instead.
    #[cfg(test)]
    pub fn reopen(&self) -> Result<File, AppError> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }

    /// The whole file (`too_large` over `max`; `invalid` when empty or not a regular file), read at explicit offsets: concurrent
    /// readers (thumbnails, the list, the job) never move each other's position (ADR-106).
    pub fn read_limited(&self, max: u64) -> Result<Vec<u8>, AppError> {
        let meta = self.file.metadata()?;
        if !meta.is_file() || meta.len() == 0 {
            return Err(AppError::invalid("image"));
        }
        if meta.len() > max {
            return Err(AppError::too_large("image", max));
        }
        // The size can change after it was looked at: the read stops one byte past the limit.
        let want = usize::try_from(max.min(meta.len()).saturating_add(1)).unwrap_or(usize::MAX);
        let mut bytes = vec![0u8; want];
        let filled = read_filled(&self.file, &mut bytes)?;
        bytes.truncate(filled);
        if bytes.len() as u64 > max {
            return Err(AppError::too_large("image", max));
        }
        Ok(bytes)
    }

    fn duplicate(&self) -> Result<Self, AppError> {
        let size = OnceLock::new();
        if let Some(known) = self.size.get() {
            let _ = size.set(*known);
        }
        Ok(Self {
            stem: self.stem.clone(),
            name: self.name.clone(),
            file: self.file.try_clone()?,
            size,
        })
    }

    /// The size the file's header declares, `(0, 0)` when it cannot be read; read once.
    pub fn declared_size(&self) -> (u32, u32) {
        *self.size.get_or_init(|| {
            let mut head = vec![0u8; HEADER_READ_BYTES];
            let Ok(filled) = read_filled(&self.file, &mut head) else {
                return (0, 0);
            };
            head.truncate(filled);
            crate::export::from_images::header_info(&head)
                .size
                .unwrap_or((0, 0))
        })
    }
}

/// How much of a file is read to find its size (a JPEG's frame header can follow a large EXIF block).
const HEADER_READ_BYTES: usize = 256 * 1024;

/// One read at `offset` that does not use the handle's own position.
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    #[cfg(windows)]
    {
        std::os::windows::fs::FileExt::seek_read(file, buf, offset)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::FileExt::read_at(file, buf, offset)
    }
    #[cfg(not(any(windows, unix)))]
    {
        // No positional read on this target: nothing can be read, so the file is reported as unreadable (the app ships for Windows and macOS only).
        let _ = (file, buf, offset);
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }
}

/// Fills `buf` from the start of the file as far as the file goes; the number of bytes read.
fn read_filled(file: &File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match read_at(file, &mut buf[filled..], filled as u64) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// The file name of `path` for the UI: no folder, no control characters, bounded.
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(limits::MAX_BATCH_NAME_CHARS)
        .collect()
}

/// The files of one drop that are images, in natural name order.
#[derive(Debug)]
pub struct ImageBatch {
    pub images: Vec<HeldImage>,
}

/// Opens `path` as a dropped file; the refusal is static text (no path, no name) for the local log.
fn sniff_checked(path: &Path) -> Result<(File, Dropped), &'static str> {
    if !crate::documents::intake::spelling_is_plain(path) {
        return Err("not a plain local path");
    }
    let mut file = crate::storage::open_without_blocking(path).map_err(|_| "cannot be opened")?;
    if !file.metadata().map_err(|_| "no metadata")?.is_file() {
        return Err("not a regular file");
    }
    let mut head = [0u8; 1024];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return Err("cannot be read"),
        }
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "cannot be rewound")?;
    Ok((file, classify_head(&head[..filled])))
}

/// Opens `path` as a dropped file (a plain local spelling, a regular file) and says what it is. The handle is positioned at the start.
/// The reason for a refusal goes to the local log, without path or name.
pub fn sniff(path: &Path) -> Option<(File, Dropped)> {
    match sniff_checked(path) {
        Ok(found) => Some(found),
        Err(reason) => {
            eprintln!("sheer: dropped file skipped: {reason}");
            None
        }
    }
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
    /// Thumbnails by (index, long side); indices never move, so they stay valid when images are appended.
    previews: HashMap<(u32, u16), Arc<Vec<u8>>>,
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

    /// Makes room for one more batch: the oldest go, and with them their handles.
    fn evict(held: &mut Vec<Held>) {
        let over = (held.len() + 1).saturating_sub(limits::MAX_LIVE_IMAGE_BATCHES);
        if over > 0 {
            held.drain(..over.min(held.len()));
        }
    }

    #[cfg(test)]
    fn live(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .held
            .len()
    }

    /// Holds `batch` (images from the drop, already in order) and returns its id. At most `MAX_IMAGE_BATCH` images are kept.
    pub fn add(&self, mut batch: ImageBatch) -> u32 {
        batch.images.truncate(limits::MAX_IMAGE_BATCH);
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        Self::purge(&mut inner.held, now);
        Self::evict(&mut inner.held);
        inner.last = inner.last.wrapping_add(1);
        let id = inner.last;
        inner.held.push(Held {
            id,
            at: now,
            batch: Arc::new(batch),
            previews: HashMap::new(),
        });
        id
    }

    /// Appends `images` to batch `id` (a new batch when `id` is `None`) and returns its id and the number kept (the batch holds at
    /// most `MAX_IMAGE_BATCH`). `None`: the batch is unknown or expired.
    pub fn append(
        &self,
        id: Option<u32>,
        images: Vec<HeldImage>,
    ) -> Result<Option<(u32, usize)>, AppError> {
        let Some(id) = id else {
            let kept = images.len().min(limits::MAX_IMAGE_BATCH);
            return Ok(Some((self.add(ImageBatch { images }), kept)));
        };
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        Self::purge(&mut inner.held, Instant::now());
        let Some(held) = inner.held.iter_mut().find(|h| h.id == id) else {
            return Ok(None);
        };
        let mut all = held
            .batch
            .images
            .iter()
            .map(HeldImage::duplicate)
            .collect::<Result<Vec<_>, _>>()?;
        let room = limits::MAX_IMAGE_BATCH.saturating_sub(all.len());
        let kept = images.len().min(room);
        all.extend(images.into_iter().take(kept));
        held.batch = Arc::new(ImageBatch { images: all });
        Ok(Some((id, kept)))
    }

    /// A thumbnail frame cached for (`id`, `index`, `px`).
    pub fn cached_preview(&self, id: u32, index: u32, px: u16) -> Option<Arc<Vec<u8>>> {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let held = inner.held.iter().find(|h| h.id == id)?;
        held.previews.get(&(index, px)).cloned()
    }

    /// Remembers a thumbnail frame (bounded by `MAX_BATCH_PREVIEWS` per batch).
    pub fn cache_preview(&self, id: u32, index: u32, px: u16, frame: Arc<Vec<u8>>) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = inner.held.iter_mut().find(|h| h.id == id) {
            if held.previews.len() < limits::MAX_BATCH_PREVIEWS {
                held.previews.insert((index, px), frame);
            }
        }
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
    let mut too_many = 0usize;
    for path in paths {
        match sniff(&path) {
            Some((file, Dropped::Image)) => {
                if images.len() < limits::MAX_IMAGE_BATCH {
                    images.push((path, file));
                } else {
                    // Over the cap: the handle is closed at once, not held until the end of the drop.
                    drop(file);
                    too_many += 1;
                    eprintln!("sheer: dropped file skipped: over the batch limit");
                }
            }
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
    let skipped = others.len() + too_many;
    Sorted {
        pdfs,
        images: images
            .into_iter()
            .map(|(path, file)| HeldImage::new(&path, file))
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
    fn names_are_shown_without_folder_or_control_characters() {
        assert_eq!(display_name(Path::new("dir/photo.png")), "photo.png");
        assert_eq!(display_name(Path::new("a\u{7}b.png")), "ab.png");
        let long = "x".repeat(300);
        assert_eq!(
            display_name(Path::new(&long)).chars().count(),
            limits::MAX_BATCH_NAME_CHARS
        );
    }

    #[test]
    fn appending_keeps_indices_and_the_batch_size_bounded() {
        let dir = TempDir::new();
        let make = |name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, b"\x89PNG\r\n\x1a\nabc").unwrap();
            HeldImage::new(&path, File::open(&path).unwrap())
        };
        let batches = ImageBatches::new();
        let (id, kept) = batches.append(None, vec![make("a.png")]).unwrap().unwrap();
        assert_eq!(kept, 1);
        batches.cache_preview(id, 0, 64, Arc::new(vec![1]));
        let (same, kept) = batches
            .append(Some(id), vec![make("b.png")])
            .unwrap()
            .unwrap();
        assert_eq!((same, kept), (id, 1));
        let held = batches.get(id).unwrap();
        let names: Vec<&str> = held.images.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["a.png", "b.png"]);
        assert!(batches.cached_preview(id, 0, 64).is_some());
        assert!(batches
            .append(Some(id + 100), vec![make("c.png")])
            .unwrap()
            .is_none());
    }

    #[test]
    fn the_oldest_live_batch_is_evicted_and_its_handles_closed() {
        let dir = TempDir::new();
        let path = dir.path().join("a.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nabc").unwrap();
        let batches = ImageBatches::new();
        let add = || {
            let image = HeldImage::new(&path, File::open(&path).unwrap());
            batches.add(ImageBatch {
                images: vec![image],
            })
        };
        let first = add();
        let weak = Arc::downgrade(&batches.get(first).unwrap());
        let mut last = first;
        for _ in 0..limits::MAX_LIVE_IMAGE_BATCHES {
            last = add();
        }
        assert_eq!(batches.live(), limits::MAX_LIVE_IMAGE_BATCHES);
        assert!(batches.get(first).is_none());
        assert!(batches.get(last).is_some());
        assert!(weak.upgrade().is_none(), "the evicted handles are gone");
    }

    #[test]
    fn a_drop_over_the_cap_keeps_only_the_cap_and_counts_the_rest() {
        let dir = TempDir::new();
        let paths: Vec<PathBuf> = (0..limits::MAX_IMAGE_BATCH + 3)
            .map(|i| {
                let path = dir.path().join(format!("i{i}.png"));
                std::fs::write(&path, b"\x89PNG\r\n\x1a\nabc").unwrap();
                path
            })
            .collect();
        let sorted = sort_drop(paths);
        assert_eq!(sorted.images.len(), limits::MAX_IMAGE_BATCH);
        assert_eq!(sorted.skipped, 3);
    }

    #[test]
    fn a_refusal_has_a_reason_without_path_or_name() {
        let dir = TempDir::new();
        let missing = dir.path().join("secret-name.png");
        let reason = sniff_checked(&missing).err().unwrap();
        assert!(!reason.contains("secret"));
        assert_eq!(sniff_checked(dir.path()).err(), Some("not a regular file"));
    }

    #[test]
    fn concurrent_readers_of_one_held_image_all_get_the_whole_file() {
        let dir = TempDir::new();
        let path = dir.path().join("a.png");
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        data.extend((0..300_000u32).map(|i| (i % 251) as u8));
        std::fs::write(&path, &data).unwrap();
        let sorted = sort_drop(vec![path]);
        let image = &sorted.images[0];
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| image.read_limited(1 << 20).unwrap()))
                .collect();
            for job in jobs {
                assert_eq!(job.join().unwrap(), data);
            }
        });
        assert!(image.read_limited(10).is_err());
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
