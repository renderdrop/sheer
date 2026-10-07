//! The parent side of the OCR child (ADR-134 items 1, 9): starts our own executable in child mode, sends a bitmap, waits at most
//! [`limits::PAGE_TIMEOUT`] for the answer, and kills the child when it is late or broken. The next page starts a new child.

use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use super::limits;
use super::wire::{self, OcrReply, OcrRequest, WireError};
use super::OcrPageLayer;

/// Why a page failed; that page only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OcrError {
    Spawn,
    /// The child ended or the pipe broke before it answered.
    ChildDied,
    Timeout,
    /// The reply broke the protocol or the bounds.
    BadReply(String),
    /// The child answered with a failure code.
    Failed(String),
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcrError::Spawn => write!(f, "spawn"),
            OcrError::ChildDied => write!(f, "child_died"),
            OcrError::Timeout => write!(f, "timeout"),
            OcrError::BadReply(why) => write!(f, "bad_reply: {why}"),
            OcrError::Failed(code) => write!(f, "failed: {code}"),
        }
    }
}

impl std::error::Error for OcrError {}

struct Live {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    replies: Receiver<Result<OcrReply, WireError>>,
}

/// One OCR child at a time, started on demand and restarted after a failure.
pub struct ChildClient {
    exe: PathBuf,
    live: Option<Live>,
    next_id: u64,
    /// How many children were started (the restart budget of the app counts these).
    pub spawned: u32,
}

impl ChildClient {
    pub fn new(exe: PathBuf) -> Self {
        Self {
            exe,
            live: None,
            next_id: 1,
            spawned: 0,
        }
    }

    fn spawn(&mut self) -> Result<(), OcrError> {
        let mut child = Command::new(&self.exe)
            .arg(super::CHILD_FLAG)
            .env(super::CHILD_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| OcrError::Spawn)?;
        let (Some(stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(OcrError::Spawn);
        };
        let (tx, replies) = mpsc::channel();
        // One reader thread per child: a blocking read cannot be given a timeout, a channel can.
        std::thread::spawn(move || loop {
            let reply = wire::read_reply(&mut stdout);
            let stop = reply.is_err();
            if tx.send(reply).is_err() || stop {
                return;
            }
        });
        self.spawned += 1;
        self.live = Some(Live {
            child,
            stdin: BufWriter::new(stdin),
            replies,
        });
        Ok(())
    }

    /// Kills the child (if any); the next request starts a new one.
    pub fn kill(&mut self) {
        if let Some(mut live) = self.live.take() {
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
    }

    /// The process id of the running child, for a test that kills it from outside.
    pub fn child_id(&self) -> Option<u32> {
        self.live.as_ref().map(|l| l.child.id())
    }

    /// Recognizes a gray8 bitmap. Any failure kills the child, so the next call starts a fresh one.
    pub fn recognize(
        &mut self,
        pixels: &[u8],
        w: u32,
        h: u32,
        lang: &str,
        timeout: Duration,
    ) -> Result<OcrPageLayer, OcrError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = OcrRequest {
            v: 1,
            id,
            w,
            h,
            stride: w,
            format: "gray8".into(),
            lang: vec![lang.to_owned()],
        };
        wire::validate_request(&request).map_err(|e| OcrError::BadReply(e.to_string()))?;
        if pixels.len() != w as usize * h as usize {
            return Err(OcrError::BadReply("bitmap size".into()));
        }
        // A child that ended between two pages (killed from outside, crashed idle) is replaced before the page is sent.
        if self
            .live
            .as_mut()
            .is_some_and(|l| l.child.try_wait().map_or(true, |s| s.is_some()))
        {
            self.kill();
        }
        if self.live.is_none() {
            self.spawn()?;
        }
        let result = self.exchange(&request, pixels, timeout);
        match &result {
            Ok(_) => {}
            // A refusal in the child (language missing) leaves it healthy.
            Err(OcrError::Failed(_)) => {}
            Err(_) => self.kill(),
        }
        let mut layer = result?;
        layer.lang = lang.to_owned();
        Ok(layer)
    }

    fn exchange(
        &mut self,
        request: &OcrRequest,
        pixels: &[u8],
        timeout: Duration,
    ) -> Result<OcrPageLayer, OcrError> {
        let live = self.live.as_mut().ok_or(OcrError::ChildDied)?;
        wire::write_message(&mut live.stdin, request, pixels).map_err(|_| OcrError::ChildDied)?;
        let reply = match live.replies.recv_timeout(timeout) {
            Ok(Ok(reply)) => reply,
            Ok(Err(WireError::Truncated)) | Err(RecvTimeoutError::Disconnected) => {
                return Err(OcrError::ChildDied)
            }
            Ok(Err(other)) => return Err(OcrError::BadReply(other.to_string())),
            Err(RecvTimeoutError::Timeout) => return Err(OcrError::Timeout),
        };
        if reply.id != request.id && reply.id != 0 {
            return Err(OcrError::BadReply("id".into()));
        }
        if !reply.ok {
            return Err(OcrError::Failed(
                reply.error.unwrap_or_else(|| "unknown".into()),
            ));
        }
        wire::sanitize(&reply, request.w, request.h).map_err(|e| OcrError::BadReply(e.to_string()))
    }
}

impl Drop for ChildClient {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Something that recognizes one gray8 bitmap (the child; a fake in the pipeline tests).
pub trait Recognizer {
    /// Recognizes `pixels` (`w * h` bytes). An error other than [`OcrError::Failed`] means the recognizer was killed and restarts with
    /// the next page.
    fn recognize_page(
        &mut self,
        pixels: &[u8],
        w: u32,
        h: u32,
        lang: &str,
    ) -> Result<OcrPageLayer, OcrError>;
}

impl Recognizer for ChildClient {
    fn recognize_page(
        &mut self,
        pixels: &[u8],
        w: u32,
        h: u32,
        lang: &str,
    ) -> Result<OcrPageLayer, OcrError> {
        self.recognize(pixels, w, h, lang, page_timeout())
    }
}

impl OcrError {
    /// Whether this error cost a child process (kill and restart); a refusal in a healthy child does not.
    pub fn restarts_child(&self) -> bool {
        !matches!(self, OcrError::Failed(_))
    }
}

/// The page timeout of the app.
pub const fn page_timeout() -> Duration {
    limits::PAGE_TIMEOUT
}

/// Which recognizer this build and computer has (ARCHITECTURE section 15). Wire values are lowercase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Windows,
    Vision,
    None,
}

/// One language the UI may offer, and whether the recognizer has it on this computer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OcrLanguage {
    pub tag: &'static str,
    pub available: bool,
}

