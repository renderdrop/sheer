//! Operating-system specifics, behind one small interface so no other module needs `cfg`.

use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;

/// The OS the app runs on, as the frontend names it. Only the two shipped platforms plus Linux for developer builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

/// The platform this binary was built for.
pub const fn current() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Macos
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// Whether the OS asks apps to avoid translucent surfaces (macOS: "Reduce transparency").
///
/// WKWebView does not map that setting to `prefers-reduced-transparency`, so the UI gets it from here (DESIGN §1).
/// `false` where the OS has no such flag or it is not read; Chromium-based WebView2 reports its own via CSS.
pub fn reduced_transparency() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::reduced_transparency()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_names_are_the_lowercase_wire_names() {
        for (platform, name) in [
            (Platform::Macos, "macos"),
            (Platform::Windows, "windows"),
            (Platform::Linux, "linux"),
        ] {
            assert_eq!(serde_json::to_value(platform).unwrap(), name);
        }
    }

    #[test]
    fn current_matches_the_build_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(current(), Platform::Windows);
        #[cfg(target_os = "macos")]
        assert_eq!(current(), Platform::Macos);
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn there_is_no_os_flag_off_macos() {
        assert!(!reduced_transparency());
    }
}
