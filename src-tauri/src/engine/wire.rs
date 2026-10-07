// message types, codec and caps: W0 seam of ADR-053; the header serializer (postcard) arrives with package B1
//! The parent-to-child wire of the engine process (ADR-053 §1.3, ARCHITECTURE §11.1).
//!
//! A frame is `u32 LE len | u8 kind | u32 LE seq | u32 LE header_len | header | blob`, where `len` counts everything after itself.
//! The header is the serde form of one message ([`WireRequest`], [`WireReply`], [`WireRead`], [`Hello`], [`Ready`]); bulk bytes
//! (frames, rasters, snapshot and source bytes, file reads) travel raw in `blob`. This module owns the shapes, the framing and the
//! size caps; choosing the header encoding (postcard) belongs to the transport. The framing takes the header as bytes.
//!
//! The child is less trusted than the parent: [`read_frame`] checks every length against [`FrameCaps`] *before* it allocates, and
//! [`reply_caps`] gives the caps for the reply to a given request, so a lying child cannot make the parent allocate more than the
//! largest legitimate answer.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::files::FileToken;
use super::{LinkTarget, PageLink, PageSpot};
use crate::documents::{DocFlags, DocumentId};
use crate::error::{AppError, ErrorCode};
use crate::export::snapshot::{EngineDocRef, SnapshotId};
use crate::limits;
use crate::model::annotation::Imported;
use crate::model::geometry::{Quad, Rect};
use crate::model::page::BoxesRead;
use crate::security::links::classify;

use super::outline::OutlineItem;
use super::pages::Appended;
use super::queue::RenderKey;
use super::search::SearchSpec;
use super::text::TextPage;

/// The protocol version in [`Hello`]; a child that answers another one is killed.
pub const PROTOCOL: u32 = 1;

/// Bytes of a frame after `len` that are not header or blob: `kind`, `seq`, `header_len`.
const FIXED_BYTES: usize = 1 + 4 + 4;

/// `argv[1]` of an engine child; a file path from an association can never equal it (Windows passes a full path).
pub const CHILD_FLAG: &str = "--sheer-engine";
/// The environment variable that must be `1` as well (ADR-053 §1.1).
pub const CHILD_ENV: &str = "SHEER_ENGINE_PROTOCOL";

/// Whether a process started with `args` (the program name first) and `protocol_env` (the value of [`CHILD_ENV`]) is an engine
/// child: both the flag and the variable are required.
pub fn child_mode_requested(
    args: impl IntoIterator<Item = std::ffi::OsString>,
    protocol_env: Option<&std::ffi::OsStr>,
) -> bool {
    let flag = args.into_iter().nth(1).is_some_and(|arg| arg == CHILD_FLAG);
    flag && protocol_env.is_some_and(|value| value == "1")
}

// --- Framing -----------------------------------------------------------------------------------------------------

/// What a frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    /// Parent to child, first: [`Hello`].
    Hello = 1,
    /// Child to parent, once, after `Hello`: [`Ready`].
    Ready = 2,
    /// Parent to child: a [`WireRequest`], bytes in the blob where the request names them.
    Request = 3,
    /// Child to parent: the [`WireReply`] to the request with the same `seq`.
    Reply = 4,
    /// Child to parent: a [`WireRead`], answered by `ReadData` or `ReadFailed` with the same `seq`; never queued behind work.
    ReadAt = 5,
    /// Parent to child: the bytes of a `ReadAt`, in the blob.
    ReadData = 6,
    /// Parent to child: a `ReadAt` that could not be answered (unknown token, I/O error); no header, no blob.
    ReadFailed = 7,
}

impl FrameKind {
    fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            1 => Self::Hello,
            2 => Self::Ready,
            3 => Self::Request,
            4 => Self::Reply,
            5 => Self::ReadAt,
            6 => Self::ReadData,
            7 => Self::ReadFailed,
            _ => return None,
        })
    }
}

/// One frame as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub seq: u32,
    pub header: Vec<u8>,
    pub blob: Vec<u8>,
}

/// The most a peer may send in one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameCaps {
    pub header: usize,
    pub blob: usize,
}

