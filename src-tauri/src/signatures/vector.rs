//! Vector art from path commands (ADR-051, ADR-041 §6): what the pad draws (cubic Bézier outlines in pad pixels, made by the UI's
//! ink code) and what the typed signature lays out come here. The paths are validated, trimmed to their true extent (curve extrema,
//! not control points), scaled to [`UNIT_HEIGHT`] units high and rounded to a hundredth of a unit. Nothing is simplified: the curves
//! the user sees are the curves that are saved.

use std::fmt;

use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::Art;
use crate::error::AppError;
use crate::model::annotation::SIGNATURE_ASPECT_RANGE;

/// The height of normalized art, in units.
pub const UNIT_HEIGHT: f32 = 1_000.0;
/// Most paths (entries of `paths`; one per stroke or glyph) and most commands in all.
pub const MAX_PATHS: usize = 64;
pub const MAX_COMMANDS: usize = 20_000;
/// Art coordinates may lie this far outside the box (round caps and overshoot of curves).
pub const MARGIN: f32 = 100.0;
/// Input coordinates beyond this are not a pad's.
const MAX_INPUT_COORD: f32 = 1.0e5;

/// One path command (`PathCmd` in the TS API; not named so here: the security scan keeps `Path` out of command signatures). On the wire an array: `['M',x,y]`, `['L',x,y]`, `['C',x1,y1,x2,y2,x,y]` or `['Z']`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DrawCmd {
    M(f32, f32),
    L(f32, f32),
    C(f32, f32, f32, f32, f32, f32),
    Z,
}

impl DrawCmd {
    /// The coordinates as `(x, y)` pairs.
    pub fn points(&self) -> Vec<(f32, f32)> {
        match *self {
            Self::M(x, y) | Self::L(x, y) => vec![(x, y)],
            Self::C(a, b, c, d, x, y) => vec![(a, b), (c, d), (x, y)],
            Self::Z => Vec::new(),
        }
    }

    fn map(&self, f: impl Fn(f32, f32) -> (f32, f32)) -> Self {
        match *self {
            Self::M(x, y) => {
                let (x, y) = f(x, y);
                Self::M(x, y)
            }
            Self::L(x, y) => {
                let (x, y) = f(x, y);
                Self::L(x, y)
            }
            Self::C(a, b, c, d, x, y) => {
                let (a, b) = f(a, b);
                let (c, d) = f(c, d);
                let (x, y) = f(x, y);
                Self::C(a, b, c, d, x, y)
            }
            Self::Z => Self::Z,
        }
    }
}

impl Serialize for DrawCmd {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self {
            Self::M(x, y) => {
                let mut seq = serializer.serialize_seq(Some(3))?;
                seq.serialize_element("M")?;
                seq.serialize_element(&x)?;
                seq.serialize_element(&y)?;
                seq.end()
            }
            Self::L(x, y) => {
                let mut seq = serializer.serialize_seq(Some(3))?;
                seq.serialize_element("L")?;
                seq.serialize_element(&x)?;
                seq.serialize_element(&y)?;
                seq.end()
            }
            Self::C(a, b, c, d, x, y) => {
                let mut seq = serializer.serialize_seq(Some(7))?;
                seq.serialize_element("C")?;
                for value in [a, b, c, d, x, y] {
                    seq.serialize_element(&value)?;
                }
                seq.end()
            }
            Self::Z => {
                let mut seq = serializer.serialize_seq(Some(1))?;
                seq.serialize_element("Z")?;
                seq.end()
            }
        }
    }
}

struct CmdVisitor;

impl<'de> Visitor<'de> for CmdVisitor {
    type Value = DrawCmd;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a path command: [\"M\",x,y], [\"L\",x,y], [\"C\",x1,y1,x2,y2,x,y] or [\"Z\"]")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<DrawCmd, A::Error> {
        let letter: String = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let mut numbers = [0.0f32; 6];
        let wanted = match letter.as_str() {
            "M" | "L" => 2,
            "C" => 6,
            "Z" => 0,
            _ => return Err(de::Error::custom("unknown path command")),
        };
        for (index, slot) in numbers.iter_mut().take(wanted).enumerate() {
            *slot = seq
                .next_element()?
                .ok_or_else(|| de::Error::invalid_length(index + 1, &self))?;
        }
        if seq.next_element::<de::IgnoredAny>()?.is_some() {
            return Err(de::Error::custom("too many numbers in a path command"));
        }
        let [a, b, c, d, e, f] = numbers;
        Ok(match letter.as_str() {
            "M" => DrawCmd::M(a, b),
            "L" => DrawCmd::L(a, b),
            "C" => DrawCmd::C(a, b, c, d, e, f),
            _ => DrawCmd::Z,
        })
    }
}

