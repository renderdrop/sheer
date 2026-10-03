//! Page space (ADR-003 §1): points, origin at the top left corner of the page's box (the crop box inside the media box), y pointing
//! down, before `/Rotate` is applied. PDF user space has y pointing up and an origin that is wherever the page's box happens to
//! be, so every coordinate PDFium reports goes through a [`PageBox`] on its way to the UI.

use serde::Serialize;

use crate::limits;

/// A position on a page, in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// A rectangle on a page, in points: its top left corner and its size (never negative).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Four corners of a (possibly rotated) rectangle: top left, top right, bottom left, bottom right (ADR-003 §2).
pub type Quad = [Point; 4];

/// Where a page's box is in PDF user space: the left edge and the top edge (the larger y). Coordinates on the page are measured
/// from there, so they do not depend on where in user space the box was put.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageBox {
    left: f32,
    top: f32,
}

/// Coordinates are kept to a hundredth of a point: far finer than a screen shows, and a page of text has hundreds of thousands
/// of them to send.
fn quantize(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

/// A coordinate that is finite, brought into the range a page may have (ADR-003: within +-14 400 pt) and quantized.
fn sanitize(value: f32) -> Option<f32> {
    value
        .is_finite()
        .then(|| quantize(value.clamp(-limits::MAX_PAGE_SIDE_PT, limits::MAX_PAGE_SIDE_PT)))
}

impl PageBox {
    /// The box whose left edge is `left` and whose top edge is `top` in user space. `None` if either is not a number: the box of
    /// a page comes from the file.
    pub fn new(left: f32, top: f32) -> Option<Self> {
        (left.is_finite() && top.is_finite()).then_some(Self { left, top })
    }

    /// The position of the user space point (`x`, `y`) on the page. `None` if it is not finite.
    pub fn point(self, x: f32, y: f32) -> Option<Point> {
        Some(Point {
            x: sanitize(x - self.left)?,
            y: sanitize(self.top - y)?,
        })
    }

    /// The rectangle with the user space edges `left`, `bottom`, `right` and `top`, in either order. `None` if one is not finite.
    pub fn rect(self, left: f32, bottom: f32, right: f32, top: f32) -> Option<Rect> {
        if ![left, bottom, right, top]
            .iter()
            .all(|edge| edge.is_finite())
        {
            return None;
        }
        let (x0, x1) = (left.min(right), left.max(right));
        let (y0, y1) = (bottom.min(top), bottom.max(top));
        let upper_left = self.point(x0, y1)?;
        let lower_right = self.point(x1, y0)?;
        Some(Rect {
            x: upper_left.x,
            y: upper_left.y,
            w: quantize((lower_right.x - upper_left.x).max(0.0)),
            h: quantize((lower_right.y - upper_left.y).max(0.0)),
        })
    }

    /// The same rectangle as four corners: top left, top right, bottom left, bottom right.
    pub fn quad(self, left: f32, bottom: f32, right: f32, top: f32) -> Option<Quad> {
        if ![left, bottom, right, top]
            .iter()
            .all(|edge| edge.is_finite())
        {
            return None;
        }
        let (x0, x1) = (left.min(right), left.max(right));
        let (y0, y1) = (bottom.min(top), bottom.max(top));
        Some([
            self.point(x0, y1)?,
            self.point(x1, y1)?,
            self.point(x0, y0)?,
            self.point(x1, y0)?,
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_box() -> PageBox {
        // A crop box that starts at (10, 20) of user space and is 792 pt high: its top edge is at y = 812.
        PageBox::new(10.0, 812.0).unwrap()
    }

    #[test]
    fn a_point_is_measured_from_the_top_left_of_the_box_with_y_down() {
        let page = page_box();
        assert_eq!(page.point(10.0, 812.0), Some(Point { x: 0.0, y: 0.0 }));
        assert_eq!(page.point(110.0, 712.0), Some(Point { x: 100.0, y: 100.0 }));
        // The bottom edge of the box is the page height.
        assert_eq!(page.point(10.0, 20.0), Some(Point { x: 0.0, y: 792.0 }));
    }

    #[test]
    fn a_rectangle_comes_out_normalized_whatever_order_its_edges_are_given_in() {
        let page = page_box();
        let expected = Rect {
            x: 90.0,
            y: 100.0,
            w: 50.0,
            h: 12.0,
        };
        assert_eq!(page.rect(100.0, 700.0, 150.0, 712.0), Some(expected));
        assert_eq!(page.rect(150.0, 712.0, 100.0, 700.0), Some(expected));
    }

    #[test]
    fn a_quad_lists_top_left_top_right_bottom_left_bottom_right() {
        let quad = page_box().quad(100.0, 700.0, 150.0, 712.0).unwrap();
        assert_eq!(
            quad,
            [
                Point { x: 90.0, y: 100.0 },
                Point { x: 140.0, y: 100.0 },
                Point { x: 90.0, y: 112.0 },
                Point { x: 140.0, y: 112.0 },
            ]
        );
    }

    #[test]
    fn what_is_not_a_number_is_refused_and_what_is_huge_is_brought_into_range() {
        let page = page_box();
        assert_eq!(page.point(f32::NAN, 0.0), None);
        assert_eq!(page.point(0.0, f32::INFINITY), None);
        assert_eq!(page.rect(0.0, 0.0, f32::NEG_INFINITY, 1.0), None);
        assert_eq!(page.quad(0.0, f32::NAN, 1.0, 1.0), None);
        assert_eq!(PageBox::new(f32::NAN, 0.0), None);
        let far = page.point(1e30, -1e30).unwrap();
        assert_eq!(
            far,
            Point {
                x: 14_400.0,
                y: 14_400.0
            }
        );
    }

    #[test]
    fn coordinates_are_kept_to_a_hundredth_of_a_point() {
        let point = page_box().point(10.123_456, 812.0 - 0.987_654).unwrap();
        assert_eq!(point, Point { x: 0.12, y: 0.99 });
    }
}