impl FrameCaps {
    /// What the child may send as the reply to `request` ([`reply_caps`]).
    pub const fn new(header: usize, blob: usize) -> Self {
        Self { header, blob }
    }
}

/// Why a frame was refused. Every one of them ends the child (`TransportError::Protocol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// The stream ended inside a frame.
    Truncated,
    /// The stream failed.
    Io(io::ErrorKind),
    /// `len`, `header_len` or the blob is over the caps, or the lengths do not add up.
    TooLong,
    /// A `kind` byte nobody sends.
    BadKind,
    /// A header that does not decode as the message its kind promises.
    Malformed,
}

impl FrameError {
    /// A fixed word for the log (never data from the frame).
    pub const fn word(self) -> &'static str {
        match self {
            Self::Truncated => "truncated frame",
            Self::Io(_) => "stream error",
            Self::TooLong => "frame over its cap",
            Self::BadKind => "unknown frame kind",
            Self::Malformed => "malformed header",
        }
    }
}

fn io_error(error: &io::Error) -> FrameError {
    match error.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Truncated,
        kind => FrameError::Io(kind),
    }
}

/// Writes one frame. A header or blob that does not fit the `u32` lengths is `TooLong` (nothing is written).
pub fn write_frame(
    out: &mut impl Write,
    kind: FrameKind,
    seq: u32,
    header: &[u8],
    blob: &[u8],
) -> Result<(), FrameError> {
    let header_len = u32::try_from(header.len()).map_err(|_| FrameError::TooLong)?;
    let len = FIXED_BYTES
        .checked_add(header.len())
        .and_then(|n| n.checked_add(blob.len()))
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(FrameError::TooLong)?;
    let mut prefix = [0u8; 4 + FIXED_BYTES];
    prefix[0..4].copy_from_slice(&len.to_le_bytes());
    prefix[4] = kind as u8;
    prefix[5..9].copy_from_slice(&seq.to_le_bytes());
    prefix[9..13].copy_from_slice(&header_len.to_le_bytes());
    out.write_all(&prefix).map_err(|e| io_error(&e))?;
    out.write_all(header).map_err(|e| io_error(&e))?;
    out.write_all(blob).map_err(|e| io_error(&e))?;
    out.flush().map_err(|e| io_error(&e))
}

/// Reads one frame. `Ok(None)` is a clean end of the stream between frames. Every length is checked against `caps` before the
/// buffer for it is allocated.
pub fn read_frame(input: &mut impl Read, caps: FrameCaps) -> Result<Option<Frame>, FrameError> {
    let mut len_bytes = [0u8; 4];
    match read_full(input, &mut len_bytes)? {
        0 => return Ok(None),
        4 => {}
        _ => return Err(FrameError::Truncated),
    }
    let len = usize::try_from(u32::from_le_bytes(len_bytes)).map_err(|_| FrameError::TooLong)?;
    let max = FIXED_BYTES
        .saturating_add(caps.header)
        .saturating_add(caps.blob);
    if len < FIXED_BYTES || len > max {
        return Err(FrameError::TooLong);
    }
    let mut fixed = [0u8; FIXED_BYTES];
    input.read_exact(&mut fixed).map_err(|e| io_error(&e))?;
    let kind = FrameKind::from_byte(fixed[0]).ok_or(FrameError::BadKind)?;
    let seq = u32::from_le_bytes([fixed[1], fixed[2], fixed[3], fixed[4]]);
    let header_len = usize::try_from(u32::from_le_bytes([fixed[5], fixed[6], fixed[7], fixed[8]]))
        .map_err(|_| FrameError::TooLong)?;
    let rest = len - FIXED_BYTES;
    if header_len > caps.header || header_len > rest || rest - header_len > caps.blob {
        return Err(FrameError::TooLong);
    }
    let header = read_vec(input, header_len)?;
    let blob = read_vec(input, rest - header_len)?;
    Ok(Some(Frame {
        kind,
        seq,
        header,
        blob,
    }))
}

/// Reads until `buffer` is full or the stream ends; how many bytes there were.
fn read_full(input: &mut impl Read, buffer: &mut [u8]) -> Result<usize, FrameError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match input.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_error(&error)),
        }
    }
    Ok(filled)
}

