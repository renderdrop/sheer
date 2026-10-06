//! The E4 page-1 Präambel line ("Der derzeit dringendste Handlungsbedarf zum Schutz von Vorgärten besteht in") and the overflow caption
//! of a line edited without a re-break (ADR-132). The corpus is not in the repository (`review/owner/corpus/`, ADR-126), so the tests are
//! `#[ignore]`d: `cargo test --test text_edit_praeambel_corpus -- --ignored --nocapture`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::time::Duration;

use sheer_lib::commands::text_preview::PreviewRequest;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::text_edit::{
    LineEditable, LineKey, TextEdit, TextFit, TextLineInfo, TextScope,
};

const FILE: &str = "owner-pdf-E4";

fn open() -> Option<(AppState, DocumentId, PageId)> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    if !library.is_file() {
        eprintln!("skipping: PDFium not found");
        return None;
    }
    let path = support::corpus::file(FILE)?;
    let state = AppState::new(Engine::start(library));
    let info = loop {
        match state.open_path(path.clone()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("open: {e:?}"),
        }
    };
    Some((state, info.id, PageId::new(0)))
}

fn preview(
    state: &AppState,
    id: DocumentId,
    page: PageId,
    key: LineKey,
    text: String,
    scope: TextScope,
    generation: u32,
) -> Result<f32, String> {
    state
        .text_edit_preview(
            id,
            page,
            PreviewRequest {
                key,
                text,
                fit: TextFit::KeepStart,
                scope,
                generation,
                scale: 1.0,
            },
        )
        .map(|p| p.meta.overflow_pt)
        .map_err(|e| format!("{e:?}"))
}

/// One engine per process (PDFium binds once), so both checks share one test.
#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn e4_praeambel_and_overflow_caption() {
    let Some((state, id, page)) = open() else {
        eprintln!("skipping the Praeambel corpus test");
        return;
    };
    praeambel_and_two_font_lines(&state, id, page);
    overflow_is_the_distance_past_the_paragraph_edge(&state, id, page);
}

fn praeambel_and_two_font_lines(state: &AppState, id: DocumentId, page: PageId) {
    let lines = state.text_edit_lines(id, page).unwrap().lines;
    let praeambel = lines
        .iter()
        .find(|l| l.text.contains("Der derzeit dringendste Handlungsbedarf"))
        .expect("the Präambel line");
    println!("Präambel: {:?} {:?}", praeambel.editable, praeambel.font);
    assert!(!matches!(praeambel.editable, LineEditable::No { .. }));
    let text = format!("{}x", praeambel.text);
    for (generation, scope) in [(1, TextScope::Line), (2, TextScope::Paragraph)] {
        let overflow = preview(
            state,
            id,
            page,
            praeambel.key,
            text.clone(),
            scope,
            generation,
        );
        assert!(overflow.is_ok(), "preview {scope:?}: {overflow:?}");
    }
    // Paragraph scope on this line either previews, or the lines payload says the paragraph cannot be re-broken (a mate is `No`).
    let reflowable = lines
        .iter()
        .filter(|l| l.paragraph == praeambel.paragraph)
        .all(|l| !matches!(l.editable, LineEditable::No { .. }));
    for (generation, variant) in [
        (110, praeambel.text.replace("Schutz", "umfassenden Schutz")),
        (111, praeambel.text.replace("Handlungsbedarf ", "")),
        (
            112,
            format!(
                "{} Gebiete und weitere Worte bis zum Zeilenende",
                praeambel.text
            ),
        ),
        (113, String::new()),
    ] {
        let r = preview(
            state,
            id,
            page,
            praeambel.key,
            variant.clone(),
            TextScope::Paragraph,
            generation,
        );
        println!("variant {variant:?}: {r:?} (reflowable by payload: {reflowable})");
        assert!(
            r.is_ok() || !reflowable,
            "paragraph preview {variant:?}: {r:?}"
        );
    }
    // The two lines of the paragraph with a quote in another font cannot be edited: they say so instead of opening a box.
    for needle in ["Gebiete wird durch die Folge", "Zaun) - Vorgarten"] {
        let line = lines
            .iter()
            .find(|l| l.text.starts_with(needle))
            .expect("quote line");
        assert!(
            matches!(line.editable, LineEditable::No { .. }),
            "{:?} is {:?}",
            line.text,
            line.editable
        );
    }
}

fn overflow_is_the_distance_past_the_paragraph_edge(
    state: &AppState,
    id: DocumentId,
    page: PageId,
) {
    let lines = state.text_edit_lines(id, page).unwrap().lines;
    let line: &TextLineInfo = lines
        .iter()
        .find(|l| l.text.contains("Kommunalordnung - ThürKO)"))
        .expect("line 3");
    let para: Vec<&TextLineInfo> = lines
        .iter()
        .filter(|l| l.paragraph == line.paragraph)
        .collect();
    let mut ends: Vec<f32> = para[..para.len() - 1]
        .iter()
        .map(|l| l.bounds.x + l.bounds.w)
        .collect();
    ends.sort_by(f32::total_cmp);
    let right = ends[ends.len() / 2];
    let text = format!("{} im Freistaat", line.text.trim_end());
    let overflow = preview(
        state,
        id,
        page,
        line.key,
        text.clone(),
        TextScope::Line,
        200,
    )
    .unwrap();
    println!("overflow {overflow} pt, edge {right}");
    // The unedited line is already at the edge: the whole of " im Freistaat" runs past it.
    assert!(overflow > 20.0, "caption says {overflow} pt");
    state
        .edit_text_line(
            id,
            page,
            TextEdit {
                key: line.key,
                text,
                fit: TextFit::KeepStart,
                scope: TextScope::Line,
            },
        )
        .expect("applied");
    let after = state.text_edit_lines(id, page).unwrap().lines;
    let edited = after
        .iter()
        .find(|l| l.text.contains("im Freistaat"))
        .expect("edited line");
    let end = edited.bounds.x + edited.bounds.w;
    assert!(
        (overflow - (end - right)).abs() <= 1.5,
        "caption {overflow} pt, the line runs {} pt past the edge",
        end - right
    );
}
