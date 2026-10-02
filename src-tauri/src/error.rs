//! UI-safe error type for IPC commands.
//!
//! An [`AppError`] carries only an [`ErrorCode`]. The message shown to the UI is a fixed string per code, so an error
//! can never leak a file path, a stack trace or an internal id. Detail for debugging goes to the local log through
//! [`AppError::logged`], at the place where the failure happens.

use std::fmt::{self, Display};

use serde::Serialize;

/// Stable, machine-readable error identifiers. The frontend maps them to translated strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The document id is not registered (never opened, or already closed).
    UnknownDocument,
    /// The page index is outside `0..page_count`.
    PageOutOfRange,
    /// The render scale is not a finite number in the allowed range.
    ScaleOutOfRange,
    /// The requested bitmap would exceed the pixel budget.
    RenderTooLarge,
    /// The file could not be opened or read.
    FileUnreadable,
    /// The file is not a PDF PDFium can parse.
    InvalidPdf,
    /// The PDF needs a password (handled in a later milestone).
    PasswordRequired,
    /// The PDF uses a security handler or feature the engine does not support.
    Unsupported,
    /// The limit of simultaneously open documents is reached.
    TooManyDocuments,
    /// The PDF engine could not be started (for example, the bundled PDFium library is missing).
    EngineUnavailable,
    /// The engine did not answer in time.
    EngineTimeout,
    /// Anything else. Details are in the local log.
    Internal,
}

impl ErrorCode {
    /// Fixed English message for this code. Never contains dynamic data.
    pub const fn message(self) -> &'static str {
        match self {
            ErrorCode::UnknownDocument => "This document is no longer open.",
            ErrorCode::PageOutOfRange => "This page does not exist.",
            ErrorCode::ScaleOutOfRange => "This zoom level is not supported.",
            ErrorCode::RenderTooLarge => "This page is too large to display at this zoom level.",
            ErrorCode::FileUnreadable => "The file could not be opened.",
            ErrorCode::InvalidPdf => "This file is not a valid PDF.",
            ErrorCode::PasswordRequired => "This PDF is password protected.",
            ErrorCode::Unsupported => "This PDF is not supported.",
            ErrorCode::TooManyDocuments => "Too many documents are open. Close one and try again.",
            ErrorCode::EngineUnavailable => "The PDF engine is not available.",
            ErrorCode::EngineTimeout => "The PDF engine took too long to respond.",
            ErrorCode::Internal => "Something went wrong.",
        }
    }
}

/// Error returned by every IPC command. Serializes to `{ "code": "...", "message": "..." }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppError {
    code: ErrorCode,
}

impl AppError {
    pub const fn new(code: ErrorCode) -> Self {
        Self { code }
    }

    /// Builds an error and writes `detail` to the local log (stderr). `detail` must not contain document content.
    pub fn logged(code: ErrorCode, detail: impl Display) -> Self {
        eprintln!("sheer: {code:?}: {detail}");
        Self { code }
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code.message())
    }
}

impl std::error::Error for AppError {}

impl From<ErrorCode> for AppError {
    fn from(code: ErrorCode) -> Self {
        Self::new(code)
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", self.code.message())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_fixed_message() {
        let json = serde_json::to_string(&AppError::new(ErrorCode::PageOutOfRange)).unwrap();
        assert_eq!(
            json,
            r#"{"code":"page_out_of_range","message":"This page does not exist."}"#
        );
    }

    #[test]
    fn logged_error_keeps_detail_out_of_the_message() {
        let error = AppError::logged(ErrorCode::FileUnreadable, "C:/secret/path.pdf");
        assert!(!error.to_string().contains("secret"));
        assert_eq!(error.code(), ErrorCode::FileUnreadable);
    }
}