/// `len` bytes, allocated only after the caller checked `len` against its cap, and read in steps so that a peer that stops
/// sending does not leave a large zeroed buffer behind longer than needed.
fn read_vec(input: &mut impl Read, len: usize) -> Result<Vec<u8>, FrameError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(len)
        .map_err(|_| FrameError::TooLong)?;
    let copied = io::copy(&mut input.take(len as u64), &mut bytes).map_err(|e| io_error(&e))?;
    if copied != len as u64 {
        return Err(FrameError::Truncated);
    }
    Ok(bytes)
}

// --- Caps ----------------------------------------------------------------------------------------------------------

fn bytes_of(pixels: u64, per_pixel: u64) -> usize {
    usize::try_from(pixels.saturating_mul(per_pixel)).unwrap_or(usize::MAX)
}

/// The largest blob the reply to `request` may carry. Nothing but the requests below answers with bytes.
pub fn reply_blob_cap(request: &WireRequest) -> usize {
    match request {
        WireRequest::Render { .. } => limits::MAX_FRAME_BYTES,
        WireRequest::RenderForRedaction { .. } => bytes_of(limits::MAX_REDACT_PIXELS, 3),
        WireRequest::RenderExport { .. } => bytes_of(limits::MAX_EXPORT_PIXELS, 3),
        WireRequest::RenderForOcr { .. } => bytes_of(crate::ocr::limits::MAX_PIXELS, 1),
        WireRequest::Release { snapshot: true, .. } => {
            usize::try_from(limits::MAX_SNAPSHOT_BYTES).unwrap_or(usize::MAX)
        }
        _ => 0,
    }
}

/// The caps for the frame that answers `request`: the header cap of the wire, the blob cap of the request's kind.
pub fn reply_caps(request: &WireRequest) -> FrameCaps {
    FrameCaps::new(limits::WIRE_HEADER_MAX, reply_blob_cap(request))
}

/// The caps for what the child reads from the parent: requests carry source or snapshot bytes at most that big.
pub fn request_caps() -> FrameCaps {
    FrameCaps::new(
        limits::WIRE_HEADER_MAX,
        usize::try_from(limits::MAX_SNAPSHOT_BYTES).unwrap_or(usize::MAX),
    )
}

/// The caps for the child's `ReadAt` frames and for `Ready`: a header, no blob.
pub fn control_caps() -> FrameCaps {
    FrameCaps::new(limits::WIRE_HEADER_MAX, 0)
}

// --- Handshake -----------------------------------------------------------------------------------------------------

/// First frame, parent to child.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    /// The PDFium library the child binds (the only file the child opens).
    pub library: PathBuf,
    /// The parent's version, for the log (a child is the same executable, so a skew is a bug).
    pub version: String,
}

/// The child's answer to [`Hello`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ready {
    /// PDFium bound; `false` leaves a child that answers every job with `engine_unavailable`.
    pub pdfium: bool,
}

// --- Requests ------------------------------------------------------------------------------------------------------

/// A password on the wire: wiped when dropped, and `Debug` never shows it.
#[derive(Clone)]
pub struct WireSecret(Zeroizing<String>);

impl Serialize for WireSecret {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.expose())
    }
}

impl<'de> Deserialize<'de> for WireSecret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(|secret| Self(Zeroizing::new(secret)))
    }
}

impl WireSecret {
    pub fn new(secret: Zeroizing<String>) -> Self {
        Self(secret)
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl std::fmt::Debug for WireSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WireSecret(..)")
    }
}

impl PartialEq for WireSecret {
    fn eq(&self, other: &Self) -> bool {
        self.expose() == other.expose()
    }
}

/// What a document is loaded again from (`ReopenSource`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireSource {
    File(FileToken),
    FileWithPassword(FileToken, WireSecret),
    /// The bytes are in the blob.
    Bytes,
}