impl<'de> Deserialize<'de> for DrawCmd {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_seq(CmdVisitor)
    }
}

/// Legacy art (before 0.8.1) was filled polygons: they become `M`, `L`... `Z` paths. A polygon is one entry; if there are more than
/// [`MAX_PATHS`] they are grouped (one `f` fills them all anyway, so the picture does not change).
pub fn from_polygons(polygons: &[Vec<[f32; 2]>]) -> Vec<Vec<DrawCmd>> {
    let group = polygons.len().div_ceil(MAX_PATHS).max(1);
    polygons
        .chunks(group)
        .map(|chunk| {
            let mut path = Vec::new();
            for polygon in chunk {
                for (index, [x, y]) in polygon.iter().enumerate() {
                    path.push(if index == 0 {
                        DrawCmd::M(*x, *y)
                    } else {
                        DrawCmd::L(*x, *y)
                    });
                }
                path.push(DrawCmd::Z);
            }
            path
        })
        .collect()
}

/// Structure and counts shared by input and art: every path starts with `M`, `L`/`C` only follow a start, nothing is empty.
/// `limit_exceeded` for too many paths or commands, `invalid_argument` (`field`) for the rest.
fn check_structure(
    paths: &[Vec<DrawCmd>],
    field: &'static str,
    limit_counts: bool,
) -> Result<(), AppError> {
    if limit_counts && paths.len() > MAX_PATHS {
        return Err(AppError::limit(field, MAX_PATHS as u64));
    }
    let mut total = 0usize;
    for path in paths {
        total += path.len();
        if limit_counts && total > MAX_COMMANDS {
            return Err(AppError::limit("commands", MAX_COMMANDS as u64));
        }
        if !matches!(path.first(), Some(DrawCmd::M(..))) {
            return Err(AppError::invalid(field));
        }
    }
    Ok(())
}

/// Checks art as it is held: counts, structure, finite coordinates within the box plus [`MARGIN`]. Used for art from the library.
pub fn validate_art(w: f32, h: f32, paths: &[Vec<DrawCmd>]) -> Result<(), AppError> {
    let bad = || AppError::invalid("art");
    if paths.is_empty() || !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return Err(bad());
    }
    check_structure(paths, "art", true)?;
    let in_box = |(x, y): (f32, f32)| {
        x.is_finite()
            && y.is_finite()
            && (-MARGIN..=w + MARGIN).contains(&x)
            && (-MARGIN..=h + MARGIN).contains(&y)
    };
    if paths
        .iter()
        .flatten()
        .all(|cmd| cmd.points().into_iter().all(in_box))
    {
        Ok(())
    } else {
        Err(bad())
    }
}

