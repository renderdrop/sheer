//! The bounds of the OCR pipe (ADR-134 item 9). A request is checked before anything is allocated for it; a reply is untrusted.

use std::time::Duration;

/// The longest side of a bitmap handed to the recognizer (Windows takes 10000).
pub const MAX_SIDE_PX: u32 = 8000;
/// The most pixels of one bitmap.
pub const MAX_PIXELS: u64 = 40_000_000;
/// The most words of one page a reply may hold.
pub const MAX_WORDS: usize = 20_000;
/// The most characters of one word.
pub const MAX_WORD_CHARS: usize = 128;
/// The most bytes of a reply header (the JSON).
pub const MAX_REPLY: usize = 8 * 1024 * 1024;
/// The most bytes of a request header.
pub const MAX_REQUEST_HEADER: usize = 4096;
/// How long one page may take before the child is killed.
pub const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// The languages a request may name.
pub const LANGUAGES: &[&str] = &["de-DE", "en-US"];