/// One job for the child. The reply channel, the deadline and `Confirm` stay in the parent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireRequest {
    Open {
        id: DocumentId,
        file: FileToken,
        password: Option<WireSecret>,
    },
    Reopen {
        id: DocumentId,
        source: WireSource,
    },
    Render {
        key: RenderKey,
    },
    Outline {
        id: DocumentId,
    },
    PageChars {
        id: DocumentId,
        engine_index: u32,
    },
    TextLayer {
        id: DocumentId,
        page_index: u32,
    },
    PageLinks {
        id: DocumentId,
        page_index: u32,
    },
    PageLabels {
        id: DocumentId,
    },
    FirstPageHints {
        id: DocumentId,
        engine_index: u32,
    },
    SmartText {
        id: DocumentId,
        engine_index: u32,
    },
    ImportAnnotations {
        id: DocumentId,
        page_index: u32,
    },
    SetAnnotationsHidden {
        id: DocumentId,
        hide: Vec<(u32, u32)>,
        show: Vec<(u32, u32)>,
    },
    SearchPage {
        id: DocumentId,
        page_index: u32,
        spec: SearchSpec,
        limit: u32,
    },
    SetPageRotations {
        id: DocumentId,
        items: Vec<(u32, u16)>,
    },
    SetCropBox {
        id: DocumentId,
        engine_index: u32,
        crop: [f32; 4],
    },
    RenderForRedaction {
        id: DocumentId,
        engine_index: u32,
        dpi: f32,
        burn: Vec<Rect>,
    },
    /// The snapshot bytes are in the blob; the parent assigns the id.
    OpenSnapshot {
        id: SnapshotId,
    },
    CloseSnapshot {
        id: SnapshotId,
    },
    RenderExport {
        doc: EngineDocRef,
        engine_index: u32,
        dpi: f32,
        annotations: bool,
        rotate_quarter: u8,
    },
    RenderForOcr {
        doc: EngineDocRef,
        engine_index: u32,
        dpi: f32,
        max_side: u32,
    },
    AppendBlankPage {
        id: DocumentId,
        size: [f32; 2],
    },
    TruncatePages {
        id: DocumentId,
        keep: u32,
        total: u32,
    },
    /// The source bytes are in the blob.
    AppendPages {
        id: DocumentId,
        pages: Vec<u32>,
    },
    Release {
        id: DocumentId,
        snapshot: bool,
    },
    Close {
        id: DocumentId,
    },
    /// Makes the child die, to test restart; honoured only with `SHEER_ENGINE_TEST_HOOKS=1`.
    #[cfg(debug_assertions)]
    Crash,
}

/// A `ReadAt` of the child: `len` bytes of the file `token` at `offset`, at most [`limits::READ_AT_MAX`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireRead {
    pub token: FileToken,
    pub offset: u64,
    pub len: u32,
}

// --- Replies -------------------------------------------------------------------------------------------------------

/// What the child read of a document when it loaded it (`Opened`, `Reopened`): the parent writes it into the `SizeCache` after
/// `limits::sanitize_page_size` and a count check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireLoaded {
    pub pages: u32,
    pub sizes: Vec<[f32; 2]>,
    pub rotations: Vec<u16>,
    pub boxes: Vec<Option<BoxesRead>>,
    pub flags: DocFlags,
}

/// An error crossing the wire: the code only. Whatever the child says beyond it is its log; the parent never takes a `what` or a
/// message from a child (it is a fixed vocabulary of `&'static str` on the parent's side).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: ErrorCode,
}

impl WireError {
    pub fn from_app(error: &AppError) -> Self {
        Self { code: error.code() }
    }

    pub fn into_app(self) -> AppError {
        AppError::logged(self.code, "the engine process reported it")
    }
}

/// A link as the child read it. The target is a plain string: the parent classifies it again ([`WireLink::into_link`]), so a child
/// cannot hand the UI a URL that `security::links` would refuse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireLink {
    pub rect: Rect,
    pub target: WireLinkTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireLinkTarget {
    Page(PageSpot),
    Url(String),
    Blocked,
}

impl WireLink {
    pub fn from_link(link: &PageLink) -> Self {
        let target = match &link.target {
            LinkTarget::Page(spot) => WireLinkTarget::Page(*spot),
            LinkTarget::Url(url) => WireLinkTarget::Url(url.as_str().to_owned()),
            LinkTarget::Blocked => WireLinkTarget::Blocked,
        };
        Self {
            rect: link.rect,
            target,
        }
    }

