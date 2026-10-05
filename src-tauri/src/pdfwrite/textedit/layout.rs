//! What the rest of the line does when a word changes its width: the runs that follow on the same line (up to the first big gap or
//! line change) move with the word, and the next run after them decides whether the new word has room.

use lopdf::content::Operation;
use lopdf::Object;

use super::scan::{Kind, Unit};

pub struct Line {
    /// Device length of one text-space unit at the word.
    pub scale: f64,
    /// Room (device units) between the end of the line chain and the next run on the same baseline, if there is one.
    pub slack: Option<f64>,
    /// Sites after the word that sit in a later operator and so need their positioning moved.
    pub moved_runs: usize,
    first_op: usize,
    last_op: usize,
    tm_ab: [f64; 2],
}

/// Looks at the glyphs after `glyphs[lo..hi]` of `unit`.
pub fn analyse(unit: &Unit, lo: usize, hi: usize) -> Line {
    let g = &unit.glyphs;
    let site = &unit.sites[g[lo].site];
    let first_op = g[lo..hi]
        .iter()
        .map(|x| unit.sites[x.site].op)
        .max()
        .unwrap_or(site.op);
    let mut end = g[hi - 1].p1;
    let mut last_op = first_op;
    let mut runs: Vec<usize> = Vec::new();
    let mut j = hi;
    while j < g.len() && g[j].kind != Kind::Break {
        if g[j].kind == Kind::Char {
            end = g[j].p1;
            let s = &unit.sites[g[j].site];
            last_op = last_op.max(s.op);
            if s.op > first_op && !runs.contains(&g[j].site) {
                runs.push(g[j].site);
            }
        }
        j += 1;
    }
    let scale = site.scale.max(1e-9);
    let slack = g[j.min(g.len())..]
        .iter()
        .find(|x| x.kind == Kind::Char)
        .and_then(|next| {
            let d = [next.p0[0] - end[0], next.p0[1] - end[1]];
            let along = d[0] * site.ddir[0] + d[1] * site.ddir[1];
            let across = (d[0] * site.ddir[1] - d[1] * site.ddir[0]).abs();
            (across < 0.3 * site.size.abs() * scale && along > -0.3 * site.size.abs() * scale)
                .then_some(along.max(0.0))
        });
    Line {
        scale,
        slack,
        moved_runs: runs.len(),
        first_op,
        last_op,
        tm_ab: site.tm_ab,
    }
}

fn number(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => f64::from(*r),
        _ => 0.0,
    }
}

fn add(op: &mut Operation, index: usize, by: f64) {
    if let Some(slot) = op.operands.get_mut(index) {
        *slot = Object::Real((number(slot) + by) as f32);
    }
}

/// Moves the positioning of the runs after the word by `delta` (text-space units of the word): the first `Td`/`TD` of the chain
/// (the others follow, they are relative) or every `Tm` (they are absolute), and gives the shift back at the first relative
/// positioning after the chain, so the following line starts where it did.
pub fn shift_following(ops: &mut Vec<Operation>, line: &Line, delta: f64) {
    let mut shifted = false;
    let end = line.last_op.min(ops.len().saturating_sub(1));
    for op in ops.iter_mut().take(end + 1).skip(line.first_op + 1) {
        match op.operator.as_str() {
            "Td" | "TD" if !shifted => {
                add(op, 0, delta);
                shifted = true;
            }
            "Tm" => {
                add(op, 4, delta * line.tm_ab[0]);
                add(op, 5, delta * line.tm_ab[1]);
                shifted = true;
            }
            _ => {}
        }
    }
    if !shifted {
        return;
    }
    let mut i = end + 1;
    while i < ops.len() {
        match ops[i].operator.as_str() {
            "Td" | "TD" => {
                add(&mut ops[i], 0, -delta);
                break;
            }
            "T*" | "'" | "\"" => {
                let back =
                    Operation::new("Td", vec![Object::Real((-delta) as f32), Object::Real(0.0)]);
                ops.insert(i, back);
                break;
            }
            "Tm" | "BT" => break,
            _ => i += 1,
        }
    }
}
