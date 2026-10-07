//! Error model of the backend (ARCHITECTURE §7).
//!
//! [`AppError`] is the internal error. It carries a stable [`ErrorCode`], optional whitelisted [`UiParams`] and a
//! free-text detail for the local log. It is deliberately **not** `Serialize`: the only way an error reaches the
//! webview is `impl From<AppError> for UiError`. A [`UiError`] holds a stable code, the i18n key `error.<code>`, a
//! retry hint and the whitelisted params. It never holds a path, a stack trace, a PDF string or an internal id, because
//! none of those have a field to live in (SECURITY I4). The detail is written to the local log by that conversion,
//! and only when debug logging is opted into (`SHEER_LOG=debug`, or a debug build).

use std::fmt::{self, Display};
use std::io;
use std::sync::OnceLock;

use serde::Serialize;

/// Defines [`ErrorCode`] together with its wire name, i18n key and retry hint, so the three can never drift apart.
macro_rules! error_codes {
    ($($(#[$meta:meta])* $variant:ident => $name:literal, retryable: $retryable:literal;)+) => {
        /// Stable, machine-readable error identifiers. The frontend mirrors this list in `src/api/errors.ts`
        /// and maps each code to the translated string `error.<code>`.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
        pub enum ErrorCode {
            $($(#[$meta])* #[serde(rename = $name)] $variant,)+
        }

        impl ErrorCode {
            /// Every code, for exhaustive tests.
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$variant),+];

            /// The wire name, for example `"not_a_pdf"`.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(ErrorCode::$variant => $name),+
                }
            }

            /// The i18n key the frontend translates, for example `"error.not_a_pdf"`.
            pub const fn i18n_key(self) -> &'static str {
                match self {
                    $(ErrorCode::$variant => concat!("error.", $name)),+
                }
            }

            /// Whether trying the same request again may succeed.
            pub const fn retryable(self) -> bool {
                match self {
                    $(ErrorCode::$variant => $retryable),+
                }
            }
        }
    };
}

error_codes! {
    /// A request argument is malformed or out of range (page, scale).
    InvalidArgument => "invalid_argument", retryable: false;
    /// A size or count limit would be exceeded (render pixels, open documents).
    LimitExceeded => "limit_exceeded", retryable: false;
    /// The document id is not registered (never opened, or already closed).
    NotFound => "not_found", retryable: false;
    /// The file is not a PDF.
    NotAPdf => "not_a_pdf", retryable: false;
    /// The file is a PDF that PDFium cannot read or render.
    DamagedFile => "damaged_file", retryable: false;
    /// The file is larger than the app opens.
    TooLarge => "too_large", retryable: false;
    /// The PDF uses a security handler or feature the engine does not support.
    UnsupportedFeature => "unsupported_feature", retryable: false;
    /// The PDF needs a password (handled in a later milestone).
    PasswordRequired => "password_required", retryable: false;
    /// The OS refused access to the file.
    IoPermissionDenied => "io_permission_denied", retryable: false;
    /// The file does not exist (any more).
    IoNotFound => "io_not_found", retryable: false;
    /// Another program holds the file open exclusively.
    IoInUse => "io_in_use", retryable: true;
    /// There is no room left for the file: the disk is full.
    IoDiskFull => "io_disk_full", retryable: false;
    /// The document cannot be saved in place (the bundled welcome document): the UI offers Save As (ADR-004, DESIGN 3.27).
    ReadOnly => "read_only", retryable: false;
    /// The document has changes that are not saved and was closed without `discard`.
    UnsavedChanges => "unsaved_changes", retryable: false;
    /// Saving needs the user's say first; `params.what` is the reason (`fileChangedOnDisk`), the UI retries with `ack`.
    NeedsConfirmation => "needs_confirmation", retryable: false;
    /// The file could not be written; the original is untouched.
    SaveFailed => "save_failed", retryable: true;
    /// The engine did not answer within the deadline of its job.
    EngineTimeout => "engine_timeout", retryable: true;
    /// A PDF job panicked. The worker survives, the affected document is dropped.
    EngineCrashed => "engine_crashed", retryable: false;
    /// The engine cannot work: the bundled PDFium is missing, or a job is stuck past its deadline.
    EngineUnavailable => "engine_unavailable", retryable: false;
    /// The request was withdrawn before it ran (a queued render whose page left the viewport, ADR-002 §3). The UI stays silent.
    Cancelled => "cancelled", retryable: false;
    /// The system keychain is unavailable or refused access, so a signature cannot be stored (ADR-107).
    KeychainUnavailable => "keychain_unavailable", retryable: true;
    /// Anything else. Details are in the local log.
    Internal => "internal", retryable: false;
}

