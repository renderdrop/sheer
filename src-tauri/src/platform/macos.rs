//! macOS: the "Reduce transparency" accessibility setting (System Settings > Accessibility > Display).

use objc2_app_kit::NSWorkspace;

/// Reads `NSWorkspace.accessibilityDisplayShouldReduceTransparency`.
///
/// Both calls are safe in `objc2-app-kit`: `NSWorkspace` is not main-thread-only, and the property is a plain read of
/// a system-wide setting, so this can run on any thread (commands run on the blocking pool).
pub fn reduced_transparency() -> bool {
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
}