/// The answer of `ocr_capabilities`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub backend: BackendKind,
    pub languages: Vec<OcrLanguage>,
    pub max_image_dimension: Option<u32>,
}

impl Capabilities {
    /// No recognizer: every language unavailable.
    pub fn none() -> Self {
        Self {
            backend: BackendKind::None,
            languages: limits::LANGUAGES
                .iter()
                .map(|tag| OcrLanguage {
                    tag,
                    available: false,
                })
                .collect(),
            max_image_dimension: None,
        }
    }

    /// Whether `tag` is a language the recognizer has.
    pub fn has(&self, tag: &str) -> bool {
        self.languages
            .iter()
            .any(|language| language.available && language.tag == tag)
    }
}

/// How long a probe result is trusted (a user may install a language pack while the app runs).
const CAPS_TTL: Duration = Duration::from_secs(30);

/// What the recognizer can do here. On Windows each language is asked of the OCR child with a blank bitmap (the parent never touches
/// the OS recognizer, ADR-134 item 1); the answer is kept for [`CAPS_TTL`]. Blocking (spawns a child); call it on the blocking pool.
pub fn capabilities() -> Capabilities {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Capabilities)>> =
        std::sync::Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, caps)) = cache.as_ref() {
        if at.elapsed() < CAPS_TTL {
            return caps.clone();
        }
    }
    let caps = probe_capabilities();
    *cache = Some((std::time::Instant::now(), caps.clone()));
    caps
}

/// The file name of the macOS sidecar (Tauri `externalBin` puts it next to the main binary, without the target suffix).
pub const SIDECAR_NAME: &str = "sheer-ocr";

/// The sidecar that sits next to `exe` (the main binary inside `Contents/MacOS`).
pub fn sidecar_next_to(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.join(SIDECAR_NAME))
}

/// Pure choice of the recognizer executable. `override_path` (from `SHEER_OCR_SIDECAR`) counts only when `allow_override`.
fn pick_exe(
    macos: bool,
    current: Option<PathBuf>,
    override_path: Option<std::ffi::OsString>,
    allow_override: bool,
) -> Option<PathBuf> {
    if !macos {
        return current;
    }
    if allow_override {
        if let Some(path) = override_path.filter(|p| !p.is_empty()) {
            return Some(PathBuf::from(path));
        }
    }
    sidecar_next_to(&current?)
}

/// The executable that runs OCR for this build: Windows = our own exe (child mode); macOS = the `sheer-ocr` sidecar next to the main
/// binary, overridable by `SHEER_OCR_SIDECAR` in debug builds only (tests, CI); elsewhere `None`.
pub fn recognizer_exe() -> Option<PathBuf> {
    let macos = cfg!(target_os = "macos");
    if !macos && !cfg!(windows) {
        return None;
    }
    pick_exe(
        macos,
        std::env::current_exe().ok(),
        std::env::var_os("SHEER_OCR_SIDECAR"),
        cfg!(debug_assertions),
    )
}

