//! Print sets (ADR-049 §4): limits, selection, rotation, frames, release and expiry, permission refusal. No PDFium and no window:
//! the pages come from a stand-in renderer. Opening the dialog needs a window and is not tested here.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};

use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::error::{AppError, ErrorCode, UiError};
use sheer_lib::limits;
use sheer_lib::model::protection::{Permission, PermissionSet};
use sheer_lib::model::ranges::PageSelection;
use sheer_lib::pdfwrite::produce::{Control, Phase, Unattended};
use sheer_lib::pdfwrite::redact::{RasterPage, RasterPixels};
use sheer_lib::print::set::{PrintSetBuilder, PrintSets};
use sheer_lib::print::{
    build_set, check_print_permission, encode_page, needs_turn, resolve_pages, rotate_quarter,
    PrintOptions, PrintOrientation, PrintQuality,
};

fn doc(n: u32) -> DocumentId {
    serde_json::from_value(serde_json::json!(n)).unwrap()
}

fn order(count: u32) -> Vec<(PageId, u32)> {
    (0..count).map(|i| (PageId::new(i + 100), i)).collect()
}

fn opts(paper: PrintOrientation, auto_rotate: bool) -> PrintOptions {
    PrintOptions {
        pages: PageSelection::All,
        annotations: true,
        quality: PrintQuality::Standard,
        auto_rotate,
        paper,
    }
}

fn raster(width: u32, height: u32) -> RasterPage {
    let pixels = (0..width * height * 3).map(|i| (i % 251) as u8).collect();
    RasterPage {
        pixels: RasterPixels::Rgb8(pixels),
        width,
        height,
    }
}

/// The code and the `params.what` the UI would see.
fn what(error: AppError) -> (ErrorCode, String) {
    let code = error.code();
    let ui = serde_json::to_value(UiError::from(error)).unwrap();
    (code, ui["params"]["what"].as_str().unwrap_or("").to_owned())
}

fn limit_print_job() -> (ErrorCode, String) {
    (ErrorCode::LimitExceeded, "printJob".to_owned())
}

fn builder_with(frames: usize) -> PrintSetBuilder {
    let mut builder = PrintSetBuilder::new();
    for i in 0..frames {
        builder.push(vec![i as u8; 4], 2_000).unwrap();
    }
    builder
}

#[test]
fn a_set_refuses_the_page_and_the_byte_past_the_limits() {
    let mut builder = PrintSetBuilder::new();
    for _ in 0..limits::MAX_PRINT_PAGES {
        builder.push(vec![0], limits::MAX_PRINT_PAGES).unwrap();
    }
    let error = builder.push(vec![0], limits::MAX_PRINT_PAGES).unwrap_err();
    assert_eq!(what(error), limit_print_job());

    // The cap of high quality is lower than the cap of a set.
    let mut high = PrintSetBuilder::new();
    for _ in 0..limits::MAX_PRINT_PAGES_HIGH {
        high.push(vec![0], PrintQuality::High.max_pages()).unwrap();
    }
    assert!(high.push(vec![0], PrintQuality::High.max_pages()).is_err());

    let mut heavy = PrintSetBuilder::new();
    heavy
        .push(vec![0; limits::MAX_PRINT_SET_BYTES], 10)
        .unwrap();
    let error = heavy.push(vec![0], 10).unwrap_err();
    assert_eq!(what(error), limit_print_job());
}

