//! Vector art from outline polygons (ADR-041 §6): what the pad draws (perfect-freehand outlines in pad pixels) and what the typed
//! signature lays out come here. The polygons are trimmed to their extent, scaled to [`UNIT_HEIGHT`] units high, simplified within
//! [`TOLERANCE`] units and rounded to a hundredth of a unit.

use super::Art;
use crate::error::AppError;
use crate::model::annotation::SIGNATURE_ASPECT_RANGE;
use crate::model::geometry::Point;

/// The height of normalized art, in units.
pub const UNIT_HEIGHT: f32 = 1_000.0;
/// How far simplification may move an outline, in units.
pub const TOLERANCE: f32 = 0.5;
pub const MAX_POLYGONS: usize = 256;
pub const MAX_POINTS_PER_POLYGON: usize = 10_000;
pub const MAX_POINTS_TOTAL: usize = 50_000;
/// Input coordinates beyond this are not a pad's.
const MAX_INPUT_COORD: f32 = 1.0e5;

fn distance_to_segment(p: Point, a: Point, b: Point) -> f32 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length_sq = dx * dx + dy * dy;
    if length_sq <= f32::EPSILON {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / length_sq).clamp(0.0, 1.0);
    (p.x - (a.x + t * dx)).hypot(p.y - (a.y + t * dy))
}

/// Ramer-Douglas-Peucker on an open polyline, with a stack instead of recursion (a hostile polygon can have 10 000 points).
fn simplify_open(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((first, last)) = stack.pop() {
        let mut far = 0.0f32;
        let mut at = first;
        for index in first + 1..last {
            let d = distance_to_segment(points[index], points[first], points[last]);
            if d > far {
                far = d;
                at = index;
            }
        }
        if far > tolerance {
            keep[at] = true;
            stack.push((first, at));
            stack.push((at, last));
        }
    }
    points
        .iter()
        .zip(&keep)
        .filter(|(_, keep)| **keep)
        .map(|(point, _)| *point)
        .collect()
}

/// Simplifies a closed polygon: split at the point farthest from the first, simplify both halves.
fn simplify_ring(ring: &[Point], tolerance: f32) -> Vec<Point> {
    if ring.len() < 4 {
        return ring.to_vec();
    }
    let first = ring[0];
    let mut far = 0usize;
    let mut best = -1.0f32;
    for (index, point) in ring.iter().enumerate() {
        let d = (point.x - first.x).hypot(point.y - first.y);
        if d > best {
            best = d;
            far = index;
        }
    }
    let mut closed_tail = ring[far..].to_vec();
    closed_tail.push(first);
    let mut out = simplify_open(&ring[..=far], tolerance);
    let tail = simplify_open(&closed_tail, tolerance);
    // The halves share the far point; the tail ends at the first point again.
    out.extend(tail.iter().skip(1).take(tail.len().saturating_sub(2)));
    out
}