impl Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Whitelisted context for the UI. `what` names the argument or resource in a fixed vocabulary (`"page"`, `"scale"`,
/// `"document"`, `"documents"`, `"dimension"`, `"pixels"`, `"file_size"`, `"settings"`, `"bucket"`, `"tile"`, `"pages"`, `"requests"`, `"query"`, `"hits"`, `"link"`, `"searches"`). It is a `&'static str`, so
/// request data can never end up in it. `limit` is the bound that was exceeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UiParams {
    pub what: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// The one character a text box refused (`textBox`, ADR-047 §1): never ASCII, so it cannot be a path separator or markup.
    #[serde(rename = "char", skip_serializing_if = "Option::is_none")]
    pub character: Option<char>,
    /// The 1-based page position an export refused (`exportPixels`, ADR-049 §2): a number, never text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    /// Why text editing refused (`unsupported_feature` `textEdit`, ADR-125): a fixed word of `TextEditRefusal`, never request data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// The only error type that crosses the IPC boundary. Serializes to
/// `{ "code", "key", "retryable", "params"? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UiError {
    code: ErrorCode,
    key: &'static str,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<UiParams>,
}

impl UiError {
    pub const fn code(&self) -> ErrorCode {
        self.code
    }
}

/// Internal error of the backend. Convert with `UiError::from` at the command boundary. `Clone` so that one failure can answer
/// every caller that waited for the same job (the render queue's deduplication, `engine::queue`).
#[derive(Debug, Clone)]
pub struct AppError {
    code: ErrorCode,
    params: Option<UiParams>,
    /// Free text for the local log only. May contain paths, so it never leaves the process through IPC.
    detail: Option<String>,
}

impl AppError {
    pub const fn new(code: ErrorCode) -> Self {
        Self {
            code,
            params: None,
            detail: None,
        }
    }

    /// An error with `detail` for the local log. `detail` must not contain document content.
    pub fn logged(code: ErrorCode, detail: impl Display) -> Self {
        Self {
            code,
            params: None,
            detail: Some(detail.to_string()),
        }
    }

    /// `invalid_argument` for the argument called `what`.
    pub const fn invalid(what: &'static str) -> Self {
        Self::with_params(ErrorCode::InvalidArgument, what, None)
    }

    /// `not_found` for the resource called `what`.
    pub const fn not_found(what: &'static str) -> Self {
        Self::with_params(ErrorCode::NotFound, what, None)
    }

    /// `limit_exceeded`: `what` would go past `max`.
    pub const fn limit(what: &'static str, max: u64) -> Self {
        Self::with_params(ErrorCode::LimitExceeded, what, Some(max))
    }

    /// `too_large`: `what` is bigger than `max`.
    pub const fn too_large(what: &'static str, max: u64) -> Self {
        Self::with_params(ErrorCode::TooLarge, what, Some(max))
    }

    /// `unsupported_feature` for the feature called `what` (`"xfa"`).
    pub const fn unsupported(what: &'static str) -> Self {
        Self::with_params(ErrorCode::UnsupportedFeature, what, None)
    }

