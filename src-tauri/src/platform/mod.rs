//! Operating-system specifics, behind one small interface so no other module needs `cfg`.

use serde::Serialize;

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

/// The paper the OS region suggests for new documents (ADR-049 §3). The wire name is the lower-case word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    A4,
    Letter,
}

/// Regions whose usual office paper is Letter (the others use A4).
const LETTER_REGIONS: [&str; 16] = [
    "US", "CA", "MX", "CL", "CO", "CR", "DO", "GT", "PA", "PH", "PR", "VE", "BO", "SV", "HN", "NI",
];

/// The paper of a BCP 47 locale name such as `en-US` or `en_US.UTF-8`: Letter for the regions in [`LETTER_REGIONS`], A4 for every other
/// region and for a name without one.
pub fn paper_for_locale(name: &str) -> Paper {
    let tag = name.split(['.', '@']).next().unwrap_or_default();
    let region = tag
        .split(['-', '_'])
        .skip(1)
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()));
    match region {
        Some(region)
            if LETTER_REGIONS
                .iter()
                .any(|r| r.eq_ignore_ascii_case(region)) =>
        {
            Paper::Letter
        }
        _ => Paper::A4,
    }
}

/// Letter in the US, Canada and a few more regions, A4 elsewhere, from the OS locale (`sys-locale`: Windows `GetUserDefaultLocaleName`,
/// macOS `CFLocale`; our own code forbids the `unsafe` the direct calls need). A4 when the OS names no locale; never fails.
pub fn paper_default() -> Paper {
    sys_locale::get_locale().map_or(Paper::A4, |name| paper_for_locale(&name))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_paper_follows_the_region_of_the_locale() {
        for (name, paper) in [
            ("en-US", Paper::Letter),
            ("en_CA", Paper::Letter),
            ("es-MX", Paper::Letter),
            ("en_US.UTF-8", Paper::Letter),
            ("zh-Hans-US", Paper::Letter),
            ("de-DE", Paper::A4),
            ("en-GB", Paper::A4),
            ("de", Paper::A4),
            ("", Paper::A4),
            ("C", Paper::A4),
        ] {
            assert_eq!(paper_for_locale(name), paper, "{name}");
        }
    }

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
}
