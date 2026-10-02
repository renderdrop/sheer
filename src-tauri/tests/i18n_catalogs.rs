//! The UI catalogs `src/i18n/locales/{en,de}.json` are the one source of the interface texts. The frontend imports them
//! directly; Rust reads the same files for the native menu labels (src-tauri/src/menu/spec.rs). That only works while they stay pure JSON (no
//! comments), flat (dotted keys, string values) and in step with each other, which these tests check.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::path::PathBuf;

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;

/// A flat JSON object of string values with the file's entries in order, duplicates included (a `HashMap` or a
/// `serde_json::Value` would silently keep only the last one).
struct Catalog(Vec<(String, String)>);

impl<'de> Deserialize<'de> for Catalog {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;

        impl<'de> Visitor<'de> for Entries {
            type Value = Catalog;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a flat JSON object whose values are strings")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Catalog, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, String>()? {
                    entries.push(entry);
                }
                Ok(Catalog(entries))
            }
        }

        deserializer.deserialize_map(Entries)
    }
}

impl Catalog {
    fn load(locale: &str) -> Self {
        let path: PathBuf = [
            env!("CARGO_MANIFEST_DIR"),
            "..",
            "src",
            "i18n",
            "locales",
            &format!("{locale}.json"),
        ]
        .iter()
        .collect();
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| {
            panic!(
                "{} is not a flat JSON object of strings: {error}",
                path.display()
            )
        })
    }

    fn keys(&self) -> BTreeSet<&str> {
        self.0.iter().map(|(key, _)| key.as_str()).collect()
    }
}

#[test]
fn both_catalogs_are_flat_json_objects_of_non_empty_strings() {
    for locale in ["en", "de"] {
        let catalog = Catalog::load(locale);
        assert!(!catalog.0.is_empty(), "{locale}.json has no entries");
        for (key, value) in &catalog.0 {
            assert!(!key.is_empty(), "{locale}.json has an empty key");
            assert!(!value.trim().is_empty(), "{locale}.json: {key} is empty");
        }
    }
}

#[test]
fn no_key_appears_twice_in_a_catalog() {
    for locale in ["en", "de"] {
        let catalog = Catalog::load(locale);
        assert_eq!(
            catalog.keys().len(),
            catalog.0.len(),
            "{locale}.json repeats a key"
        );
    }
}

#[test]
fn english_and_german_have_the_same_keys() {
    let en = Catalog::load("en");
    let de = Catalog::load("de");
    let missing_in_de: Vec<_> = en.keys().difference(&de.keys()).copied().collect();
    let missing_in_en: Vec<_> = de.keys().difference(&en.keys()).copied().collect();
    assert!(
        missing_in_de.is_empty() && missing_in_en.is_empty(),
        "keys missing in de.json: {missing_in_de:?}; keys missing in en.json: {missing_in_en:?}"
    );
}
