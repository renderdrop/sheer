//! Before/after of the thumbnail supersampling (F21.8) on an owner document. The corpus is not in the repository (ADR-133), so the
//! test is `#[ignore]`d: `npm run cargo -- test --test thumbs_supersample -- --ignored --nocapture`. `THUMBS_FILE` (an ID of
//! review/owner/INDEX.md, default `owner-pdf-E4`) picks the file. PNGs go to `review/v21/thumbs/` (untracked).
//!
//! "Before" is the same frame drawn as a page render (no supersampling above 320 px a side, what every thumbnail got since the
//! F19.16 layout); "after" is the thumbnail render. Asserted: the thumbnail has fewer near-black pixels (bold runs no longer clog).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::time::Duration;

use sheer_lib::commands::AppState;
use sheer_lib::engine::encode::FRAME_HEADER_BYTES;
use sheer_lib::engine::{self, Engine, Priority, RenderKey, RenderSpec};

/// Sidebar buckets of the F19.16 layout (A4 at 160-300 device px wide) and the recent-card bucket.
const BUCKETS: [i16; 3] = [-4, -3, -2];

/// Share of pixels darker than 64 in all channels.
fn dark_share(png: &[u8]) -> f64 {
    let picture = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .unwrap()
        .to_rgb8();
    let dark = picture
        .pixels()
        .filter(|p| p.0.iter().all(|c| *c < 64))
        .count();
    dark as f64 / f64::from(picture.width() * picture.height())
}

#[test]
#[ignore = "needs review/owner/corpus (ADR-133) and PDFium; writes review/v21/thumbs/"]
fn thumbnails_are_supersampled_before_and_after() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    if !library.is_file() {
        eprintln!("skipping: PDFium not found");
        return;
    }
    let id = std::env::var("THUMBS_FILE").unwrap_or_else(|_| "owner-pdf-E4".to_owned());
    let Some(path) = support::corpus::file(&id) else {
        return;
    };
    let out = manifest.join("../review/v21/thumbs");
    std::fs::create_dir_all(&out).unwrap();

    let engine = Engine::start(library);
    let state = AppState::new(engine.clone());
    let info = loop {
        match state.open_path(path.clone()).unwrap() {
            Some(info) => break info,
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let pages = info.page_count.min(3);
    for page_index in 0..pages {
        for bucket in BUCKETS {
            let draw = |priority| {
                let frame = engine
                    .render(RenderSpec {
                        key: RenderKey {
                            id: info.id,
                            page_index,
                            bucket,
                            tile: None,
                            thumbnail: false,
                        },
                        priority,
                        generation: 0,
                    })
                    .unwrap();
                frame[FRAME_HEADER_BYTES..].to_vec()
            };
            let before = draw(Priority::Visible);
            let after = draw(Priority::Thumbnail);
            let (dark_before, dark_after) = (dark_share(&before), dark_share(&after));
            let stem = format!("{id}-p{}-b{bucket}", page_index + 1);
            std::fs::write(out.join(format!("{stem}-before.png")), &before).unwrap();
            std::fs::write(out.join(format!("{stem}-after.png")), &after).unwrap();
            println!(
                "{stem}: near-black {:.3} % before, {:.3} % after",
                dark_before * 100.0,
                dark_after * 100.0
            );
            assert!(
                dark_after <= dark_before,
                "{stem}: the thumbnail is darker than the plain render"
            );
        }
    }
}
