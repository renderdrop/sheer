import CoreGraphics
import Foundation
import Vision

/// The Vision side (ADR-134 item 1): `VNRecognizeTextRequest` `.accurate`, language correction on, the requested language only.
public enum VisionRecognizer {
    /// A gray8 buffer (`stride` bytes per row) as a CGImage; `nil` when the buffer does not fit the size.
    public static func image(gray: Data, width: Int, height: Int, stride: Int) -> CGImage? {
        guard width > 0, height > 0, stride >= width, gray.count >= stride * (height - 1) + width else { return nil }
        guard let provider = CGDataProvider(data: gray as CFData) else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 8,
            bytesPerRow: stride,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    /// Whether `tag` is among the languages Vision lists (compared case-insensitively).
    public static func supports(_ tag: String, among supported: [String]) -> Bool {
        let wanted = tag.lowercased()
        return supported.contains { $0.lowercased() == wanted }
    }

    /// Recognizes one request. An unsupported language is an error reply (the parent's blank-bitmap probe reads it as unavailable).
    public static func recognize(_ request: OcrRequest, _ pixels: Data) -> OcrReply {
        guard let tag = request.lang.first else { return .failure(id: request.id, code: "language_unavailable") }
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.usesLanguageCorrection = true
        guard let supported = try? text.supportedRecognitionLanguages(), supports(tag, among: supported) else {
            return .failure(id: request.id, code: "language_unavailable")
        }
        text.recognitionLanguages = [tag]
        guard let cgImage = image(gray: pixels, width: request.w, height: request.h, stride: request.stride) else {
            return .failure(id: request.id, code: "bad_bitmap")
        }
        do {
            try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([text])
        } catch {
            return .failure(id: request.id, code: "vision_failed")
        }
        var lines: [RawLine] = []
        for observation in text.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            var words: [RawWord] = []
            for token in Geometry.tokens(in: candidate.string) {
                guard let observed = try? candidate.boundingBox(for: token.range) else { continue }
                let box = observed.boundingBox
                guard let px = Geometry.pixelBox(
                    x: Double(box.origin.x), y: Double(box.origin.y),
                    w: Double(box.size.width), h: Double(box.size.height),
                    width: request.w, height: request.h
                ) else { continue }
                words.append(RawWord(t: token.text, x: px.x, y: px.y, w: px.w, h: px.h))
            }
            if !words.isEmpty { lines.append(RawLine(words: words)) }
        }
        return OcrReply(id: request.id, ok: true, angle: 0, lines: lines)
    }
}

/// stdin as a ByteReader.
struct StdinReader: ByteReader {
    mutating func read(_ count: Int) -> Data {
        var data = Data()
        while data.count < count {
            let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        return data
    }
}

/// stdout as a ByteWriter.
struct StdoutWriter: ByteWriter {
    mutating func write(_ data: Data) -> Bool {
        // The throwing variant: a closed pipe (parent gone) ends the loop instead of raising an Objective-C exception.
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }
}

/// The entry point of the executable: the exit code.
public func runSidecar() -> Int32 {
    var input = StdinReader()
    var output = StdoutWriter()
    return serve(input: &input, output: &output, recognize: VisionRecognizer.recognize)
}