    /// `internal` with `what: "automationNoAnswer"`: a dialog of the acceptance build found no queued answer of its kind (ADR-131). It is
    /// `internal` so the frontend needs no catalog entry for a code only the acceptance build can produce.
    #[cfg(feature = "automation")]
    pub const fn automation_no_answer() -> Self {
        Self::with_params(ErrorCode::Internal, "automationNoAnswer", None)
    }

    /// `invalid_argument` for `textBox` with the character the font cannot show (ADR-047 §1). An ASCII character is not reported.
    pub fn bad_char(character: char) -> Self {
        let mut error = Self::with_params(ErrorCode::InvalidArgument, "textBox", None);
        if let Some(params) = &mut error.params {
            params.character = (!character.is_ascii()).then_some(character);
        }
        error
    }

    /// `invalid_argument` for `stamp` with the character WinAnsi has no glyph for (ARCHITECTURE §16.1). An ASCII character is not reported.
    pub fn bad_stamp_char(character: char) -> Self {
        let mut error = Self::with_params(ErrorCode::InvalidArgument, "stamp", None);
        if let Some(params) = &mut error.params {
            params.character = (!character.is_ascii()).then_some(character);
        }
        error
    }

    /// `invalid_argument` for `what` with the character a text field refused (headers and footers); like [`AppError::bad_char`].
    pub fn bad_char_for(what: &'static str, character: char) -> Self {
        let mut error = Self::with_params(ErrorCode::InvalidArgument, what, None);
        if let Some(params) = &mut error.params {
            params.character = (!character.is_ascii()).then_some(character);
        }
        error
    }

    /// `limit_exceeded` `exportPixels`: page `page` (1-based) stays over the bitmap limits even at the lowest dpi (ADR-049 §2).
    pub fn export_pixels(page: u32) -> Self {
        let mut error = Self::with_params(ErrorCode::LimitExceeded, "exportPixels", None);
        if let Some(params) = &mut error.params {
            params.page = Some(page);
        }
        error
    }

    /// `unsupported_feature` (`what: "notYet"`): a seam of ADR-047 whose package has not filled it in yet. Never returned by a finished build.
    pub const fn not_yet() -> Self {
        Self::with_params(ErrorCode::UnsupportedFeature, "notYet", None)
    }

    /// `unsupported_feature` `textEdit` with `params.reason` (ADR-125): the line or the document cannot be edited for that reason.
    pub const fn text_edit_refused(reason: &'static str) -> Self {
        Self {
            code: ErrorCode::UnsupportedFeature,
            params: Some(UiParams {
                what: "textEdit",
                limit: None,
                character: None,
                page: None,
                reason: Some(reason),
            }),
            detail: None,
        }
    }

    /// The `params.reason` of a text-edit refusal.
    pub const fn reason(&self) -> Option<&'static str> {
        match &self.params {
            Some(params) => params.reason,
            None => None,
        }
    }

    /// `read_only` for the reason called `what` (`"permission"`: the file's permissions forbid the change, ADR-047 §4).
    pub const fn read_only(what: &'static str) -> Self {
        Self::with_params(ErrorCode::ReadOnly, what, None)
    }

    /// `needs_confirmation`: saving would do `reason` (a fixed word such as `fileChangedOnDisk`) and the user decides first.
    pub const fn needs_confirmation(reason: &'static str) -> Self {
        Self::with_params(ErrorCode::NeedsConfirmation, reason, None)
    }

    const fn with_params(code: ErrorCode, what: &'static str, limit: Option<u64>) -> Self {
        Self {
            code,
            params: Some(UiParams {
                what,
                limit,
                character: None,
                page: None,
                reason: None,
            }),
            detail: None,
        }
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Writes the error to the local log: the code always, the detail only when debug logging is on.
    pub fn log(&self) {
        match (&self.detail, detail_logging_enabled()) {
            (Some(detail), true) => eprintln!("sheer: {}: {detail}", self.code),
            _ => eprintln!("sheer: {}", self.code),
        }
    }
}

impl Display for AppError {
    /// For the local log and tests only. Never shown in the UI: it can contain the detail.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{}: {detail}", self.code),
            None => write!(f, "{}", self.code),
        }
    }
}