/// Acceptance-only mask (ADR-137 item 1): keeps only the languages named in the comma list `mask` as available. `None` = no mask.
#[cfg_attr(not(feature = "automation"), allow(dead_code))]
fn mask_languages(languages: Vec<OcrLanguage>, mask: Option<&str>) -> Vec<OcrLanguage> {
    let Some(mask) = mask else {
        return languages;
    };
    let allowed: Vec<&str> = mask.split(',').map(str::trim).collect();
    languages
        .into_iter()
        .map(|language| OcrLanguage {
            available: language.available && allowed.contains(&language.tag),
            ..language
        })
        .collect()
}

#[cfg(feature = "automation")]
fn apply_automation_mask(mut caps: Capabilities) -> Capabilities {
    let mask = std::env::var("SHEER_AUTOMATION_OCR_LANGS").ok();
    caps.languages = mask_languages(caps.languages, mask.as_deref());
    caps
}

#[cfg(not(feature = "automation"))]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn apply_automation_mask(caps: Capabilities) -> Capabilities {
    caps
}

/// Asks the child (Windows) or sidecar (macOS) for each language with a blank bitmap; the parent never touches the OS recognizer.
#[cfg(any(windows, target_os = "macos"))]
fn probe_with_child(backend: BackendKind) -> Capabilities {
    let Some(exe) = recognizer_exe() else {
        return Capabilities::none();
    };
    let mut client = ChildClient::new(exe);
    let blank = vec![255u8; 64 * 64];
    let languages = limits::LANGUAGES
        .iter()
        .map(|tag| OcrLanguage {
            tag,
            available: client
                .recognize(&blank, 64, 64, tag, page_timeout())
                .is_ok(),
        })
        .collect();
    Capabilities {
        backend,
        languages,
        max_image_dimension: Some(limits::MAX_SIDE_PX),
    }
}

#[cfg(windows)]
fn probe_capabilities() -> Capabilities {
    apply_automation_mask(probe_with_child(BackendKind::Windows))
}

#[cfg(target_os = "macos")]
fn probe_capabilities() -> Capabilities {
    apply_automation_mask(probe_with_child(BackendKind::Vision))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn probe_capabilities() -> Capabilities {
    Capabilities::none()
}

#[cfg(test)]
mod capability_tests {
    use super::*;

    #[test]
    fn none_has_no_language_and_serializes_in_wire_shape() {
        let caps = Capabilities::none();
        assert!(!caps.has("de-DE"));
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["backend"], "none");
        assert_eq!(json["maxImageDimension"], serde_json::Value::Null);
        assert_eq!(
            json["languages"][0],
            serde_json::json!({"tag": "de-DE", "available": false})
        );
    }
}

#[cfg(test)]
mod platform_pick_tests {
    use super::*;

    fn langs(de: bool, en: bool) -> Vec<OcrLanguage> {
        vec![
            OcrLanguage {
                tag: "de-DE",
                available: de,
            },
            OcrLanguage {
                tag: "en-US",
                available: en,
            },
        ]
    }

    #[test]
    fn the_language_mask_only_removes_languages() {
        assert_eq!(mask_languages(langs(true, true), None), langs(true, true));
        assert_eq!(
            mask_languages(langs(true, true), Some("de-DE")),
            langs(true, false)
        );
        assert_eq!(
            mask_languages(langs(true, true), Some(" en-US , xx")),
            langs(false, true)
        );
        assert_eq!(
            mask_languages(langs(true, true), Some("")),
            langs(false, false)
        );
        // A mask never adds a language the recognizer lacks.
        assert_eq!(
            mask_languages(langs(true, false), Some("de-DE,en-US")),
            langs(true, false)
        );
    }

    #[test]
    fn the_recognizer_exe_is_the_own_exe_on_windows_and_the_sidecar_on_macos() {
        let exe = PathBuf::from("/app/Contents/MacOS/sheer");
        let sidecar = Some(PathBuf::from("/app/Contents/MacOS/sheer-ocr"));
        assert_eq!(
            pick_exe(false, Some(exe.clone()), None, true),
            Some(exe.clone())
        );
        assert_eq!(pick_exe(true, Some(exe.clone()), None, false), sidecar);
        let over = Some(std::ffi::OsString::from("/tmp/x/sheer-ocr"));
        assert_eq!(
            pick_exe(true, Some(exe.clone()), over.clone(), true),
            Some(PathBuf::from("/tmp/x/sheer-ocr"))
        );
        // Release builds ignore the override.
        assert_eq!(pick_exe(true, Some(exe), over, false), sidecar);
        assert_eq!(pick_exe(true, None, None, false), None);
    }
}
