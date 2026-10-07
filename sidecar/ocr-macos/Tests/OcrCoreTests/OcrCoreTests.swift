import XCTest
@testable import OcrCore

struct MemoryReader: ByteReader {
    var data: Data
    mutating func read(_ count: Int) -> Data {
        let n = min(count, data.count)
        let out = Data(data.prefix(n))
        data = Data(data.dropFirst(n))
        return out
    }
}

struct MemoryWriter: ByteWriter {
    var data = Data()
    mutating func write(_ more: Data) -> Bool {
        data.append(more)
        return true
    }
}

func lengthPrefix(_ length: UInt32) -> Data {
    Data([UInt8(length & 0xFF), UInt8((length >> 8) & 0xFF), UInt8((length >> 16) & 0xFF), UInt8((length >> 24) & 0xFF)])
}

func message(_ request: OcrRequest, blob: Int) -> Data {
    let json = (try? JSONEncoder().encode(request)) ?? Data()
    var out = lengthPrefix(UInt32(json.count))
    out.append(json)
    out.append(Data(count: blob))
    return out
}

func request(w: Int = 4, h: Int = 3) -> OcrRequest {
    OcrRequest(v: 1, id: 7, w: w, h: h, stride: w, format: "gray8", lang: ["en-US"])
}

/// The replies in `data`: the JSON of each framed message.
func replies(_ data: Data) -> [OcrReply] {
    var rest = [UInt8](data)
    var result: [OcrReply] = []
    while rest.count >= 4 {
        let n = Int(UInt32(rest[0]) | UInt32(rest[1]) << 8 | UInt32(rest[2]) << 16 | UInt32(rest[3]) << 24)
        let body = Data(rest[4..<(4 + n)])
        if let reply = try? JSONDecoder().decode(OcrReply.self, from: body) { result.append(reply) }
        rest = Array(rest[(4 + n)...])
    }
    return result
}

final class GeometryTests: XCTestCase {
    func testBottomLeftNormalizedBecomesTopLeftPixels() throws {
        // A box in the lower left quarter of a 200 x 100 image.
        let box = try XCTUnwrap(Geometry.pixelBox(x: 0, y: 0, w: 0.5, h: 0.5, width: 200, height: 100))
        XCTAssertEqual(box.x, 0, accuracy: 1e-9)
        XCTAssertEqual(box.y, 50, accuracy: 1e-9)
        XCTAssertEqual(box.w, 100, accuracy: 1e-9)
        XCTAssertEqual(box.h, 50, accuracy: 1e-9)
        // Top of the page: y + h = 1 gives pixel y 0.
        let top = try XCTUnwrap(Geometry.pixelBox(x: 0.25, y: 0.9, w: 0.5, h: 0.1, width: 200, height: 100))
        XCTAssertEqual(top.y, 0, accuracy: 1e-9)
        XCTAssertEqual(top.h, 10, accuracy: 1e-9)
    }

    func testBoxesAreClampedAndBadNumbersRefused() throws {
        let wide = try XCTUnwrap(Geometry.pixelBox(x: 0.9, y: 0, w: 0.5, h: 1, width: 100, height: 100))
        XCTAssertEqual(wide.x, 90, accuracy: 1e-9)
        XCTAssertEqual(wide.w, 10, accuracy: 1e-9)
        XCTAssertNil(Geometry.pixelBox(x: .nan, y: 0, w: 1, h: 1, width: 10, height: 10))
        XCTAssertNil(Geometry.pixelBox(x: 2, y: 0, w: 1, h: 1, width: 10, height: 10))
        XCTAssertNil(Geometry.pixelBox(x: 0, y: 0, w: 0, h: 1, width: 10, height: 10))
    }

    func testTokensSplitOnAnyWhitespace() {
        let text = "  Hallo  Welt\tnoch\u{00A0}eins \n"
        let tokens = Geometry.tokens(in: text).map { $0.text }
        XCTAssertEqual(tokens, ["Hallo", "Welt", "noch", "eins"])
        XCTAssertEqual(Geometry.tokens(in: "   ").count, 0)
        let source = "ab cd"
        let second = Geometry.tokens(in: source)[1]
        XCTAssertEqual(String(source[second.range]), "cd")
    }

    func testLongTokensAreCut() {
        let long = String(repeating: "a", count: 500)
        XCTAssertEqual(Geometry.tokens(in: long)[0].text.count, Limits.maxWordChars)
    }

    func testRecognitionLanguageMatchIgnoresCase() {
        XCTAssertTrue(VisionRecognizer.supports("de-DE", among: ["en-US", "de-de"]))
        XCTAssertFalse(VisionRecognizer.supports("en-US", among: ["de-DE"]))
    }

