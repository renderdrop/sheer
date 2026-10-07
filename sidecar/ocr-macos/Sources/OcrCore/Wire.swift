import Foundation

/// The bounds of the pipe; they mirror src-tauri/src/ocr/limits.rs and must change together with it.
public enum Limits {
    public static let maxSidePx = 8000
    public static let maxPixels = 40_000_000
    public static let maxRequestHeader = 4096
    public static let maxWordChars = 128
    public static let languages: Set<String> = ["de-DE", "en-US"]
}

/// `{ v, id, w, h, stride, format, lang }` of the parent.
public struct OcrRequest: Codable, Equatable {
    public var v: Int
    public var id: UInt64
    public var w: Int
    public var h: Int
    public var stride: Int
    public var format: String
    public var lang: [String]

    public init(v: Int, id: UInt64, w: Int, h: Int, stride: Int, format: String, lang: [String]) {
        self.v = v
        self.id = id
        self.w = w
        self.h = h
        self.stride = stride
        self.format = format
        self.lang = lang
    }
}

public struct RawWord: Codable, Equatable {
    public var t: String
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(t: String, x: Double, y: Double, w: Double, h: Double) {
        self.t = t
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

public struct RawLine: Codable, Equatable {
    public var words: [RawWord]

    public init(words: [RawWord]) {
        self.words = words
    }
}

/// `{ id, ok, angle, lines, error }`; `error` is a short code, never text of the page.
public struct OcrReply: Codable, Equatable {
    public var id: UInt64
    public var ok: Bool
    public var angle: Double
    public var lines: [RawLine]
    public var error: String?

    public init(id: UInt64, ok: Bool, angle: Double = 0, lines: [RawLine] = [], error: String? = nil) {
        self.id = id
        self.ok = ok
        self.angle = angle
        self.lines = lines
        self.error = error
    }

    public static func failure(id: UInt64, code: String) -> OcrReply {
        OcrReply(id: id, ok: false, error: code)
    }
}

/// Why a message was refused; the code goes into the error reply.
public enum WireError: Error, Equatable {
    case truncated
    case headerLength(UInt32)
    case header
    case invalid(String)

    public var code: String {
        switch self {
        case .truncated: return "truncated"
        case .headerLength: return "header_length"
        case .header: return "header"
        case .invalid: return "invalid_request"
        }
    }
}

/// A source of bytes; `read` returns fewer bytes than asked only at the end of the stream.
public protocol ByteReader {
    mutating func read(_ count: Int) -> Data
}

public protocol ByteWriter {
    mutating func write(_ data: Data) -> Bool
}

public enum Wire {
    /// The header length of a message (4 bytes, little endian), checked against `cap` before anything is allocated.
    public static func headerLength(_ bytes: Data, cap: Int) throws -> Int {
        let b = [UInt8](bytes)
        guard b.count == 4 else { throw WireError.truncated }
        let length = UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24
        if length == 0 || Int(length) > cap {
            throw WireError.headerLength(length)
        }
        return Int(length)
    }

    /// Checks the fields of a request against the bounds; returns the number of blob bytes that follow it.
    public static func validate(_ r: OcrRequest) throws -> Int {
        if r.v != 1 { throw WireError.invalid("version") }
        if r.format != "gray8" { throw WireError.invalid("format") }
        if r.w <= 0 || r.h <= 0 || r.w > Limits.maxSidePx || r.h > Limits.maxSidePx {
            throw WireError.invalid("size")
        }
        if r.w * r.h > Limits.maxPixels { throw WireError.invalid("pixels") }
        if r.stride != r.w { throw WireError.invalid("stride") }
        if r.lang.isEmpty || r.lang.count > 2 || r.lang.contains(where: { !Limits.languages.contains($0) }) {
            throw WireError.invalid("language")
        }
        return r.w * r.h
    }

    /// Reads one request and its bitmap. `nil` at a clean end of the stream before the first byte.
    public static func readRequest<R: ByteReader>(_ input: inout R) throws -> (OcrRequest, Data)? {
        let prefix = input.read(4)
        if prefix.isEmpty { return nil }
        if prefix.count < 4 { throw WireError.truncated }
        let length = try headerLength(prefix, cap: Limits.maxRequestHeader)
        let json = input.read(length)
        if json.count < length { throw WireError.truncated }
        guard let request = try? JSONDecoder().decode(OcrRequest.self, from: json) else {
            throw WireError.header
        }
        let blobSize = try validate(request)
        let blob = input.read(blobSize)
        if blob.count < blobSize { throw WireError.truncated }
        return (request, blob)
    }

    /// A reply as bytes: length prefix, JSON.
    public static func frame(_ reply: OcrReply) -> Data {
        // Never fails for this type; an empty body would be refused by the parent as a bad header.
        let json = (try? JSONEncoder().encode(reply)) ?? Data()
        let length = UInt32(json.count)
        var out = Data([
            UInt8(length & 0xFF), UInt8((length >> 8) & 0xFF), UInt8((length >> 16) & 0xFF), UInt8((length >> 24) & 0xFF),
        ])
        out.append(json)
        return out
    }
}

/// Recognizes one bitmap; failures are replies with `ok == false`.
public typealias RecognizeFunction = (OcrRequest, Data) -> OcrReply

/// The loop: answers each request, returns the exit code (0 at the end of the stream, 1 when the output breaks, 2 for a message
/// that breaks the framing; the bitmap of such a message cannot be skipped).
public func serve<R: ByteReader, W: ByteWriter>(
    input: inout R,
    output: inout W,
    recognize: RecognizeFunction
) -> Int32 {
    while true {
        do {
            guard let (request, pixels) = try Wire.readRequest(&input) else { return 0 }
            let reply = recognize(request, pixels)
            if !output.write(Wire.frame(reply)) { return 1 }
        } catch let error as WireError {
            _ = output.write(Wire.frame(.failure(id: 0, code: error.code)))
            return 2
        } catch {
            _ = output.write(Wire.frame(.failure(id: 0, code: "io")))
            return 2
        }
    }
}
