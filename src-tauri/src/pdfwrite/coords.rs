//! Page space (ADR-003 §1: points, origin at the top left of the page's box, y down, before `/Rotate`) to PDF user space (y up, origin
//! wherever the box is), the way `engine::space` reads it the other way round: the box is the crop box inside the media box.

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::model::geometry::{Point, Rect};

/// The deepest `/Parent` chain looked at for an inherited key: a page tree that is deeper, or loops, is damaged.
const MAX_TREE_DEPTH: usize = 64;

/// US Letter, what a page without a usable box is taken to be (PDFium does the same).
const DEFAULT_BOX: [f32; 4] = [0.0, 0.0, 612.0, 792.0];

/// Where the box of a page is in user space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapper {
    left: f32,
    top: f32,
    /// The page's `/Rotate` (0, 90, 180, 270): what an appearance that stays upright turns against.
    rotation: u16,
}

impl Mapper {
    pub const fn new(left: f32, top: f32) -> Self {
        Self {
            left,
            top,
            rotation: 0,
        }
    }

    /// This mapper for a page shown turned by `rotation` degrees.
    pub const fn with_rotation(mut self, rotation: u16) -> Self {
        self.rotation = rotation;
        self
    }

    /// The page's `/Rotate`.
    pub const fn rotation(self) -> u16 {
        self.rotation
    }

    /// The user space position of a point of the page.
    pub fn point(self, p: Point) -> (f32, f32) {
        (self.left + p.x, self.top - p.y)
    }

    /// The user space edges `[left, bottom, right, top]` of a rectangle of the page.
    pub fn rect(self, r: Rect) -> [f32; 4] {
        [
            self.left + r.x,
            self.top - r.y - r.h,
            self.left + r.x + r.w,
            self.top - r.y,
        ]
    }

    /// The page position of a user space point: the inverse of [`Mapper::point`].
    pub fn page_point(self, x: f32, y: f32) -> Point {
        Point {
            x: x - self.left,
            y: self.top - y,
        }
    }
}

fn number(object: &Object) -> Option<f32> {
    object.as_float().ok().filter(|value| value.is_finite())
}

/// `key` of the page, or of the nearest ancestor that has it (the keys a page inherits).
fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..MAX_TREE_DEPTH {
        let dict: &Dictionary = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, value)| value);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// A rectangle `[x0 y0 x1 y1]`, normalized; `None` if it is not four numbers or has no area.
fn read_box(doc: &Document, object: &Object) -> Option<[f32; 4]> {
    let array = object.as_array().ok()?;
    if array.len() != 4 {
        return None;
    }
    let mut values = [0.0f32; 4];
    for (slot, item) in values.iter_mut().zip(array) {
        *slot = number(doc.dereference(item).ok()?.1)?;
    }
    let rect = [
        values[0].min(values[2]),
        values[1].min(values[3]),
        values[0].max(values[2]),
        values[1].max(values[3]),
    ];
    (rect[2] > rect[0] && rect[3] > rect[1]).then_some(rect)
}

/// The mapper of `page`: its crop box inside its media box.
pub fn page_mapper(doc: &Document, page: ObjectId) -> Mapper {
    let media = inherited(doc, page, b"MediaBox")
        .and_then(|object| read_box(doc, object))
        .unwrap_or(DEFAULT_BOX);
    let bounds = inherited(doc, page, b"CropBox")
        .and_then(|object| read_box(doc, object))
        .map(|crop| {
            let clipped = [
                crop[0].max(media[0]),
                crop[1].max(media[1]),
                crop[2].min(media[2]),
                crop[3].min(media[3]),
            ];
            if clipped[2] > clipped[0] && clipped[3] > clipped[1] {
                clipped
            } else {
                media
            }
        })
        .unwrap_or(media);
    Mapper::new(bounds[0], bounds[3]).with_rotation(page_rotation(doc, page))
}

/// The page's `/Rotate`, own or inherited, as 0, 90, 180 or 270.
fn page_rotation(doc: &Document, page: ObjectId) -> u16 {
    inherited(doc, page, b"Rotate")
        // Some producers write /Rotate as a real (90.0); anything non-finite counts as 0.
        .and_then(|value| {
            value.as_i64().ok().or_else(|| {
                value
                    .as_float()
                    .ok()
                    .filter(|f| f.is_finite() && f.abs() < 1.0e6)
                    .map(|f| f.round() as i64)
            })
        })
        .map_or(0, |value| {
            u16::try_from(value.rem_euclid(360) / 90 * 90).unwrap_or(0)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_is_measured_from_the_top_left_with_y_down_and_back() {
        let m = Mapper::new(10.0, 812.0);
        assert_eq!(m.point(Point { x: 0.0, y: 0.0 }), (10.0, 812.0));
        assert_eq!(m.point(Point { x: 100.0, y: 100.0 }), (110.0, 712.0));
        assert_eq!(m.page_point(110.0, 712.0), Point { x: 100.0, y: 100.0 });
        let r = m.rect(Rect {
            x: 90.0,
            y: 100.0,
            w: 50.0,
            h: 12.0,
        });
        assert_eq!(r, [100.0, 700.0, 150.0, 712.0]);
    }
    #[test]
    fn a_real_rotate_counts_and_a_broken_one_is_zero() {
        let rotation = |value: Object| {
            let mut doc = Document::with_version("1.5");
            let mut page = Dictionary::new();
            page.set("Rotate", value);
            let id = doc.add_object(page);
            page_rotation(&doc, id)
        };
        assert_eq!(rotation(Object::Real(90.0)), 90);
        assert_eq!(rotation(Object::Real(-90.0)), 270);
        assert_eq!(rotation(Object::Integer(450)), 90);
        assert_eq!(rotation(Object::Real(f32::NAN)), 0);
        assert_eq!(rotation(Object::Real(f32::INFINITY)), 0);
    }
}