    func testGrayBufferBecomesAnImageWithStride() {
        let gray = Data(repeating: 128, count: 5 * 3)
        let image = VisionRecognizer.image(gray: gray, width: 5, height: 3, stride: 5)
        XCTAssertEqual(image?.width, 5)
        XCTAssertEqual(image?.height, 3)
        XCTAssertNil(VisionRecognizer.image(gray: Data(count: 4), width: 5, height: 3, stride: 5))
    }
}

final class WireTests: XCTestCase {
    func testARequestRoundTripsWithItsBitmap() throws {
        var input = MemoryReader(data: message(request(), blob: 12))
        let first = try Wire.readRequest(&input)
        let (got, blob) = try XCTUnwrap(first)
        XCTAssertEqual(got, request())
        XCTAssertEqual(blob.count, 12)
        XCTAssertNil(try Wire.readRequest(&input))
    }

    func testCutMessagesAreTruncated() {
        var cut = MemoryReader(data: Data([9, 0]))
        XCTAssertThrowsError(try Wire.readRequest(&cut)) { XCTAssertEqual($0 as? WireError, .truncated) }
        var short = MemoryReader(data: message(request(), blob: 5))
        XCTAssertThrowsError(try Wire.readRequest(&short)) { XCTAssertEqual($0 as? WireError, .truncated) }
    }

    func testHeaderLengthsAreBoundedBeforeAllocation() {
        for length in [UInt32(0), 4097, UInt32.max] {
            var input = MemoryReader(data: lengthPrefix(length))
            XCTAssertThrowsError(try Wire.readRequest(&input)) {
                XCTAssertEqual($0 as? WireError, .headerLength(length))
            }
        }
    }

    func testRequestsOutsideTheBoundsAreRefused() throws {
        XCTAssertEqual(try Wire.validate(request(w: 100, h: 100)), 10_000)
        var bad = request(w: 100, h: 100)
        bad.w = Limits.maxSidePx + 1
        bad.stride = bad.w
        XCTAssertThrowsError(try Wire.validate(bad))
        bad = request(w: 8000, h: 8000)
        XCTAssertThrowsError(try Wire.validate(bad))
        bad = request()
        bad.stride = 5
        XCTAssertThrowsError(try Wire.validate(bad))
        bad = request()
        bad.format = "bgra8"
        XCTAssertThrowsError(try Wire.validate(bad))
        bad = request()
        bad.lang = ["../x"]
        XCTAssertThrowsError(try Wire.validate(bad))
        bad = request()
        bad.lang = []
        XCTAssertThrowsError(try Wire.validate(bad))
    }

    func testReplyFramingMatchesTheRustParent() {
        let reply = OcrReply(id: 7, ok: true, angle: 0, lines: [RawLine(words: [RawWord(t: "Hi", x: 1, y: 2, w: 3, h: 4)])])
        let framed = Wire.frame(reply)
        XCTAssertEqual(replies(framed), [reply])
        let json = String(data: framed.dropFirst(4), encoding: .utf8) ?? ""
        for key in ["\"id\"", "\"ok\"", "\"angle\"", "\"lines\"", "\"words\"", "\"t\"", "\"x\"", "\"y\"", "\"w\"", "\"h\""] {
            XCTAssertTrue(json.contains(key), key)
        }
    }

    func testTheLoopAnswersUntilTheStreamEnds() {
        var data = message(request(), blob: 12)
        data.append(message(request(w: 2, h: 2), blob: 4))
        var input = MemoryReader(data: data)
        var output = MemoryWriter()
        let code = serve(input: &input, output: &output) { req, pixels in
            XCTAssertEqual(pixels.count, req.w * req.h)
            return OcrReply(id: req.id, ok: true)
        }
        XCTAssertEqual(code, 0)
        XCTAssertEqual(replies(output.data).count, 2)
    }

    func testABrokenMessageGetsAnErrorReplyAndEndsTheLoop() {
        var input = MemoryReader(data: Data([5, 0, 0, 0] + Array("{nope".utf8)))
        var output = MemoryWriter()
        let code = serve(input: &input, output: &output) { req, _ in OcrReply(id: req.id, ok: true) }
        XCTAssertEqual(code, 2)
        let got = replies(output.data)
        XCTAssertEqual(got.first?.ok, false)
        XCTAssertEqual(got.first?.error, "header")
    }
}

final class VisionSmokeTests: XCTestCase {
    func testAnUnsupportedLanguageIsAnErrorReply() {
        let req = OcrRequest(v: 1, id: 3, w: 8, h: 8, stride: 8, format: "gray8", lang: ["xx-XX"])
        let reply = VisionRecognizer.recognize(req, Data(repeating: 255, count: 64))
        XCTAssertFalse(reply.ok)
        XCTAssertEqual(reply.error, "language_unavailable")
    }

    func testABlankBitmapIsRecognizedAsEmpty() {
        let reply = VisionRecognizer.recognize(request(w: 64, h: 64), Data(repeating: 255, count: 64 * 64))
        XCTAssertTrue(reply.ok)
        XCTAssertTrue(reply.lines.isEmpty)
    }
}
