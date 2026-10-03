//! The tiles of a page through the public limits API: they cover the page exactly, and the ids a render may name are checked.
//!
//! The unit tests in `limits` pin single tiles (the edge tile of a 2500 x 1100 px page, the grid of the largest page). These
//! tests add the property the renderer relies on: for any page size, the tiles of its grid partition the page, with no gap,
//! no overlap and no empty tile, and nothing outside the grid is a tile. They run over odd sizes, exact multiples of the tile
//! size, a sliver of one pixel, and every bucket the UI may ask for.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use sheer_lib::error::ErrorCode;
use sheer_lib::limits::{
    bucket_scale, page_pixel_size, render_region, Region, MAX_BUCKET, MAX_PAGE_PIXEL_SIDE,
    MAX_TILES_PER_SIDE, MIN_BUCKET, TILE_SIZE_PX,
};

fn grid(page: (u32, u32)) -> (u32, u32) {
    (page.0.div_ceil(TILE_SIZE_PX), page.1.div_ceil(TILE_SIZE_PX))
}

/// Asserts that the tiles of the page's grid partition it exactly, and that the first tile outside the grid is refused.
fn assert_tiles_partition(page: (u32, u32)) {
    let (columns, rows) = grid(page);
    let mut area = 0u64;
    let mut previous_row: Option<Region> = None;
    for row in 0..rows {
        let mut previous: Option<Region> = None;
        for column in 0..columns {
            let tile = (u16::try_from(column).unwrap(), u16::try_from(row).unwrap());
            let region = render_region(page, Some(tile)).unwrap_or_else(|error| {
                panic!("tile {tile:?} of {page:?} is in the grid but refused: {error:?}")
            });
            // Never empty, never larger than a tile, never outside the page.
            assert!(region.width >= 1 && region.height >= 1, "{page:?} {tile:?}");
            assert!(
                region.width <= TILE_SIZE_PX && region.height <= TILE_SIZE_PX,
                "{page:?} {tile:?}"
            );
            assert!(
                region.x + region.width <= page.0 && region.y + region.height <= page.1,
                "{page:?} {tile:?} reaches past the page"
            );
            // The tile sits on the grid, and abuts its neighbours: the one to its left ended where it begins.
            assert_eq!(region.x, column * TILE_SIZE_PX, "{page:?} {tile:?}");
            assert_eq!(region.y, row * TILE_SIZE_PX, "{page:?} {tile:?}");
            match previous {
                Some(left) => assert_eq!(
                    left.x + left.width,
                    region.x,
                    "{page:?} {tile:?} gap or overlap"
                ),
                None => assert_eq!(region.x, 0),
            }
            // Only the last column and the last row are cut short.
            if column + 1 < columns {
                assert_eq!(region.width, TILE_SIZE_PX, "{page:?} {tile:?}");
            } else {
                assert_eq!(region.x + region.width, page.0, "{page:?} {tile:?}");
            }
            if row + 1 < rows {
                assert_eq!(region.height, TILE_SIZE_PX, "{page:?} {tile:?}");
            } else {
                assert_eq!(region.y + region.height, page.1, "{page:?} {tile:?}");
            }
            if let Some(above) = previous_row.filter(|_| column == 0) {
                assert_eq!(
                    above.y + above.height,
                    region.y,
                    "{page:?} {tile:?} gap or overlap"
                );
            }
            if column == 0 {
                previous_row = Some(region);
            }
            area += u64::from(region.width) * u64::from(region.height);
            previous = Some(region);
        }
    }
    // Every tile is inside the page and they abut: equal areas then mean nothing is left out and nothing is drawn twice.
    assert_eq!(area, u64::from(page.0) * u64::from(page.1), "{page:?}");

    // One tile past the grid, on either axis, is not a tile of this page.
    for beyond in [(columns, 0), (0, rows), (columns, rows)] {
        let (Ok(column), Ok(row)) = (u16::try_from(beyond.0), u16::try_from(beyond.1)) else {
            continue;
        };
        assert_eq!(
            render_region(page, Some((column, row))).unwrap_err().code(),
            ErrorCode::InvalidArgument,
            "{page:?} {beyond:?}"
        );
    }
}

#[test]
fn the_tiles_of_odd_sized_pages_cover_them_exactly() {
    for page in [
        (1, 1),
        (1, 1024),
        (1024, 1),
        (1023, 1025),
        (1025, 1023),
        (1025, 1025),
        (2047, 2049),
        (2049, 3071),
        (4095, 4097),
        (4897, 6337),
        (8193, 4097),
        (3333, 7777),
    ] {
        assert_tiles_partition(page);
    }
}

