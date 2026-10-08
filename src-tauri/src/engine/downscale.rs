//! Area-averaging (box) downscale for small renders (F17.9). PDFium drawn straight at thumbnail size turns bold text and headings into
//! near-solid blocks; drawn at a multiple of the size and averaged down, the same strokes come out as the grey they cover.
//!
//! Pure Rust, no PDFium types. Every destination pixel is the exact mean of the source area it covers, with fractional weights at the
//! edges, so any ratio works (odd sizes included). With four channels the last one is alpha and the colour is weighted by it.

/// Largest side, in pixels, of a render that gets supersampled; bigger renders (a page view) are drawn directly.
pub const SUPERSAMPLE_MAX_SIDE_PX: u32 = 320;
/// How many times larger than its target a small render is drawn.
pub const SUPERSAMPLE_FACTOR: u32 = 3;
// The supersampled bitmap stays inside the render limits (checked at compile time).
const _: () = assert!(
    SUPERSAMPLE_MAX_SIDE_PX * SUPERSAMPLE_FACTOR <= crate::limits::MAX_RENDER_SIDE_PX
        && (SUPERSAMPLE_MAX_SIDE_PX as u64 * SUPERSAMPLE_FACTOR as u64).pow(2)
            <= crate::limits::MAX_RENDER_PIXELS
);

/// For each destination index, the first source index and the weights of the source pixels it covers (they sum to 1).
fn contributions(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
    let ratio = src as f64 / dst as f64;
    (0..dst)
        .map(|index| {
            let from = index as f64 * ratio;
            let to = ((index + 1) as f64 * ratio).min(src as f64);
            let first = (from.floor() as usize).min(src - 1);
            let last = (to.ceil() as usize).clamp(first + 1, src);
            let mut weights: Vec<f32> = (first..last)
                .map(|at| {
                    let lo = from.max(at as f64);
                    let hi = to.min((at + 1) as f64);
                    (hi - lo).max(0.0) as f32
                })
                .collect();
            let sum: f32 = weights.iter().sum();
            if sum > 0.0 {
                for weight in &mut weights {
                    *weight /= sum;
                }
            } else {
                weights = vec![1.0];
            }
            (first, weights)
        })
        .collect()
}

/// Shrinks `src` (`src_w` x `src_h`, `channels` 1 to 4 bytes per pixel, rows `stride` bytes apart) to `dst_w` x `dst_h` by averaging.
/// Returns tightly packed rows, or `None` for a layout that does not fit (zero size, a destination larger than the source, short data).
pub fn box_downscale(
    src: &[u8],
    (src_w, src_h): (usize, usize),
    stride: usize,
    channels: usize,
    (dst_w, dst_h): (usize, usize),
) -> Option<Vec<u8>> {
    let row_len = src_w.checked_mul(channels)?;
    let needed = stride.checked_mul(src_h)?;
    if !(1..=4).contains(&channels)
        || src_w == 0
        || src_h == 0
        || dst_w == 0
        || dst_h == 0
        || dst_w > src_w
        || dst_h > src_h
        || stride < row_len
        || src.len() < needed.checked_sub(stride - row_len)?
    {
        return None;
    }
    let alpha = channels == 4;
    let xs = contributions(src_w, dst_w);
    let ys = contributions(src_h, dst_h);

    // Horizontal pass into f32 rows; with alpha the colour is premultiplied so that transparent pixels do not tint the mean.
    let mut middle = vec![0f32; dst_w * src_h * channels];
    for row in 0..src_h {
        let line = &src[row * stride..row * stride + row_len];
        for (x, (first, weights)) in xs.iter().enumerate() {
            let out = &mut middle[(row * dst_w + x) * channels..][..channels];
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = &line[(first + offset) * channels..][..channels];
                let a = if alpha {
                    f32::from(pixel[3]) / 255.0
                } else {
                    1.0
                };
                for channel in 0..channels {
                    let value = f32::from(pixel[channel]);
                    out[channel] += weight
                        * if alpha && channel < 3 {
                            value * a
                        } else {
                            value
                        };
                }
            }
        }
    }

    let mut out = vec![0u8; dst_w * dst_h * channels];
    for (y, (first, weights)) in ys.iter().enumerate() {
        for x in 0..dst_w {
            let mut sum = [0f32; 4];
            for (offset, weight) in weights.iter().enumerate() {
                let at = ((first + offset) * dst_w + x) * channels;
                for channel in 0..channels {
                    sum[channel] += weight * middle[at + channel];
                }
            }
            let target = &mut out[(y * dst_w + x) * channels..][..channels];
            if alpha {
                let a = sum[3] / 255.0;
                for channel in 0..3 {
                    target[channel] = if a > 0.0 { to_u8(sum[channel] / a) } else { 0 };
                }
                target[3] = to_u8(sum[3]);
            } else {
                for channel in 0..channels {
                    target[channel] = to_u8(sum[channel]);
                }
            }
        }
    }
    Some(out)
}

