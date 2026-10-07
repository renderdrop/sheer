import Foundation

public enum Geometry {
    /// Vision's normalized box (origin bottom left, y up, 0...1) to pixels of a `width` x `height` bitmap (origin top left, y down),
    /// clamped to the bitmap. `nil` for non-finite numbers or an empty box.
    public static func pixelBox(
        x: Double, y: Double, w: Double, h: Double, width: Int, height: Int
    ) -> (x: Double, y: Double, w: Double, h: Double)? {
        guard [x, y, w, h].allSatisfy({ $0.isFinite }) else { return nil }
        let wf = Double(width)
        let hf = Double(height)
        let x0 = min(max(x * wf, 0), wf)
        let x1 = min(max((x + w) * wf, 0), wf)
        let y0 = min(max((1 - y - h) * hf, 0), hf)
        let y1 = min(max((1 - y) * hf, 0), hf)
        guard x1 > x0, y1 > y0 else { return nil }
        return (x0, y0, x1 - x0, y1 - y0)
    }

    /// The whitespace-separated tokens of `text` with their ranges, in order. A token over the word limit is cut (its range stays whole).
    public static func tokens(in text: String) -> [(text: String, range: Range<String.Index>)] {
        var result: [(text: String, range: Range<String.Index>)] = []
        var start: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            if text[index].isWhitespace {
                if let begin = start {
                    result.append((String(text[begin..<index].prefix(Limits.maxWordChars)), begin..<index))
                    start = nil
                }
            } else if start == nil {
                start = index
            }
            index = text.index(after: index)
        }
        if let begin = start {
            result.append((String(text[begin..<text.endIndex].prefix(Limits.maxWordChars)), begin..<text.endIndex))
        }
        return result
    }
}