#[test]
fn selections_resolve_in_document_order_and_bad_ones_are_refused() {
    let pages = order(6);
    let resolve = |sel: &PageSelection| resolve_pages(sel, &pages, 2_000);
    assert_eq!(
        resolve(&PageSelection::All).unwrap(),
        vec![0, 1, 2, 3, 4, 5]
    );
    let current = PageSelection::Current {
        page_id: PageId::new(102),
    };
    assert_eq!(resolve(&current).unwrap(), vec![2]);
    let some = PageSelection::Pages {
        pages: vec![PageId::new(104), PageId::new(100)],
    };
    assert_eq!(resolve(&some).unwrap(), vec![0, 4]);
    let ranges = PageSelection::Ranges {
        text: "1-2, 5-".into(),
    };
    assert_eq!(resolve(&ranges).unwrap(), vec![0, 1, 4, 5]);
    for bad in [
        PageSelection::Ranges { text: "0".into() },
        PageSelection::Ranges { text: "9".into() },
        PageSelection::Ranges { text: "x".into() },
        PageSelection::Current {
            page_id: PageId::new(1),
        },
        PageSelection::Pages { pages: vec![] },
    ] {
        let error = resolve(&bad).unwrap_err();
        assert_eq!(
            what(error),
            (ErrorCode::InvalidArgument, "pageSelection".to_owned()),
            "{bad:?}"
        );
    }
    // Seven pages named, six allowed.
    let error = resolve_pages(&PageSelection::All, &order(7), 6).unwrap_err();
    assert_eq!(what(error), limit_print_job());
}

#[test]
fn a_quarter_turn_moves_the_pixels_clockwise() {
    // 3 wide and 2 tall, "a b c / d e f", becomes 2 wide and 3 tall, "d a / e b / f c".
    let page = RasterPage {
        pixels: RasterPixels::Gray8(vec![1, 2, 3, 4, 5, 6]),
        width: 3,
        height: 2,
    };
    let turned = rotate_quarter(page);
    assert_eq!((turned.width, turned.height), (2, 3));
    assert_eq!(turned.pixels, RasterPixels::Gray8(vec![4, 1, 5, 2, 6, 3]));
    let rgb = rotate_quarter(raster(5, 2));
    assert_eq!((rgb.width, rgb.height), (2, 5));
}

#[test]
fn landscape_pages_are_turned_to_the_paper_only_when_asked() {
    assert!(needs_turn(200, 100, PrintOrientation::Portrait));
    assert!(!needs_turn(100, 200, PrintOrientation::Portrait));
    assert!(needs_turn(100, 200, PrintOrientation::Landscape));
    assert!(!needs_turn(100, 100, PrintOrientation::Portrait));
    assert!(!needs_turn(100, 100, PrintOrientation::Landscape));

    let size = |frame: &[u8]| {
        (
            u32::from_le_bytes(frame[8..12].try_into().unwrap()),
            u32::from_le_bytes(frame[12..16].try_into().unwrap()),
        )
    };
    let on = encode_page(raster(64, 32), PrintOrientation::Portrait, true).unwrap();
    assert_eq!(size(&on), (32, 64));
    let off = encode_page(raster(64, 32), PrintOrientation::Portrait, false).unwrap();
    assert_eq!(size(&off), (64, 32));
    let kept = encode_page(raster(32, 64), PrintOrientation::Portrait, true).unwrap();
    assert_eq!(size(&kept), (32, 64));
}

#[test]
fn a_frame_is_shr1_format_3_with_a_jpeg_inside() {
    let frame = encode_page(raster(16, 24), PrintOrientation::Portrait, true).unwrap();
    assert_eq!(&frame[..4], b"SHR1");
    assert_eq!(frame[4], 3);
    assert_eq!(&frame[5..8], &[0, 0, 0]);
    assert_eq!(&frame[16..19], &[0xff, 0xd8, 0xff]);
    let grey = RasterPage {
        pixels: RasterPixels::Gray8(vec![200; 16 * 16]),
        width: 16,
        height: 16,
    };
    let frame = encode_page(grey, PrintOrientation::Portrait, true).unwrap();
    assert_eq!(&frame[16..18], &[0xff, 0xd8]);
    // A buffer that does not fit its size is refused, not drawn.
    let broken = RasterPage {
        pixels: RasterPixels::Rgb8(vec![0; 5]),
        width: 16,
        height: 16,
    };
    assert!(encode_page(broken, PrintOrientation::Portrait, false).is_err());
}