fn to_u8(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_by_two_blocks_are_averaged_exactly() {
        // 4 x 2 grey: [0 100 | 200 40] over [100 200 | 0 40] -> blocks (0+100+100+200)/4 = 100 and (200+40+0+40)/4 = 70.
        let src = [0, 100, 200, 40, 100, 200, 0, 40];
        let out = box_downscale(&src, (4, 2), 4, 1, (2, 1)).unwrap();
        assert_eq!(out, vec![100, 70]);
    }

    #[test]
    fn a_checkerboard_becomes_mid_grey_and_a_flat_colour_stays() {
        let board: Vec<u8> = (0..36)
            .map(|i| if (i % 6 + i / 6) % 2 == 0 { 0 } else { 255 })
            .collect();
        let out = box_downscale(&board, (6, 6), 6, 1, (2, 2)).unwrap();
        // 3 x 3 blocks hold 4 or 5 whites: 255 * 4/9 and 255 * 5/9.
        assert!(out.iter().all(|v| (113..=142).contains(v)), "{out:?}");
        let flat = vec![77u8; 7 * 5 * 3];
        let out = box_downscale(&flat, (7, 5), 21, 3, (3, 2)).unwrap();
        assert!(out.iter().all(|v| *v == 77));
    }

    #[test]
    fn odd_sizes_use_fractional_weights_and_keep_the_total() {
        // 3 -> 2: the middle pixel is shared half and half. Mean of [0, 90, 180]: (0 + 45) / 1.5 = 30 and (45 + 180) / 1.5 = 150.
        let out = box_downscale(&[0, 90, 180], (3, 1), 3, 1, (2, 1)).unwrap();
        assert_eq!(out, vec![30, 150]);
        // The mean is kept for 5 -> 3 as well (within rounding).
        let src = [10u8, 20, 30, 40, 50];
        let out = box_downscale(&src, (5, 1), 5, 1, (3, 1)).unwrap();
        let mean: f32 = out.iter().map(|v| f32::from(*v)).sum::<f32>() / 3.0;
        assert!((mean - 30.0).abs() <= 1.0, "{out:?}");
    }

    #[test]
    fn stride_padding_is_ignored() {
        let src = [10, 30, 99, 99, 50, 70, 99, 99];
        let out = box_downscale(&src, (2, 2), 4, 1, (1, 1)).unwrap();
        assert_eq!(out, vec![40]);
    }

    #[test]
    fn colour_is_weighted_by_alpha() {
        // One opaque red and one fully transparent (black) pixel: the mean is half-transparent red, not dark red.
        let src = [255, 0, 0, 255, 0, 0, 0, 0];
        let out = box_downscale(&src, (2, 1), 8, 4, (1, 1)).unwrap();
        assert_eq!(out, vec![255, 0, 0, 128]);
    }

    #[test]
    fn bad_layouts_are_refused() {
        assert!(box_downscale(&[0; 4], (2, 2), 2, 1, (3, 1)).is_none());
        assert!(box_downscale(&[0; 4], (2, 2), 2, 1, (0, 1)).is_none());
        assert!(box_downscale(&[0; 3], (2, 2), 2, 1, (1, 1)).is_none());
        assert!(box_downscale(&[0; 4], (2, 2), 2, 5, (1, 1)).is_none());
    }
}
