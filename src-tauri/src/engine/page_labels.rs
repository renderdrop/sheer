//! The printed page labels of a document (`/PageLabels`: "iv", "A-3", "12"), read on the worker for `Job::PageLabels` (ADR-119).
//!
//! PDFium resolves the number tree; this module only reads the label of every page by its file index and cleans it, because the
//! label is the file's own text. At most [`limits::PAGE_LABELS_PAGES_MAX`] pages are read, within [`limits::PAGE_LABELS_BUDGET`]: a
//! document that is over either limit answers no label at all (the caller then numbers by position), never half of them.

use std::time::{Duration, Instant};

use pdfium_render::prelude::*;

use super::space::{load_page, page_count};
use crate::error::AppError;
use crate::limits;

/// A label as the UI may show it: control characters removed, white space at the ends trimmed, at most
/// [`limits::PAGE_LABEL_MAX`] characters (cut on a character boundary). An empty result is no label.
pub(super) fn sanitize_label(raw: &str) -> Option<String> {
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(limits::PAGE_LABEL_MAX)
        .collect();
    let clean = clean.trim();
    (!clean.is_empty()).then(|| clean.to_owned())
}

/// Reads the labels with `label_of(index)` for `count` pages. Over the page limit the answer is empty; when `budget` runs out
/// every label is `None`.
fn read_with(
    count: u32,
    budget: Duration,
    mut label_of: impl FnMut(u32) -> Option<String>,
) -> Vec<Option<String>> {
    if count > limits::PAGE_LABELS_PAGES_MAX {
        return Vec::new();
    }
    let started = Instant::now();
    let mut labels = Vec::with_capacity(count as usize);
    for index in 0..count {
        if started.elapsed() > budget {
            return vec![None; count as usize];
        }
        labels.push(label_of(index).as_deref().and_then(sanitize_label));
    }
    labels
}

/// The label of every page of `document`, by file index. A page PDFium cannot load has none.
pub(super) fn read_labels(document: &PdfDocument<'_>) -> Result<Vec<Option<String>>, AppError> {
    let count = page_count(document)?;
    Ok(read_with(
        count,
        limits::PAGE_LABELS_BUDGET,
        |index| match load_page(document, index) {
            Ok(page) => page.label().map(str::to_owned),
            Err(_) => None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_are_stripped_and_the_ends_trimmed() {
        assert_eq!(sanitize_label("  iv "), Some("iv".to_owned()));
        assert_eq!(sanitize_label("A\u{0}-\u{7}3\n"), Some("A-3".to_owned()));
        assert_eq!(sanitize_label("\u{202e}x"), Some("\u{202e}x".to_owned()));
        assert_eq!(sanitize_label(""), None);
        assert_eq!(sanitize_label(" \t\u{1}"), None);
    }

    #[test]
    fn a_long_label_is_cut_on_a_character_boundary() {
        let long = "\u{e9}".repeat(limits::PAGE_LABEL_MAX + 30);
        let label = sanitize_label(&long).unwrap();
        assert_eq!(label.chars().count(), limits::PAGE_LABEL_MAX);
        let emoji = "\u{1F600}".repeat(200);
        assert_eq!(
            sanitize_label(&emoji).unwrap().chars().count(),
            limits::PAGE_LABEL_MAX
        );
    }

    #[test]
    fn labels_are_read_by_index_and_cleaned() {
        let labels = read_with(3, Duration::from_secs(5), |index| {
            ["i", "\u{0}", "12"]
                .get(index as usize)
                .map(|s| (*s).to_owned())
        });
        assert_eq!(labels, [Some("i".to_owned()), None, Some("12".to_owned())]);
    }

    #[test]
    fn an_overrun_budget_makes_every_label_none() {
        let labels = read_with(5, Duration::ZERO, |_| {
            std::thread::sleep(Duration::from_millis(2));
            Some("x".to_owned())
        });
        assert_eq!(labels, vec![None; 5]);
    }

    #[test]
    fn too_many_pages_answer_nothing() {
        let labels = read_with(
            limits::PAGE_LABELS_PAGES_MAX + 1,
            Duration::from_secs(5),
            |_| Some("x".to_owned()),
        );
        assert!(labels.is_empty());
    }
}
