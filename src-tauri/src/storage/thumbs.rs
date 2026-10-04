//! First-page thumbnails of the recent files (DESIGN 3.48, ADR-054 (3)): small `SHR1` frames in the app cache directory.
//!
//! - **Key.** One file per recent file, named by a hash of its canonical path (`<16 hex>.shr`). The recents id of the UI is only good
//!   for one run (`storage::recents`), so it cannot name a file that outlives the run; the backend maps the id to the path.
//! - **Content.** The first page at most [`THUMB_WIDTH`] x [`THUMB_HEIGHT`] pixels (the 2x size of the 32 x 40 slot), made by
//!   [`make_frame`] from a frame of the engine. A document with a password is never cached (the caller's rule: a decrypted page
//!   must not land on disk).
//! - **Bounds.** A file is at most [`MAX_THUMB_BYTES`] and a read never takes more; [`ThumbCache::retain`] removes every file that is
//!   not for a listed recent file, so there are at most `MAX_RECENTS` files. Nothing in the directory is trusted when read.
//! - **Private.** Files are written atomically and, on Unix, for the owner alone (`storage::atomic`).

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use image::imageops::FilterType;

use crate::engine::encode::{FORMAT_PNG_RGB, FRAME_HEADER_BYTES, FRAME_MAGIC};
use crate::error::{AppError, ErrorCode};
use crate::storage::atomic::write_atomic;
use crate::storage::open_without_blocking;

/// Largest thumbnail, in pixels (the 32 x 40 slot at device pixel ratio 2).
pub const THUMB_WIDTH: u32 = 64;
pub const THUMB_HEIGHT: u32 = 80;
/// Largest cached file; a bigger one is neither written nor read.
pub const MAX_THUMB_BYTES: u64 = 128 * 1024;
/// Zoom bucket the first page is drawn at before it is fitted (about 0.105 pixels per point: a letter page is 64 x 83).
pub const RENDER_BUCKET: i16 = -13;

const EXTENSION: &str = "shr";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The thumbnails of the recent files. All state is on disk.
#[derive(Debug)]
pub struct ThumbCache {
    dir: PathBuf,
}

impl ThumbCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The file name stem for `path`: FNV-1a (64 bit) of its bytes in hex. A name, not a secret: two paths that collide would show
    /// each other's preview, which 2^64 does not make a concern for 50 files.
    pub fn key(path: &Path) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in path.as_os_str().as_encoded_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    fn file_of(&self, path: &Path) -> PathBuf {
        self.dir.join(format!("{}.{EXTENSION}", Self::key(path)))
    }

    /// Writes the thumbnail of `path`. Refuses a frame that is not a valid thumbnail frame within the bounds.
    pub fn store(&self, path: &Path, frame: &[u8]) -> io::Result<()> {
        if frame.len() as u64 > MAX_THUMB_BYTES || !is_thumb_frame(frame) {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        write_atomic(&self.file_of(path), frame)
    }

    /// The cached frame for `path`, if there is a valid one. Anything else (missing, not a regular file, oversized, damaged) is `None`.
    pub fn load(&self, path: &Path) -> Option<Vec<u8>> {
        let file: File = open_without_blocking(&self.file_of(path)).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_THUMB_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() as u64 <= MAX_THUMB_BYTES && is_thumb_frame(&bytes)).then_some(bytes)
    }

    /// Whether a thumbnail file exists for `path`.
    pub fn has(&self, path: &Path) -> bool {
        self.file_of(path).is_file()
    }

    /// Deletes the thumbnail of `path`, if any.
    pub fn evict(&self, path: &Path) {
        let _ = fs::remove_file(self.file_of(path));
    }

    /// Deletes every thumbnail that is not for one of `keep` (every `*.shr`; other files are not ours). Returns how many went.
    pub fn retain(&self, keep: &[PathBuf]) -> usize {
        let wanted: Vec<String> = keep
            .iter()
            .map(|path| format!("{}.{EXTENSION}", Self::key(path)))
            .collect();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let ours = Path::new(name).extension().is_some_and(|e| e == EXTENSION);
            if ours && !wanted.iter().any(|w| w == name) && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }
}

/// Whether `bytes` are an `SHR1` PNG frame no bigger than a thumbnail, with a PNG behind the header.
fn is_thumb_frame(bytes: &[u8]) -> bool {
    if bytes.len() <= FRAME_HEADER_BYTES || bytes[..4] != FRAME_MAGIC || bytes[4] != FORMAT_PNG_RGB
    {
        return false;
    }
    let word =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let (width, height) = (word(8), word(12));
    (1..=THUMB_WIDTH).contains(&width)
        && (1..=THUMB_HEIGHT).contains(&height)
        && bytes[FRAME_HEADER_BYTES..].starts_with(PNG_SIGNATURE)
}