impl std::error::Error for AppError {}

impl From<ErrorCode> for AppError {
    fn from(code: ErrorCode) -> Self {
        Self::new(code)
    }
}

impl From<io::Error> for AppError {
    /// Maps the error kind to a specific code. The OS message, which usually contains the path, goes to the log only.
    fn from(error: io::Error) -> Self {
        Self::logged(io_code(&error), error)
    }
}

impl From<AppError> for UiError {
    /// The only way an error reaches IPC. Logs the full error locally, then keeps code, key, hint and params.
    fn from(error: AppError) -> Self {
        error.log();
        Self {
            code: error.code,
            key: error.code.i18n_key(),
            retryable: error.code.retryable(),
            params: error.params,
        }
    }
}

fn io_code(error: &io::Error) -> ErrorCode {
    // Windows ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33): another program holds the file.
    let sharing_violation = cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33));
    match error.kind() {
        io::ErrorKind::NotFound => ErrorCode::IoNotFound,
        io::ErrorKind::PermissionDenied => ErrorCode::IoPermissionDenied,
        io::ErrorKind::ResourceBusy => ErrorCode::IoInUse,
        io::ErrorKind::StorageFull => ErrorCode::IoDiskFull,
        _ if sharing_violation => ErrorCode::IoInUse,
        _ => ErrorCode::Internal,
    }
}

/// Details (paths, OS messages) are logged only in debug builds or with `SHEER_LOG=debug` (SECURITY I4, D6).
pub(crate) fn detail_logging_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        detail_logging_for(
            cfg!(debug_assertions),
            std::env::var("SHEER_LOG").ok().as_deref(),
        )
    })
}