fn quantize(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

/// Normalizes `outlines` into vector art. `invalid_argument` (`outlines`) for no polygon with an area, a number that is not finite or
/// is beyond reach, or a shape whose width over height is outside the aspect range of a signature; `limit_exceeded` for too many
/// polygons or points.
pub fn normalize(outlines: &[Vec<Point>]) -> Result<Art, AppError> {
    normalize_with(outlines, true)
}

/// [`normalize`] for outlines Rust made itself (the typed signature): the counts of the input are not limited, since a name has many
/// curve points before simplification; the result is held to the same limits.
pub(super) fn normalize_trusted(outlines: &[Vec<Point>]) -> Result<Art, AppError> {
    normalize_with(outlines, false)
}

fn normalize_with(outlines: &[Vec<Point>], limit_input: bool) -> Result<Art, AppError> {
    if limit_input && outlines.len() > MAX_POLYGONS {
        return Err(AppError::limit("outlines", MAX_POLYGONS as u64));
    }
    let mut total = 0usize;
    for polygon in outlines {
        total += polygon.len();
        if limit_input && polygon.len() > MAX_POINTS_PER_POLYGON {
            return Err(AppError::limit("points", MAX_POINTS_PER_POLYGON as u64));
        }
        if limit_input && total > MAX_POINTS_TOTAL {
            return Err(AppError::limit("points", MAX_POINTS_TOTAL as u64));
        }
        if polygon.iter().any(|p| {
            !p.x.is_finite()
                || !p.y.is_finite()
                || p.x.abs() > MAX_INPUT_COORD
                || p.y.abs() > MAX_INPUT_COORD
        }) {
            return Err(AppError::invalid("outlines"));
        }
    }
    // Duplicate neighbours and a repeated closing point carry nothing; a polygon needs three corners.
    let mut rings: Vec<Vec<Point>> = Vec::new();
    for polygon in outlines {
        let mut ring: Vec<Point> = Vec::with_capacity(polygon.len());
        for point in polygon {
            if ring.last() != Some(point) {
                ring.push(*point);
            }
        }
        if ring.len() > 1 && ring.first() == ring.last() {
            ring.pop();
        }
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }
    let mut min = Point {
        x: f32::MAX,
        y: f32::MAX,
    };
    let mut max = Point {
        x: f32::MIN,
        y: f32::MIN,
    };
    for point in rings.iter().flatten() {
        min.x = min.x.min(point.x);
        min.y = min.y.min(point.y);
        max.x = max.x.max(point.x);
        max.y = max.y.max(point.y);
    }
    let (width, height) = (max.x - min.x, max.y - min.y);
    if rings.is_empty() || width < 1.0e-3 || height < 1.0e-3 {
        return Err(AppError::invalid("outlines"));
    }
    let scale = UNIT_HEIGHT / height;
    let out_width = quantize(width * scale);
    if !SIGNATURE_ASPECT_RANGE.contains(&(out_width / UNIT_HEIGHT)) {
        return Err(AppError::invalid("outlines"));
    }
    let paths: Vec<Vec<Point>> = rings
        .iter()
        .map(|ring| {
            let scaled: Vec<Point> = ring
                .iter()
                .map(|p| Point {
                    x: (p.x - min.x) * scale,
                    y: (p.y - min.y) * scale,
                })
                .collect();
            simplify_ring(&scaled, TOLERANCE)
                .into_iter()
                .map(|p| Point {
                    x: quantize(p.x),
                    y: quantize(p.y),
                })
                .collect::<Vec<_>>()
        })
        .filter(|ring| ring.len() >= 3)
        .collect();
    if paths.is_empty()
        || paths.len() > MAX_POLYGONS * 4
        || paths.iter().map(Vec::len).sum::<usize>() > MAX_POINTS_TOTAL
    {
        return Err(AppError::invalid("outlines"));
    }
    Ok(Art::Vector {
        w: out_width,
        h: UNIT_HEIGHT,
        paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn pt(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    fn code<T>(result: Result<T, AppError>) -> ErrorCode {
        result
            .err()
            .map(|e| e.code())
            .unwrap_or(ErrorCode::Internal)
    }

    #[test]
    fn a_polygon_is_trimmed_scaled_and_simplified() {
        // 200 x 100 pad pixels at an offset, with a collinear point on the top edge.
        let polygon = vec![
            pt(50.0, 40.0),
            pt(100.0, 40.0),
            pt(250.0, 40.0),
            pt(250.0, 140.0),
            pt(50.0, 140.0),
        ];
        let Art::Vector { w, h, paths } = normalize(&[polygon]).unwrap() else {
            panic!("not vector")
        };
        assert_eq!(h, UNIT_HEIGHT);
        assert_eq!(w, 2000.0);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].len(), 4, "the collinear point is gone");
        assert!(paths[0]
            .iter()
            .all(|p| p.x >= 0.0 && p.y >= 0.0 && p.x <= w && p.y <= h));
    }

    #[test]
    fn nothing_drawn_or_bad_numbers_are_refused() {
        assert_eq!(code(normalize(&[])), ErrorCode::InvalidArgument);
        // Two points are no polygon; a flat one has no height.
        assert_eq!(
            code(normalize(&[vec![pt(0.0, 0.0), pt(5.0, 5.0)]])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(normalize(&[vec![pt(0.0, 1.0), pt(5.0, 1.0), pt(9.0, 1.0)]])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(normalize(&[vec![
                pt(f32::NAN, 0.0),
                pt(1.0, 0.0),
                pt(1.0, 1.0)
            ]])),
            ErrorCode::InvalidArgument
        );
        // Too wide a shape for a signature (aspect above 100).
        assert_eq!(
            code(normalize(&[vec![
                pt(0.0, 0.0),
                pt(10_000.0, 0.0),
                pt(0.0, 10.0)
            ]])),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn counts_are_limited() {
        let many = vec![vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(1.0, 1.0)]; MAX_POLYGONS + 1];
        assert_eq!(code(normalize(&many)), ErrorCode::LimitExceeded);
        let long: Vec<Point> = (0..=MAX_POINTS_PER_POLYGON)
            .map(|i| pt(i as f32, 0.0))
            .collect();
        assert_eq!(code(normalize(&[long])), ErrorCode::LimitExceeded);
    }
}
