//! The PDFs under `tests/fixtures/` are made by `tests/support/fixtures.rs`; this test fails when a file is not what its generator
//! makes, so a fixture can never drift from the code that explains it. After changing a generator, rewrite the files with
//!
//! ```text
//! SHEER_REGENERATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --test fixtures_up_to_date
//! ```

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
}

#[test]
fn the_committed_fixtures_are_what_their_generators_make() {
    let regenerate = std::env::var_os("SHEER_REGENERATE_FIXTURES").is_some();
    let mut stale = Vec::new();
    for (name, bytes) in support::fixtures::all() {
        let path = fixtures_dir().join(name);
        if regenerate {
            std::fs::write(&path, &bytes).unwrap();
        } else if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
            stale.push(name);
        }
    }
    assert!(
        stale.is_empty(),
        "tests/fixtures/{stale:?} differ from tests/support/fixtures.rs: regenerate with SHEER_REGENERATE_FIXTURES=1 (see the top of this file)"
    );
}

#[test]
fn every_fixture_starts_like_a_pdf_and_ends_with_its_trailer() {
    for (name, bytes) in support::fixtures::all() {
        assert!(bytes.starts_with(b"%PDF-1.7\n"), "{name}");
        assert!(bytes.ends_with(b"%%EOF\n"), "{name}");
        assert!(
            bytes.len() < 16 * 1024,
            "{name} is not small: {} bytes",
            bytes.len()
        );
    }
}
