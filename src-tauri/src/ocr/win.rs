//! Windows.Media.Ocr through the `windows` crate's safe projections (ADR-134 option (a)). Runs only in the OCR child process.

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;

use super::wire::{RawLine, RawWord};

/// A recognizer for one language, created once and reused for every page of a child's life.
pub struct Recognizer {
    tag: String,
    engine: OcrEngine,
}

/// What the recognizer found, in pixels of the bitmap.
pub struct Raw {
    pub angle: f32,
    pub lines: Vec<RawLine>,
}

fn fail(error: windows::core::Error) -> String {
    format!("winrt_{:08x}", error.code().0 as u32)
}

impl Recognizer {
    /// `None` when the language is not available on this computer.
    pub fn new(tag: &str) -> Result<Option<Self>, String> {
        let language = Language::CreateLanguage(&HSTRING::from(tag)).map_err(fail)?;
        if !OcrEngine::IsLanguageSupported(&language).map_err(fail)? {
            return Ok(None);
        }
        let engine = OcrEngine::TryCreateFromLanguage(&language).map_err(fail)?;
        Ok(Some(Self {
            tag: tag.to_owned(),
            engine,
        }))
    }

    pub fn tag(&self) -> &str {
        &self.tag
    }

    /// Recognizes a `w` x `h` gray8 bitmap (`pixels.len() == w * h`, checked by the caller).
    pub fn recognize(&self, pixels: &[u8], w: u32, h: u32) -> Result<Raw, String> {
        let writer = DataWriter::new().map_err(fail)?;
        writer.WriteBytes(pixels).map_err(fail)?;
        let buffer = writer.DetachBuffer().map_err(fail)?;
        let width = i32::try_from(w).map_err(|_| "size".to_owned())?;
        let height = i32::try_from(h).map_err(|_| "size".to_owned())?;
        let bitmap =
            SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Gray8, width, height)
                .map_err(fail)?;
        let result = self
            .engine
            .RecognizeAsync(&bitmap)
            .map_err(fail)?
            .join()
            .map_err(fail)?;
        let angle = result
            .TextAngle()
            .ok()
            .and_then(|r| r.Value().ok())
            .map_or(0.0, |a| a as f32);
        let mut lines = Vec::new();
        for line in result.Lines().map_err(fail)? {
            let mut words = Vec::new();
            for word in line.Words().map_err(fail)? {
                let rect = word.BoundingRect().map_err(fail)?;
                words.push(RawWord {
                    t: word.Text().map_err(fail)?.to_string(),
                    x: rect.X,
                    y: rect.Y,
                    w: rect.Width,
                    h: rect.Height,
                });
            }
            lines.push(RawLine { words });
        }
        Ok(Raw { angle, lines })
    }
}
