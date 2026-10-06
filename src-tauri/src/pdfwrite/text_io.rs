//! A parsed PDF for text editing, behind types that name no lopdf: the command layer and the tests hand over bytes and get lines, refusals
//! and walks back (lopdf stays inside `pdfwrite`, ADR-004).

use lopdf::{Document, ObjectId};

use super::load_untrusted;
use super::ops_walk::{walk, Budget, WalkSink};
use super::text_lines::{self, PageLines};
use super::text_refuse;
use crate::error::AppError;
use crate::model::text_edit::{CharGeom, TextEditRefusal};

/// A parsed, unencrypted PDF.
pub struct PageDoc {
    doc: Document,
}

/// One page of a [`PageDoc`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRef(ObjectId);

impl PageDoc {
    /// Parses `bytes` (through the pre-scan). An encrypted file is `unsupported_feature`.
    pub fn load(bytes: &[u8]) -> Result<Self, AppError> {
        let doc = load_untrusted(bytes)?;
        if doc.is_encrypted() {
            return Err(AppError::unsupported("encrypted"));
        }
        Ok(Self { doc })
    }

    /// The pages in order.
    pub fn pages(&self) -> Vec<PageRef> {
        self.doc.get_pages().into_values().map(PageRef).collect()
    }

    /// Page `index` (0-based), `invalid_argument` (`page`) when there is none.
    pub fn page(&self, index: u32) -> Result<PageRef, AppError> {
        self.doc
            .get_pages()
            .into_values()
            .nth(usize::try_from(index).map_err(|_| AppError::invalid("page"))?)
            .map(PageRef)
            .ok_or(AppError::invalid("page"))
    }

    /// Whether the file has a signature (any signed field or a certification).
    pub fn is_signed(&self) -> Result<bool, AppError> {
        Ok(text_refuse::document_refusal(&self.doc)?.is_some())
    }

    /// The operator walk of `page`.
    pub fn walk(
        &self,
        page: PageRef,
        budget: &mut Budget,
        sink: &mut dyn WalkSink,
    ) -> Result<(), AppError> {
        walk(&self.doc, page.0, budget, sink)
    }

    /// The lines of `page` (no refusals stamped in).
    pub fn lines(&self, page: PageRef, chars: &[CharGeom]) -> Result<PageLines, AppError> {
        text_lines::lines(&self.doc, page.0, chars)
    }

    /// Stamps the refusals into `lines` (`document`: a reason that holds for every line).
    pub fn refuse(
        &self,
        lines: &mut PageLines,
        document: Option<TextEditRefusal>,
    ) -> Result<(), AppError> {
        text_refuse::apply(&self.doc, lines, document)
    }
}