    /// The link the parent hands on: a URL that does not classify becomes `Blocked`.
    pub fn into_link(self) -> PageLink {
        let target = match self.target {
            WireLinkTarget::Page(spot) => LinkTarget::Page(spot),
            WireLinkTarget::Url(raw) => classify(&raw).map_or(LinkTarget::Blocked, LinkTarget::Url),
            WireLinkTarget::Blocked => LinkTarget::Blocked,
        };
        PageLink {
            rect: self.rect,
            target,
        }
    }
}

/// What the child answers, one per request. Bytes go in the blob where noted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WireReply {
    Opened(WireLoaded),
    Reopened(WireLoaded),
    /// Encoded PNG in the blob.
    Frame,
    Outline(Vec<OutlineItem>),
    TextLayer(TextPage),
    PageChars(Vec<crate::model::text_edit::CharGeom>),
    PageLinks(Vec<WireLink>),
    PageLabels(Vec<Option<String>>),
    FirstPageHints(crate::model::bibliography::FirstPageHints),
    SmartText(crate::smartlinks::model::PageText),
    Annotations(Vec<Imported>),
    /// `SetAnnotationsHidden`, `SetPageRotations`, `SetCropBox`, `CloseSnapshot`, `TruncatePages`, `Release` without snapshot, `Close`.
    Done,
    Search(Vec<Vec<Quad>>),
    /// Tightly packed pixels in the blob: RGB8 (`gray: false`) or Gray8; `width * height * (3 or 1)` bytes.
    Raster {
        width: u32,
        height: u32,
        gray: bool,
    },
    SnapshotOpened(SnapshotId),
    Appended(Vec<Appended>),
    /// The document as it was, in the blob, when `Release { snapshot: true }` asked for it.
    Released {
        snapshot: bool,
    },
    Failed(WireError),
}