#[test]
fn the_tiles_of_exact_multiples_of_the_tile_size_leave_no_empty_tile_after_the_last() {
    for page in [
        (1024, 1024),
        (2048, 1024),
        (1024, 4096),
        (4096, 4096),
        (8192, 3072),
    ] {
        assert_tiles_partition(page);
        let (columns, rows) = grid(page);
        // The last tile is a whole one, and the grid is exactly page / tile.
        assert_eq!(columns * TILE_SIZE_PX, page.0, "{page:?}");
        assert_eq!(rows * TILE_SIZE_PX, page.1, "{page:?}");
        let last = render_region(
            page,
            Some((
                u16::try_from(columns - 1).unwrap(),
                u16::try_from(rows - 1).unwrap(),
            )),
        )
        .unwrap();
        assert_eq!((last.width, last.height), (TILE_SIZE_PX, TILE_SIZE_PX));
    }
}

#[test]
fn a_page_one_pixel_past_a_multiple_gets_a_sliver_of_one_pixel() {
    let page = (2049, 1025);
    assert_tiles_partition(page);
    let sliver = render_region(page, Some((2, 1))).unwrap();
    assert_eq!(
        sliver,
        Region {
            x: 2048,
            y: 1024,
            width: 1,
            height: 1
        }
    );
}

#[test]
fn the_largest_page_has_a_full_grid_of_64_tiles_a_side_and_no_tile_beyond_it() {
    // 4096 tiles, each looked at: the whole of a 65 536 x 65 536 px page is covered once.
    assert_tiles_partition((MAX_PAGE_PIXEL_SIDE, MAX_PAGE_PIXEL_SIDE));
    assert_eq!(grid((MAX_PAGE_PIXEL_SIDE, 1)).0, MAX_TILES_PER_SIDE);
    // Even the largest tile index a request can carry is refused rather than wrapped or clamped.
    for tile in [
        (u16::MAX, 0),
        (0, u16::MAX),
        (u16::MAX, u16::MAX),
        (64, 0),
        (0, 64),
    ] {
        assert_eq!(
            render_region((MAX_PAGE_PIXEL_SIDE, MAX_PAGE_PIXEL_SIDE), Some(tile))
                .unwrap_err()
                .code(),
            ErrorCode::InvalidArgument,
            "{tile:?}"
        );
    }
}

#[test]
fn the_tiles_cover_a_page_at_every_bucket_the_ui_may_ask_for() {
    // US Letter, A4 with fractional sides, and a long thin page; every bucket of the accepted range.
    let pages: [(f32, f32); 4] = [
        (612.0, 792.0),
        (595.276, 841.89),
        (14_400.0, 36.0),
        (3.0, 7.0),
    ];
    let mut checked = 0;
    for (width_pt, height_pt) in pages {
        for bucket in MIN_BUCKET..=MAX_BUCKET {
            let scale = bucket_scale(bucket).unwrap();
            // A bucket that makes the page larger than the backend renders is refused up front, which is fine: it has no tiles.
            let Ok(page) = page_pixel_size(width_pt, height_pt, scale) else {
                continue;
            };
            // The grid is derived from the pixel size, rounded up: a page is never clipped.
            assert!(
                f64::from(page.0) >= f64::from(width_pt) * scale,
                "{width_pt} x {height_pt} at {bucket}"
            );
            assert!(
                f64::from(page.1) >= f64::from(height_pt) * scale,
                "{width_pt} x {height_pt} at {bucket}"
            );
            assert_tiles_partition(page);
            checked += 1;
        }
    }
    assert!(
        checked > 100,
        "only {checked} combinations were within the page limit"
    );
}

#[test]
fn buckets_outside_the_range_and_tiles_outside_the_grid_are_rejected_with_invalid_argument() {
    for bad in [MIN_BUCKET - 1, MAX_BUCKET + 1, i16::MIN, i16::MAX] {
        assert_eq!(
            bucket_scale(bad).unwrap_err().code(),
            ErrorCode::InvalidArgument,
            "{bad}"
        );
    }
    // The ends of the range are accepted, and one step beyond either is not.
    assert!(bucket_scale(MIN_BUCKET).is_ok());
    assert!(bucket_scale(MAX_BUCKET).is_ok());
    // A tile on a one-tile page: only (0, 0) is one.
    assert!(render_region((300, 400), Some((0, 0))).is_ok());
    for tile in [(1, 0), (0, 1), (1, 1), (u16::MAX, u16::MAX)] {
        assert_eq!(
            render_region((300, 400), Some(tile)).unwrap_err().code(),
            ErrorCode::InvalidArgument,
            "{tile:?}"
        );
    }
}
