// swift-tools-version:5.9
// sheer-ocr: the macOS OCR sidecar (ADR-134, ADR-137). Apple Vision behind the length-prefixed pipe of src-tauri/src/ocr/wire.rs.
// No third-party dependencies: Foundation, CoreGraphics and Vision ship with macOS.
import PackageDescription

let package = Package(
    name: "sheer-ocr",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "sheer-ocr", targets: ["sheer-ocr"]),
    ],
    targets: [
        // Pure helpers (framing, limits, boxes, tokens) and the Vision glue; testable without the executable.
        .target(name: "OcrCore"),
        .executableTarget(name: "sheer-ocr", dependencies: ["OcrCore"]),
        .testTarget(name: "OcrCoreTests", dependencies: ["OcrCore"]),
    ]
)