fn detail_logging_for(debug_build: bool, env_level: Option<&str>) -> bool {
    debug_build || env_level == Some("debug")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(error: AppError) -> String {
        serde_json::to_string(&UiError::from(error)).unwrap()
    }

    #[test]
    fn serializes_code_key_and_params() {
        assert_eq!(
            json(AppError::invalid("page")),
            r#"{"code":"invalid_argument","key":"error.invalid_argument","retryable":false,"params":{"what":"page"}}"#
        );
        assert_eq!(
            json(AppError::limit("pixels", 16_777_216)),
            r#"{"code":"limit_exceeded","key":"error.limit_exceeded","retryable":false,"params":{"what":"pixels","limit":16777216}}"#
        );
        assert_eq!(
            json(AppError::new(ErrorCode::EngineTimeout)),
            r#"{"code":"engine_timeout","key":"error.engine_timeout","retryable":true}"#
        );
    }

    #[test]
    fn every_code_has_a_stable_wire_name_and_key() {
        let mut seen = std::collections::HashSet::new();
        for &code in ErrorCode::ALL {
            let name = code.as_str();
            assert!(seen.insert(name), "duplicate code {name}");
            assert!(
                !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{name} is not snake_case"
            );
            assert_eq!(code.i18n_key(), format!("error.{name}"));
            assert_eq!(serde_json::to_value(code).unwrap(), name);
            assert_eq!(code.to_string(), name);
        }
    }

    #[test]
    fn a_refused_character_is_reported_only_when_it_is_not_ascii() {
        let json = |error: AppError| serde_json::to_value(UiError::from(error)).unwrap();
        assert_eq!(
            json(AppError::bad_char('\u{4e2d}'))["params"],
            serde_json::json!({"what": "textBox", "char": "\u{4e2d}"})
        );
        assert_eq!(
            json(AppError::bad_char('\\'))["params"],
            serde_json::json!({"what": "textBox"})
        );
    }

    #[test]
    fn ui_errors_never_leak_paths_or_debug_text() {
        let hostile = [
            r"C:\Users\user\Documents\secret-plan.pdf",
            "/home/user/secret-plan.pdf",
            r"\\?\C:\Users\user\secret-plan.pdf",
            "thread 'sheer-pdfium' panicked at src/engine/worker.rs:12:5",
            r#"Os { code: 2, kind: NotFound, message: "secret-plan.pdf" }"#,
        ];
        for &code in ErrorCode::ALL {
            for detail in hostile {
                let ui = UiError::from(AppError::logged(code, detail));
                let text = serde_json::to_string(&ui).unwrap();
                for forbidden in [
                    "secret",
                    "Users",
                    "home",
                    "panicked",
                    "Os {",
                    "worker.rs",
                    "\\",
                    "/",
                    ":\\",
                ] {
                    assert!(
                        !text.contains(forbidden),
                        "{code}: {forbidden:?} leaked into {text}"
                    );
                }
            }
        }
    }

    #[test]
    fn io_errors_keep_their_path_out_of_the_ui() {
        let os_message = io::Error::new(
            io::ErrorKind::NotFound,
            r"C:\Users\user\Documents\secret-plan.pdf not found",
        );
        let ui = UiError::from(AppError::from(os_message));
        assert_eq!(ui.code(), ErrorCode::IoNotFound);
        assert!(!serde_json::to_string(&ui).unwrap().contains("secret"));
    }

    #[test]
    fn io_errors_map_to_specific_codes() {
        let code = |kind| AppError::from(io::Error::from(kind)).code();
        assert_eq!(code(io::ErrorKind::NotFound), ErrorCode::IoNotFound);
        assert_eq!(
            code(io::ErrorKind::PermissionDenied),
            ErrorCode::IoPermissionDenied
        );
        assert_eq!(code(io::ErrorKind::ResourceBusy), ErrorCode::IoInUse);
        assert_eq!(code(io::ErrorKind::UnexpectedEof), ErrorCode::Internal);
        #[cfg(windows)]
        assert_eq!(
            AppError::from(io::Error::from_raw_os_error(32)).code(),
            ErrorCode::IoInUse
        );
    }

    #[test]
    fn params_only_carry_the_fixed_vocabulary() {
        let samples = [
            AppError::invalid("page"),
            AppError::invalid("scale"),
            AppError::not_found("document"),
            AppError::limit("documents", 32),
            AppError::limit("dimension", 4096),
            AppError::limit("pixels", 16_777_216),
            AppError::limit("pages", 50_000),
            AppError::limit("requests", 8),
            AppError::invalid("bucket"),
            AppError::invalid("tile"),
            AppError::too_large("file_size", 2_147_483_648),
        ];
        for error in samples {
            let params = error.params.unwrap();
            assert!(
                params
                    .what
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{}",
                params.what
            );
        }
    }

    #[test]
    fn export_errors_have_the_documented_wire_shape() {
        let value = |error: AppError| serde_json::to_value(UiError::from(error)).unwrap();
        assert_eq!(
            value(AppError::export_pixels(7)),
            serde_json::json!({"code": "limit_exceeded", "key": "error.limit_exceeded", "retryable": false,
                "params": {"what": "exportPixels", "page": 7}})
        );
        for error in [
            AppError::invalid("exportTarget"),
            AppError::invalid("pageSelection"),
            AppError::not_found("imageBatch"),
            AppError::limit("snapshot", 1 << 30),
            AppError::limit("printJob", 2_000),
            AppError::unsupported("printDialog"),
        ] {
            assert!(error.params.is_some());
        }
    }

    #[test]
    fn detail_logging_is_opt_in_for_release_builds() {
        assert!(!detail_logging_for(false, None));
        assert!(!detail_logging_for(false, Some("warn")));
        assert!(detail_logging_for(false, Some("debug")));
        assert!(detail_logging_for(true, None));
    }

    #[test]
    fn app_error_display_is_for_logs_and_keeps_the_detail() {
        let error = AppError::logged(ErrorCode::Internal, "step 3 failed");
        assert_eq!(error.to_string(), "internal: step 3 failed");
        assert_eq!(AppError::new(ErrorCode::NotFound).to_string(), "not_found");
    }
}
