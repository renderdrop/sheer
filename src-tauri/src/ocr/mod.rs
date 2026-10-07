//! Scan and OCR (ADR-134, ARCHITECTURE section 15; phase 1 = the Windows spike). The OS recognizer runs in a child process of our own
//! executable that is handed gray bitmaps and a language tag over a length-prefixed pipe and nothing else: never bytes of the PDF,
//! never a path. Everything it answers is untrusted and bounded (`wire`, `limits`).

pub mod backend;
pub mod child;
pub mod limits;
pub mod service;
pub mod textlayer;
#[cfg(windows)]
pub mod win;
pub mod wire;

/// `argv[1]` of an OCR child; a file path from an association can never equal it.
pub const CHILD_FLAG: &str = "--sheer-ocr-child";
/// The environment variable that must be `1` as well.
pub const CHILD_ENV: &str = "SHEER_OCR_CHILD";

/// Whether a process started with `args` (program name first) and `env` (the value of [`CHILD_ENV`]) is an OCR child: both are required.
pub fn child_mode_requested(
    args: impl IntoIterator<Item = std::ffi::OsString>,
    env: Option<&std::ffi::OsStr>,
) -> bool {
    let flag = args.into_iter().nth(1).is_some_and(|arg| arg == CHILD_FLAG);
    flag && env.is_some_and(|value| value == "1")
}

/// One recognized word. Phase 1 keeps the box in **displayed page space**: points, origin at the top left of the page as it is shown
/// (after `/Rotate`), y down; `[x0, y0, x1, y1]`. `pdfwrite::ocr_layer` maps it to user space.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub rect: [f32; 4],
}

/// A line of words in reading order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OcrLine {
    pub words: Vec<OcrWord>,
}

/// What OCR found on one page.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OcrPageLayer {
    /// The language tag the recognizer actually used, for example `de-DE`.
    pub lang: String,
    /// The tilt the recognizer reported, in degrees (not corrected in phase 1).
    pub angle_deg: f32,
    pub dpi: f32,
    pub lines: Vec<OcrLine>,
}

/// The class of a page for OCR (ADR-134 item 5). Phase 1 tells `Scan`, `Text` and `Empty` apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PageOcrClass {
    Scan,
    HasTextLayer,
    SheerLayer,
    Text,
    Empty,
}

/// A running OCR job, by the number the backend gave. Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct OcrJobId(u32);

impl OcrJobId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}