/// The thumbnail frame made from a frame of the engine (`SHR1`, PNG): fitted into [`THUMB_WIDTH`] x [`THUMB_HEIGHT`], aspect kept.
pub fn make_frame(engine_frame: &[u8]) -> Result<Vec<u8>, AppError> {
    if engine_frame.len() <= FRAME_HEADER_BYTES || engine_frame[..4] != FRAME_MAGIC {
        return Err(AppError::logged(
            ErrorCode::Internal,
            "thumbnail: not a frame",
        ));
    }
    let picture = image::load_from_memory_with_format(
        &engine_frame[FRAME_HEADER_BYTES..],
        image::ImageFormat::Png,
    )
    .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    let fitted = picture
        .resize(THUMB_WIDTH, THUMB_HEIGHT, FilterType::Triangle)
        .to_rgba8();
    let png = crate::signatures::raster::encode_png(&fitted)?;
    Ok(crate::signatures::preview_frame(
        fitted.width(),
        fitted.height(),
        &png,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::encode::{encode_frame, split_frame};
    use crate::storage::atomic::testutil::TempDir;

    fn engine_frame(width: u32, height: u32) -> Vec<u8> {
        let data = vec![255u8; (width * height * 3) as usize];
        encode_frame(width, height, (width * 3) as usize, &data).unwrap()
    }

    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join("sheer-thumbs-test").join(name)
    }

    #[test]
    fn a_page_is_fitted_into_the_thumbnail_box_with_its_aspect() {
        let portrait = make_frame(&engine_frame(300, 400)).unwrap();
        let (w, h, _) = split_frame(&portrait);
        assert_eq!((w, h), (60, 80));
        let landscape = make_frame(&engine_frame(400, 300)).unwrap();
        let (w, h, _) = split_frame(&landscape);
        assert_eq!((w, h), (64, 48));
        assert!(make_frame(b"nope").is_err());
        assert!(make_frame(&[0u8; 40]).is_err());
    }

    #[test]
    fn a_stored_thumbnail_is_read_back_and_evicted() {
        let dir = TempDir::new();
        let cache = ThumbCache::new(dir.path().join("thumbs"));
        let frame = make_frame(&engine_frame(300, 400)).unwrap();
        assert!(cache.load(&abs("a.pdf")).is_none());
        cache.store(&abs("a.pdf"), &frame).unwrap();
        assert!(cache.has(&abs("a.pdf")));
        assert_eq!(cache.load(&abs("a.pdf")), Some(frame));
        assert!(cache.load(&abs("b.pdf")).is_none());
        cache.evict(&abs("a.pdf"));
        assert!(!cache.has(&abs("a.pdf")));
        cache.evict(&abs("a.pdf"));
    }

    #[test]
    fn only_valid_frames_within_the_bounds_are_stored_or_read() {
        let dir = TempDir::new();
        let cache = ThumbCache::new(dir.path().to_path_buf());
        // A frame bigger than a thumbnail, junk, and an oversized file are all refused.
        assert!(cache.store(&abs("a.pdf"), &engine_frame(65, 10)).is_err());
        assert!(cache.store(&abs("a.pdf"), b"junk").is_err());
        let mut big = make_frame(&engine_frame(300, 400)).unwrap();
        big.resize(MAX_THUMB_BYTES as usize + 1, 0);
        assert!(cache.store(&abs("a.pdf"), &big).is_err());
        // A planted file is not trusted either.
        fs::write(cache.file_of(&abs("a.pdf")), &big).unwrap();
        assert!(cache.load(&abs("a.pdf")).is_none());
        fs::remove_file(cache.file_of(&abs("a.pdf"))).unwrap();
        fs::create_dir(cache.file_of(&abs("a.pdf"))).unwrap();
        assert!(cache.load(&abs("a.pdf")).is_none());
    }

    #[test]
    fn retain_removes_every_thumbnail_that_is_not_listed() {
        let dir = TempDir::new();
        let cache = ThumbCache::new(dir.path().to_path_buf());
        let frame = make_frame(&engine_frame(300, 400)).unwrap();
        for name in ["a.pdf", "b.pdf", "c.pdf"] {
            cache.store(&abs(name), &frame).unwrap();
        }
        fs::write(dir.path().join("note.txt"), b"x").unwrap();
        assert_eq!(cache.retain(&[abs("b.pdf")]), 2);
        assert!(cache.has(&abs("b.pdf")) && !cache.has(&abs("a.pdf")));
        assert!(dir.path().join("note.txt").exists(), "not ours");
        assert_eq!(cache.retain(&[]), 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_cache_is_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let cache = ThumbCache::new(dir.path().join("cache").join("thumbs"));
        cache
            .store(&abs("a.pdf"), &make_frame(&engine_frame(300, 400)).unwrap())
            .unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&cache.dir), 0o700);
        assert_eq!(mode(&cache.file_of(&abs("a.pdf"))), 0o600);
    }

    #[test]
    fn keys_differ_per_path_and_are_stable() {
        assert_eq!(
            ThumbCache::key(&abs("a.pdf")),
            ThumbCache::key(&abs("a.pdf"))
        );
        assert_ne!(
            ThumbCache::key(&abs("a.pdf")),
            ThumbCache::key(&abs("b.pdf"))
        );
        assert_eq!(ThumbCache::key(&abs("a.pdf")).len(), 16);
    }
}