/// The exact blob length a `Raster` header promises (RGB8 or Gray8), `None` on overflow.
pub fn raster_blob_len(width: u32, height: u32, gray: bool) -> Option<u64> {
    u64::from(width)
        .checked_mul(u64::from(height))?
        .checked_mul(if gray { 1 } else { 3 })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn token(n: u64) -> FileToken {
        serde_json::from_value(serde_json::json!(n)).unwrap()
    }

    fn doc(n: u32) -> DocumentId {
        serde_json::from_value(serde_json::json!(n)).unwrap()
    }

    fn caps(header: usize, blob: usize) -> FrameCaps {
        FrameCaps::new(header, blob)
    }

    fn encoded(kind: FrameKind, seq: u32, header: &[u8], blob: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, kind, seq, header, blob).unwrap();
        out
    }

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        serde_json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
    }

    #[test]
    fn a_frame_round_trips_and_the_stream_ends_cleanly() {
        let mut bytes = encoded(FrameKind::Request, 7, b"head", b"blobbytes");
        bytes.extend(encoded(FrameKind::Reply, 8, b"", b""));
        let mut input = Cursor::new(bytes);
        let first = read_frame(&mut input, caps(64, 64)).unwrap().unwrap();
        assert_eq!(
            first,
            Frame {
                kind: FrameKind::Request,
                seq: 7,
                header: b"head".to_vec(),
                blob: b"blobbytes".to_vec()
            }
        );
        let second = read_frame(&mut input, caps(64, 64)).unwrap().unwrap();
        assert_eq!((second.kind, second.seq), (FrameKind::Reply, 8));
        assert_eq!(read_frame(&mut input, caps(64, 64)), Ok(None));
    }

    #[test]
    fn the_layout_is_length_kind_seq_header_len() {
        let bytes = encoded(FrameKind::ReadData, 0x0102_0304, b"ab", b"xyz");
        assert_eq!(&bytes[0..4], &(9u32 + 2 + 3).to_le_bytes());
        assert_eq!(bytes[4], 6);
        assert_eq!(&bytes[5..9], &0x0102_0304u32.to_le_bytes());
        assert_eq!(&bytes[9..13], &2u32.to_le_bytes());
        assert_eq!(&bytes[13..], b"abxyz");
    }

    #[test]
    fn lengths_over_the_caps_are_refused_before_anything_is_read() {
        // Claims 4 GiB - 1 but supplies nothing: the cap check must fire first, not an allocation or a read.
        let mut lying = u32::MAX.to_le_bytes().to_vec();
        lying.extend_from_slice(&[3, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            read_frame(&mut Cursor::new(lying), caps(16, 16)),
            Err(FrameError::TooLong)
        );
        // Blob one byte over.
        let over = encoded(FrameKind::Reply, 1, b"", &[0; 17]);
        assert_eq!(
            read_frame(&mut Cursor::new(over), caps(16, 16)),
            Err(FrameError::TooLong)
        );
        // Header one byte over.
        let over = encoded(FrameKind::Reply, 1, &[0; 17], b"");
        assert_eq!(
            read_frame(&mut Cursor::new(over), caps(16, 16)),
            Err(FrameError::TooLong)
        );
        // Exactly at the caps is fine.
        let exact = encoded(FrameKind::Reply, 1, &[0; 16], &[0; 16]);
        assert!(read_frame(&mut Cursor::new(exact), caps(16, 16)).is_ok());
    }

    #[test]
    fn inconsistent_and_truncated_frames_are_refused() {
        // header_len larger than the frame.
        let mut bad = encoded(FrameKind::Reply, 1, b"ab", b"");
        bad[9..13].copy_from_slice(&50u32.to_le_bytes());
        assert_eq!(
            read_frame(&mut Cursor::new(bad), caps(64, 64)),
            Err(FrameError::TooLong)
        );
        // len shorter than the fixed part.
        let mut short = 3u32.to_le_bytes().to_vec();
        short.extend_from_slice(&[0; 3]);
        assert_eq!(
            read_frame(&mut Cursor::new(short), caps(64, 64)),
            Err(FrameError::TooLong)
        );
        // Unknown kind.
        let mut kind = encoded(FrameKind::Reply, 1, b"", b"");
        kind[4] = 99;
        assert_eq!(
            read_frame(&mut Cursor::new(kind), caps(64, 64)),
            Err(FrameError::BadKind)
        );
        // Cut in the middle of the body, and in the middle of the length.
        let whole = encoded(FrameKind::Reply, 1, b"head", b"blob");
        for cut in [2, 6, whole.len() - 1] {
            assert_eq!(
                read_frame(&mut Cursor::new(whole[..cut].to_vec()), caps(64, 64)),
                Err(FrameError::Truncated),
                "cut at {cut}"
            );
        }
    }

    #[test]
    fn reply_caps_follow_the_request_kind() {
        let id = doc(1);
        let key = RenderKey {
            id,
            page_index: 0,
            bucket: 0,
            tile: None,
        };
        assert_eq!(
            reply_blob_cap(&WireRequest::Render { key }),
            limits::MAX_FRAME_BYTES
        );
        assert_eq!(
            reply_blob_cap(&WireRequest::RenderExport {
                doc: EngineDocRef::Live(id),
                engine_index: 0,
                dpi: 72.0,
                annotations: false,
                rotate_quarter: 0
            }),
            3 * limits::MAX_EXPORT_PIXELS as usize
        );
        assert_eq!(
            reply_blob_cap(&WireRequest::Release { id, snapshot: true }),
            limits::MAX_SNAPSHOT_BYTES as usize
        );
        for no_bytes in [
            WireRequest::Outline { id },
            WireRequest::Close { id },
            WireRequest::Release {
                id,
                snapshot: false,
            },
        ] {
            assert_eq!(reply_blob_cap(&no_bytes), 0, "{no_bytes:?}");
        }
        assert_eq!(
            reply_caps(&WireRequest::Close { id }).header,
            limits::WIRE_HEADER_MAX
        );
    }

    #[test]
    fn requests_and_replies_survive_serde() {
        let id = doc(3);
        let requests = vec![
            WireRequest::Open {
                id,
                file: token(5),
                password: Some(WireSecret::new(Zeroizing::new("pw".to_owned()))),
            },
            WireRequest::Reopen {
                id,
                source: WireSource::Bytes,
            },
            WireRequest::SearchPage {
                id,
                page_index: 2,
                spec: SearchSpec {
                    text: "x".into(),
                    match_case: true,
                    whole_word: false,
                },
                limit: 10,
            },
            WireRequest::SetAnnotationsHidden {
                id,
                hide: vec![(0, 1)],
                show: vec![],
            },
            WireRequest::RenderForOcr {
                doc: EngineDocRef::Snapshot(SnapshotId::fresh()),
                engine_index: 2,
                dpi: 300.0,
                max_side: 8000,
            },
            WireRequest::RenderExport {
                doc: EngineDocRef::Snapshot(SnapshotId::fresh()),
                engine_index: 1,
                dpi: 150.0,
                annotations: true,
                rotate_quarter: 1,
            },
        ];
        for request in requests {
            assert_eq!(round_trip(&request), request);
        }
        let replies = vec![
            WireReply::Frame,
            WireReply::Done,
            WireReply::Raster {
                width: 2,
                height: 3,
                gray: true,
            },
            WireReply::Failed(WireError {
                code: ErrorCode::PasswordRequired,
            }),
            WireReply::Opened(WireLoaded {
                pages: 1,
                sizes: vec![[612.0, 792.0]],
                rotations: vec![90],
                boxes: vec![Some(BoxesRead {
                    media: [0.0, 0.0, 612.0, 792.0],
                    crop: None,
                })],
                flags: DocFlags::default(),
            }),
        ];
        for reply in replies {
            assert_eq!(round_trip(&reply), reply);
        }
        let hello = Hello {
            protocol: PROTOCOL,
            library: PathBuf::from("pdfium.dll"),
            version: "1.0.0".into(),
        };
        assert_eq!(round_trip(&hello), hello);
        assert_eq!(round_trip(&Ready { pdfium: true }), Ready { pdfium: true });
    }

    #[test]
    fn a_secret_never_shows_in_debug_output() {
        let secret = WireSecret::new(Zeroizing::new("hunter2".to_owned()));
        assert!(!format!("{secret:?}").contains("hunter2"));
        let request = WireRequest::Open {
            id: doc(1),
            file: token(1),
            password: Some(secret),
        };
        assert!(!format!("{request:?}").contains("hunter2"));
    }

    #[test]
    fn a_link_url_the_parent_would_refuse_comes_back_blocked() {
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };
        for raw in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "",
            "http://a b",
        ] {
            let link = WireLink {
                rect,
                target: WireLinkTarget::Url(raw.to_owned()),
            }
            .into_link();
            assert_eq!(link.target, LinkTarget::Blocked, "{raw:?}");
        }
        let good = WireLink {
            rect,
            target: WireLinkTarget::Url("https://example.org/a".to_owned()),
        }
        .into_link();
        assert!(matches!(good.target, LinkTarget::Url(_)));
        // And a safe link survives the trip out and back.
        assert_eq!(WireLink::from_link(&good).into_link(), good);
    }

    #[test]
    fn raster_blob_length_is_checked_arithmetic() {
        assert_eq!(raster_blob_len(10, 10, false), Some(300));
        assert_eq!(raster_blob_len(10, 10, true), Some(100));
        assert_eq!(raster_blob_len(u32::MAX, u32::MAX, false), None);
        assert!(raster_blob_len(u32::MAX, u32::MAX, true).is_some());
    }

    #[test]
    fn child_mode_needs_the_flag_and_the_variable() {
        use std::ffi::{OsStr, OsString};
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        let one = Some(OsStr::new("1"));
        assert!(child_mode_requested(
            args(&["sheer", "--sheer-engine"]),
            one
        ));
        assert!(!child_mode_requested(
            args(&["sheer", "--sheer-engine"]),
            None
        ));
        assert!(!child_mode_requested(
            args(&["sheer", "--sheer-engine"]),
            Some(OsStr::new("2"))
        ));
        assert!(!child_mode_requested(args(&["sheer"]), one));
        assert!(!child_mode_requested(args(&["sheer", r"C:\a.pdf"]), one));
        assert!(!child_mode_requested(
            args(&["sheer", "x", "--sheer-engine"]),
            one
        ));
    }

    #[test]
    fn the_error_carries_only_a_code() {
        let wire = WireError::from_app(&AppError::limit("pages", 5));
        assert_eq!(wire.code, ErrorCode::LimitExceeded);
        assert_eq!(wire.into_app().code(), ErrorCode::LimitExceeded);
    }
}