fn quantize(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

/// Extend `(min, max)` by the interior extrema of the cubic `p0..p3` along one axis.
fn cubic_extrema(p: [f32; 4], range: &mut (f32, f32)) {
    let (d0, d1, d2) = (p[1] - p[0], p[2] - p[1], p[3] - p[2]);
    let (a, b, c) = (d0 - 2.0 * d1 + d2, 2.0 * (d1 - d0), d0);
    let mut roots = [f32::NAN; 2];
    if a.abs() < 1.0e-9 {
        if b.abs() > 1.0e-9 {
            roots[0] = -c / b;
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc >= 0.0 {
            let root = disc.sqrt();
            roots = [(-b + root) / (2.0 * a), (-b - root) / (2.0 * a)];
        }
    }
    for t in roots {
        if t > 0.0 && t < 1.0 {
            let u = 1.0 - t;
            let value = u * u * u * p[0]
                + 3.0 * u * u * t * p[1]
                + 3.0 * u * t * t * p[2]
                + t * t * t * p[3];
            range.0 = range.0.min(value);
            range.1 = range.1.max(value);
        }
    }
}

/// The box of what the paths draw: `(min_x, min_y, max_x, max_y)`, curves by their extrema.
fn extent(paths: &[Vec<DrawCmd>]) -> Option<(f32, f32, f32, f32)> {
    let mut xs = (f32::MAX, f32::MIN);
    let mut ys = (f32::MAX, f32::MIN);
    let mut any = false;
    for path in paths {
        let mut at = (0.0f32, 0.0f32);
        for cmd in path {
            match *cmd {
                DrawCmd::M(x, y) | DrawCmd::L(x, y) => {
                    at = (x, y);
                    if !matches!(cmd, DrawCmd::M(..)) {
                        any = true;
                    }
                    xs = (xs.0.min(x), xs.1.max(x));
                    ys = (ys.0.min(y), ys.1.max(y));
                }
                DrawCmd::C(a, b, c, d, x, y) => {
                    any = true;
                    xs = (xs.0.min(x), xs.1.max(x));
                    ys = (ys.0.min(y), ys.1.max(y));
                    cubic_extrema([at.0, a, c, x], &mut xs);
                    cubic_extrema([at.1, b, d, y], &mut ys);
                    at = (x, y);
                }
                DrawCmd::Z => {}
            }
        }
    }
    any.then_some((xs.0, ys.0, xs.1, ys.1))
}

/// Normalizes drawn `paths` (pad pixels) into vector art. `invalid_argument` (`outlines`) for nothing drawn, a number that is not
/// finite or is beyond reach, a path that does not start with `M`, or a shape whose width over height is outside the aspect range of
/// a signature; `limit_exceeded` for more than [`MAX_PATHS`] paths or [`MAX_COMMANDS`] commands.
pub fn normalize(paths: &[Vec<DrawCmd>]) -> Result<Art, AppError> {
    normalize_with(paths, true)
}

/// [`normalize`] for paths Rust made itself (the typed signature); the result is held to the same limits.
pub(super) fn normalize_trusted(paths: &[Vec<DrawCmd>]) -> Result<Art, AppError> {
    normalize_with(paths, false)
}

fn normalize_with(paths: &[Vec<DrawCmd>], limit_input: bool) -> Result<Art, AppError> {
    check_structure(paths, "outlines", limit_input)?;
    let finite = paths.iter().flatten().all(|cmd| {
        cmd.points().into_iter().all(|(x, y)| {
            x.is_finite()
                && y.is_finite()
                && x.abs() <= MAX_INPUT_COORD
                && y.abs() <= MAX_INPUT_COORD
        })
    });
    if !finite {
        return Err(AppError::invalid("outlines"));
    }
    let Some((min_x, min_y, max_x, max_y)) = extent(paths) else {
        return Err(AppError::invalid("outlines"));
    };
    let (width, height) = (max_x - min_x, max_y - min_y);
    if width < 1.0e-3 || height < 1.0e-3 {
        return Err(AppError::invalid("outlines"));
    }
    let scale = UNIT_HEIGHT / height;
    let out_width = quantize(width * scale);
    if !SIGNATURE_ASPECT_RANGE.contains(&(out_width / UNIT_HEIGHT)) {
        return Err(AppError::invalid("outlines"));
    }
    let place = |x: f32, y: f32| (quantize((x - min_x) * scale), quantize((y - min_y) * scale));
    let out: Vec<Vec<DrawCmd>> = paths
        .iter()
        .map(|path| path.iter().map(|cmd| cmd.map(place)).collect())
        .collect();
    validate_art(out_width, UNIT_HEIGHT, &out)?;
    Ok(Art::Vector {
        w: out_width,
        h: UNIT_HEIGHT,
        paths: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use DrawCmd::{C, L, M, Z};

    fn code<T>(result: Result<T, AppError>) -> ErrorCode {
        result
            .err()
            .map(|e| e.code())
            .unwrap_or(ErrorCode::Internal)
    }

    #[test]
    fn a_path_is_trimmed_and_scaled_without_losing_a_command() {
        // 200 x 100 pad pixels at an offset, one curved side.
        let path = vec![
            M(50.0, 40.0),
            L(100.0, 40.0),
            C(150.0, 40.0, 250.0, 90.0, 250.0, 140.0),
            L(50.0, 140.0),
            Z,
        ];
        let Art::Vector { w, h, paths } = normalize(std::slice::from_ref(&path)).unwrap() else {
            panic!("not vector")
        };
        assert_eq!(h, UNIT_HEIGHT);
        assert_eq!(w, 2000.0);
        assert_eq!(paths[0].len(), path.len(), "no simplification");
        assert_eq!(paths[0][0], M(0.0, 0.0));
        assert_eq!(paths[0][2], C(1000.0, 0.0, 2000.0, 500.0, 2000.0, 1000.0));
    }

    #[test]
    fn the_extent_follows_the_curve_not_its_control_points() {
        // The extremum of the cubic (0,0)-(0,-400)-(100,-400)-(100,0) is at y = -300, not at its control points.
        let path = vec![M(0.0, 0.0), C(0.0, -400.0, 100.0, -400.0, 100.0, 0.0), Z];
        let (_, min_y, _, max_y) = extent(&[path]).unwrap();
        assert!((min_y + 300.0).abs() < 0.01, "{min_y}");
        assert!(max_y.abs() < 0.01);
    }

    #[test]
    fn nothing_drawn_or_bad_numbers_are_refused() {
        assert_eq!(code(normalize(&[])), ErrorCode::InvalidArgument);
        // A path with only a start draws nothing; a flat one has no height.
        assert_eq!(
            code(normalize(&[vec![M(0.0, 0.0)]])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(normalize(&[vec![M(0.0, 1.0), L(5.0, 1.0), L(9.0, 1.0), Z]])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(normalize(&[vec![
                M(f32::NAN, 0.0),
                L(1.0, 0.0),
                L(1.0, 1.0),
                Z
            ]])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(normalize(&[vec![
                M(0.0, 0.0),
                L(1.0e9, 0.0),
                L(1.0, 1.0),
                Z
            ]])),
            ErrorCode::InvalidArgument
        );
        // A path that does not start with M.
        assert_eq!(
            code(normalize(&[vec![L(0.0, 0.0), L(1.0, 0.0), L(1.0, 1.0), Z]])),
            ErrorCode::InvalidArgument
        );
        // Too wide a shape for a signature (aspect above 100).
        assert_eq!(
            code(normalize(&[vec![
                M(0.0, 0.0),
                L(10_000.0, 0.0),
                L(0.0, 10.0),
                Z
            ]])),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn counts_are_limited() {
        let one = vec![M(0.0, 0.0), L(1.0, 0.0), L(1.0, 1.0), Z];
        let many = vec![one; MAX_PATHS + 1];
        assert_eq!(code(normalize(&many)), ErrorCode::LimitExceeded);
        let mut long = vec![M(0.0, 0.0)];
        long.extend((0..=MAX_COMMANDS).map(|i| L(i as f32 % 7.0, 1.0)));
        assert_eq!(code(normalize(&[long])), ErrorCode::LimitExceeded);
    }

    #[test]
    fn commands_are_arrays_on_the_wire_and_nothing_else_is_read() {
        let paths = vec![vec![
            M(1.0, 2.0),
            L(3.0, 4.0),
            C(1.0, 2.0, 3.0, 4.0, 5.0, 6.0),
            Z,
        ]];
        let json = serde_json::to_string(&paths).unwrap();
        assert_eq!(
            json,
            r#"[[["M",1.0,2.0],["L",3.0,4.0],["C",1.0,2.0,3.0,4.0,5.0,6.0],["Z"]]]"#
        );
        let back: Vec<Vec<DrawCmd>> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, paths);
        for bad in [
            r#"[["X",1,2]]"#,
            r#"[["M",1]]"#,
            r#"[["M",1,2,3]]"#,
            r#"[["Z",1]]"#,
            r#"[[1,2]]"#,
            r#"[["C",1,2,3,4,5]]"#,
            r#"[[]]"#,
        ] {
            assert!(serde_json::from_str::<Vec<DrawCmd>>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn legacy_polygons_become_closed_line_paths_and_stay_within_the_path_limit() {
        let polygon = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let one = from_polygons(std::slice::from_ref(&polygon));
        assert_eq!(one, vec![vec![M(0.0, 0.0), L(10.0, 0.0), L(10.0, 10.0), Z]]);
        let many = from_polygons(&vec![polygon; 200]);
        assert!(many.len() <= MAX_PATHS);
        assert_eq!(many.iter().flatten().filter(|c| **c == Z).count(), 200);
    }
}