#[test]
fn building_a_set_renders_each_page_in_order_and_stops_on_error() {
    let mut seen = Vec::new();
    let builder = build_set(
        &[4, 0, 2],
        2_000,
        &opts(PrintOrientation::Portrait, true),
        &Unattended,
        |index| {
            seen.push(index);
            Ok(raster(8, 8))
        },
    )
    .unwrap();
    assert_eq!(seen, vec![4, 0, 2]);
    assert_eq!(builder.len(), 3);

    let mut calls = 0;
    let error = build_set(
        &[0, 1, 2],
        2_000,
        &opts(PrintOrientation::Portrait, true),
        &Unattended,
        |_| {
            calls += 1;
            if calls == 2 {
                Err(AppError::invalid("page"))
            } else {
                Ok(raster(8, 8))
            }
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(calls, 2);

    // Past the page cap of the call.
    let error = build_set(
        &[0, 1, 2],
        2,
        &opts(PrintOrientation::Portrait, false),
        &Unattended,
        |_| Ok(raster(8, 8)),
    )
    .unwrap_err();
    assert_eq!(what(error), limit_print_job());
}

#[test]
fn a_cancelled_job_builds_nothing() {
    struct Stop;
    impl Control for Stop {
        fn check(&self) -> Result<(), AppError> {
            Err(AppError::new(ErrorCode::Cancelled))
        }
        fn progress(&self, _: Phase, _: u32, _: u32) {}
    }
    let error = build_set(
        &[0],
        10,
        &opts(PrintOrientation::Portrait, true),
        &Stop,
        |_| Ok(raster(8, 8)),
    )
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Cancelled);
}

#[test]
fn frames_are_served_by_index_and_release_forgets_them() {
    let sets = PrintSets::new();
    let id = sets.insert(doc(1), builder_with(3));
    assert_eq!(sets.pages(id).unwrap(), 3);
    assert_eq!(&*sets.frame(id, 2).unwrap(), &[2, 2, 2, 2]);
    assert_eq!(
        sets.frame(id, 3).unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    sets.release(id);
    sets.release(id);
    assert_eq!(sets.frame(id, 0).unwrap_err().code(), ErrorCode::NotFound);
    assert!(sets.is_empty());
}

#[test]
fn closing_a_document_drops_its_sets_only() {
    let sets = PrintSets::new();
    let a = sets.insert(doc(1), builder_with(1));
    let b = sets.insert(doc(2), builder_with(1));
    sets.release_doc(doc(1));
    assert!(sets.pages(a).is_err());
    assert!(sets.pages(b).is_ok());
}

#[test]
fn a_set_expires_after_ten_minutes_and_the_oldest_makes_room() {
    let sets = PrintSets::new();
    let start = Instant::now();
    let id = sets.insert_at(doc(1), builder_with(1), start);
    let before = start + limits::PRINT_SET_TTL - Duration::from_secs(1);
    let after = start + limits::PRINT_SET_TTL;
    assert!(sets.pages_at(id, before).is_ok());
    assert!(sets.frame_at(id, 0, after).is_err());
    assert_eq!(sets.sweep(after), 1);
    assert!(sets.is_empty());

    let ids: Vec<u32> = (0..=limits::MAX_PRINT_SETS)
        .map(|i| {
            let at = start + Duration::from_secs(i as u64);
            sets.insert_at(doc(1), builder_with(1), at)
        })
        .collect();
    assert_eq!(sets.len(), limits::MAX_PRINT_SETS);
    assert!(sets.pages_at(ids[0], start).is_err());
    assert!(sets.pages_at(ids[1], start).is_ok());
}

#[test]
fn a_document_that_forbids_printing_is_refused() {
    let no_print = PermissionSet::from_list(&[Permission::Copy, Permission::Edit]);
    let error = check_print_permission(Some(no_print)).unwrap_err();
    assert_eq!(what(error), (ErrorCode::ReadOnly, "permission".to_owned()));
    assert!(check_print_permission(Some(PermissionSet::NONE)).is_err());
    assert!(check_print_permission(Some(PermissionSet::from_list(&[Permission::Print]))).is_ok());
    assert!(check_print_permission(None).is_ok());
}
