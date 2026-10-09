//! User settings: a small JSON file in the app data directory, mirrored in memory.
//!
//! Wire shape (camelCase, enum values lowercase):
//! `{ "language": "system" | "en" | "de",
//! "leftPanelWidth": 200..=480, "welcomeTour": "pending" | "shown", "authorName": 0..=128 chars, sanitized (ADR-034), no control
//! characters, "authorPrompt": "pending" | "done", "updates": "off" | "on", "skippedVersion": null | version string (ADR-053) }`.
//!
//! - **Reading** never fails: a missing, oversized, damaged or hand-edited file falls back to the defaults, field by
//!   field. The file is user-writable, so nothing in it is trusted beyond the enum values and the width range it can
//!   hold. Only a regular file is read (a directory, FIFO or device at the path counts as damaged), judged on the opened
//!   handle and not on the path, and the open never waits (`O_NONBLOCK`); never more than
//!   `limits::MAX_SETTINGS_FILE_BYTES` of it is read.
//! - **Updating** validates the whole patch first (a bad `tags` list is `invalid_argument` with `what: "tags"`; unknown keys, unknown enum values and a width outside the range are
//!   `invalid_argument` with `what: "settings"`), then writes atomically and only then changes the in-memory copy, so a
//!   failed write leaves memory and disk in agreement. Updates are serialised, but reads are not: `get` never waits for
//!   the disk.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::tags::{TagDef, TAG_PALETTE};
use crate::storage::atomic::write_atomic;
use crate::storage::open_without_blocking;

/// File name inside the app data directory.
pub const FILE_NAME: &str = "settings.json";

/// Interface language. `System` follows the OS language (the frontend resolves it: `de*` is German, everything else English);
/// `En` and `De` are the two shipped translations (`src/i18n/locales`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    En,
    De,
}

/// Whether the welcome tour (ADR-023, DESIGN 3.14) still has to run on a first launch. The UI writes `Shown` *before* it opens the
/// welcome document, so the tour never starts twice on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WelcomeTour {
    #[default]
    Pending,
    Shown,
}

/// Width of the left panel in px (DESIGN 2, 3.8). Always within `limits::LEFT_PANEL_MIN_WIDTH..=LEFT_PANEL_MAX_WIDTH`:
/// the only ways in are [`PanelWidth::new`] and `Deserialize`, and both check the range. It is a plain number on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PanelWidth(u16);

impl PanelWidth {
    /// `None` outside the allowed range.
    pub const fn new(pixels: u16) -> Option<Self> {
        if pixels >= limits::LEFT_PANEL_MIN_WIDTH && pixels <= limits::LEFT_PANEL_MAX_WIDTH {
            Some(Self(pixels))
        } else {
            None
        }
    }

    pub const fn get(self) -> u16 {
        self.0
    }
}

impl Default for PanelWidth {
    fn default() -> Self {
        Self(limits::LEFT_PANEL_DEFAULT_WIDTH)
    }
}

impl<'de> Deserialize<'de> for PanelWidth {
    /// An integer in range. A float, a string, a negative or an oversized number is an error, never clamped: a value that
    /// is not valid is a bad request (patch) or a damaged field (file), and the callers handle both.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let pixels = u16::deserialize(deserializer)?;
        Self::new(pixels).ok_or_else(|| serde::de::Error::custom("panel width out of range"))
    }
}

/// Width of the right inspector in px (F20.8, ADR-144). Within [`INSPECTOR_MIN_WIDTH`]..=[`INSPECTOR_MAX_WIDTH`]; a patch outside
/// the range is rejected, a stored value outside it is clamped on load. Mirrors `INSPECTOR` in `src/lib/layout.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct InspectorWidth(u16);

pub const INSPECTOR_MIN_WIDTH: u16 = 240;
pub const INSPECTOR_MAX_WIDTH: u16 = 480;
pub const INSPECTOR_DEFAULT_WIDTH: u16 = 300;

impl InspectorWidth {
    /// `None` outside the allowed range.
    pub const fn new(pixels: u16) -> Option<Self> {
        if pixels >= INSPECTOR_MIN_WIDTH && pixels <= INSPECTOR_MAX_WIDTH {
            Some(Self(pixels))
        } else {
            None
        }
    }

    pub const fn get(self) -> u16 {
        self.0
    }

    /// A stored number, clamped into the range; anything that is not a non-negative integer gives the default.
    fn from_stored(value: &Value) -> Self {
        value.as_u64().map_or_else(Self::default, |pixels| {
            let clamped = pixels.clamp(
                u64::from(INSPECTOR_MIN_WIDTH),
                u64::from(INSPECTOR_MAX_WIDTH),
            );
            Self(u16::try_from(clamped).unwrap_or(INSPECTOR_DEFAULT_WIDTH))
        })
    }
}

impl Default for InspectorWidth {
    fn default() -> Self {
        Self(INSPECTOR_DEFAULT_WIDTH)
    }
}

impl<'de> Deserialize<'de> for InspectorWidth {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let pixels = u16::deserialize(deserializer)?;
        Self::new(pixels).ok_or_else(|| serde::de::Error::custom("inspector width out of range"))
    }
}

/// Whether `c` is an invisible format character (Unicode category Cf: bidi controls U+202A-U+202E and U+2066-U+2069, zero-width
/// U+200B-U+200F, U+FEFF and the rest of the category). Written out so no dependency is needed.
fn is_invisible(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// `name` without invisible and bidirectional characters (ADR-034), trimmed. Control characters are not touched here: they make
/// [`AuthorName::new`] refuse the name. Used when the setting is stored and when a PDF is written.
pub fn sanitize_author(name: &str) -> String {
    name.chars()
        .filter(|c| !is_invisible(*c))
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The name put on annotations the user creates (ADR-029, ADR-034, DESIGN 3.25). Empty (the default: no /T is written) or at
/// most `limits::MAX_AUTHOR_NAME_CHARS` characters, sanitized, without control characters: the only ways in are
/// [`AuthorName::new`] and `Deserialize`, and both check. It is a plain string on the wire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct AuthorName(String);

impl AuthorName {
    /// The sanitized name; `None` for a name over the limit (after sanitizing) or one with a control character.
    pub fn new(name: &str) -> Option<Self> {
        let clean = sanitize_author(name);
        if clean.chars().count() > limits::MAX_AUTHOR_NAME_CHARS
            || clean.chars().any(char::is_control)
        {
            None
        } else {
            Some(Self(clean))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The OS account's name, from the environment (`USERNAME` on Windows, `USER` or `LOGNAME` elsewhere), cleaned to be valid;
    /// empty when there is none. Only a *suggestion* for the author prompt (ADR-034): it is never stored by itself.
    pub fn os_suggestion() -> String {
        ["USERNAME", "USER", "LOGNAME"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .map(|raw| {
                raw.chars()
                    .filter(|c| !c.is_control())
                    .take(limits::MAX_AUTHOR_NAME_CHARS * 2)
                    .collect::<String>()
            })
            .find_map(|clean| Self::new(&clean).filter(|name| !name.0.is_empty()))
            .map(|name| name.0)
            .unwrap_or_default()
    }
}

impl<'de> Deserialize<'de> for AuthorName {
    /// A string that passes [`AuthorName::new`] (invisible characters are removed); anything else is an error, never cut.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Self::new(&name).ok_or_else(|| serde::de::Error::custom("author name not valid"))
    }
}

/// Whether the one-time author prompt (ADR-034) is still to be shown. The UI writes `Done` when the user confirmed or skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorPrompt {
    #[default]
    Pending,
    Done,
}

/// Whether Sheer may look for updates by itself (ADR-053 section 3). Off until the user turns it on; "Check for updates" in About is a
/// separate, per-click consent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatesMode {
    #[default]
    Off,
    On,
}

/// The version the user chose not to be offered again: none, or at most `limits::UPDATE_VERSION_MAX_CHARS` characters of a version
/// string (ASCII letters, digits, `.`, `-`, `+`). The only ways in are [`SkippedVersion::new`] and `Deserialize`. `null` on the wire when none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SkippedVersion(Option<String>);

impl SkippedVersion {
    /// `None` for a string that is empty, too long or not a version-like word.
    pub fn new(version: &str) -> Option<Self> {
        let valid = !version.is_empty()
            && version.chars().count() <= limits::UPDATE_VERSION_MAX_CHARS
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
        valid.then(|| Self(Some(version.to_owned())))
    }

    pub fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl<'de> Deserialize<'de> for SkippedVersion {
    /// `null` (none) or a string that passes [`SkippedVersion::new`]; anything else is an error, never cut.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Option::<String>::deserialize(deserializer)? {
            None => Ok(Self(None)),
            Some(version) => {
                Self::new(&version).ok_or_else(|| serde::de::Error::custom("version not valid"))
            }
        }
    }
}

/// The tools whose first-use tip was shown (ADR-054): tool ids of at most 32 ASCII letters, digits, `-` or `_`, at most 64 of them,
/// without repeats (a repeat is dropped, not an error). The only ways in are [`TipsSeen::new`] and `Deserialize`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct TipsSeen(Vec<String>);

impl TipsSeen {
    pub const MAX_IDS: usize = 64;
    pub const MAX_ID_CHARS: usize = 32;

    /// `None` for a list over the limit or with an id that is empty, too long or not plain ASCII.
    pub fn new(ids: &[String]) -> Option<Self> {
        let mut kept: Vec<String> = Vec::new();
        for id in ids {
            let valid = !id.is_empty()
                && id.len() <= Self::MAX_ID_CHARS
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if !valid {
                return None;
            }
            if !kept.contains(id) {
                kept.push(id.clone());
            }
        }
        (ids.len() <= Self::MAX_IDS && kept.len() <= Self::MAX_IDS).then_some(Self(kept))
    }

    pub fn ids(&self) -> &[String] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TipsSeen {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let ids = Vec::<String>::deserialize(deserializer)?;
        Self::new(&ids).ok_or_else(|| serde::de::Error::custom("tip ids not valid"))
    }
}

/// Keys that older versions wrote (colour theme and glass mode went away with the light-only redesign, ADR-100; the tool
/// sidebar and with it its collapse flag went away with the mode tabs, ADR-102). They are
/// ignored on reading and dropped from the file by the startup rewrite (`SettingsStore::drop_retired_keys`, called at start for a file that still holds one;
/// a failed one is tried again at the next start).
const RETIRED_KEYS: [&str; 3] = ["glass", "theme", "toolSidebarCollapsed"];

/// One tag definition as it is stored (ADR-119): the name without invisible characters, trimmed, 1..=`limits::TAG_NAME_MAX`
/// characters and no control character; the colour one of [`TAG_PALETTE`]. `None` for anything else.
fn clean_tag(tag: &TagDef) -> Option<TagDef> {
    let name = sanitize_author(&tag.name);
    let valid = !name.is_empty()
        && name.chars().count() <= limits::TAG_NAME_MAX
        && !name.chars().any(char::is_control)
        && TAG_PALETTE.contains(&tag.color);
    valid.then_some(TagDef {
        name,
        color: tag.color,
    })
}

/// The list of tag definitions of a patch: every entry valid, names unique ignoring case, at most `limits::TAGS_MAX`. `None` if any
/// rule is broken (the patch is then refused whole).
pub fn validate_tags(tags: &[TagDef]) -> Option<Vec<TagDef>> {
    if tags.len() > limits::TAGS_MAX {
        return None;
    }
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(tags.len());
    for tag in tags {
        let tag = clean_tag(tag)?;
        if !seen.insert(tag.name.to_lowercase()) {
            return None;
        }
        kept.push(tag);
    }
    Some(kept)
}

/// The tag definitions of a stored file: an entry that is not valid or repeats a name (ignoring case) is dropped, and so is everything
/// after the `limits::TAGS_MAX`-th valid one. Never fails.
fn stored_tags(value: &Value) -> Vec<TagDef> {
    let Value::Array(entries) = value else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    for entry in entries {
        if kept.len() >= limits::TAGS_MAX {
            break;
        }
        let Some(tag) = TagDef::deserialize(entry).ok().as_ref().and_then(clean_tag) else {
            continue;
        };
        if seen.insert(tag.name.to_lowercase()) {
            kept.push(tag);
        }
    }
    kept
}

/// A tag list in a patch must pass [`validate_tags`].
fn tags_present<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<TagDef>>, D::Error> {
    let tags = Vec::<TagDef>::deserialize(deserializer)?;
    validate_tags(&tags)
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("tags not valid"))
}

/// Every persisted setting. Add a field here, to [`SettingsPatch`] and to `src/api/app.ts` together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub language: Language,
    pub left_panel_width: PanelWidth,
    /// Width of the right inspector (F20.8); default 300, 240..=480.
    pub inspector_width: InspectorWidth,
    pub welcome_tour: WelcomeTour,
    pub author_name: AuthorName,
    pub author_prompt: AuthorPrompt,
    pub updates: UpdatesMode,
    pub skipped_version: SkippedVersion,
    pub tips_seen: TipsSeen,
    /// The page sidebar is collapsed (DESIGN v2 3.2).
    pub page_sidebar_collapsed: bool,
    /// First-use tips are shown at all (ADR-138); default true.
    pub tips_enabled: bool,
    /// The tool card shows labels next to its icons (F21.6); default false.
    pub show_tool_labels: bool,
    /// The tag definitions (ADR-119), shared by all documents. Validated by [`validate_tags`] (patch) and `stored_tags` (file).
    pub tags: Vec<TagDef>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: Language::default(),
            left_panel_width: PanelWidth::default(),
            inspector_width: InspectorWidth::default(),
            welcome_tour: WelcomeTour::default(),
            author_name: AuthorName::default(),
            author_prompt: AuthorPrompt::default(),
            updates: UpdatesMode::default(),
            skipped_version: SkippedVersion::default(),
            tips_seen: TipsSeen::default(),
            page_sidebar_collapsed: false,
            tips_enabled: true,
            show_tool_labels: false,
            tags: Vec::new(),
        }
    }
}

impl Settings {
    /// Settings from stored bytes: every field that is missing or invalid becomes its default, unknown keys are
    /// ignored (a newer version may have written them).
    fn from_stored(bytes: &[u8]) -> Self {
        let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(bytes) else {
            return Self::default();
        };
        Self {
            language: map
                .get("language")
                .and_then(|value| Language::deserialize(value).ok())
                .unwrap_or_default(),
            left_panel_width: map
                .get("leftPanelWidth")
                .and_then(|value| PanelWidth::deserialize(value).ok())
                .unwrap_or_default(),
            inspector_width: map
                .get("inspectorWidth")
                .map(InspectorWidth::from_stored)
                .unwrap_or_default(),
            welcome_tour: map
                .get("welcomeTour")
                .and_then(|value| WelcomeTour::deserialize(value).ok())
                .unwrap_or_default(),
            author_name: map
                .get("authorName")
                .and_then(|value| AuthorName::deserialize(value).ok())
                .unwrap_or_default(),
            author_prompt: map
                .get("authorPrompt")
                .and_then(|value| AuthorPrompt::deserialize(value).ok())
                .unwrap_or_default(),
            updates: map
                .get("updates")
                .and_then(|value| UpdatesMode::deserialize(value).ok())
                .unwrap_or_default(),
            skipped_version: map
                .get("skippedVersion")
                .and_then(|value| SkippedVersion::deserialize(value).ok())
                .unwrap_or_default(),
            tips_seen: map
                .get("tipsSeen")
                .and_then(|value| TipsSeen::deserialize(value).ok())
                .unwrap_or_default(),
            page_sidebar_collapsed: map
                .get("pageSidebarCollapsed")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
            tips_enabled: map
                .get("tipsEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            show_tool_labels: map
                .get("showToolLabels")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tags: map.get("tags").map(stored_tags).unwrap_or_default(),
        }
    }

    /// These settings with every field the patch names replaced.
    pub fn apply(self, patch: SettingsPatch) -> Self {
        Self {
            language: patch.language.unwrap_or(self.language),
            left_panel_width: patch.left_panel_width.unwrap_or(self.left_panel_width),
            inspector_width: patch.inspector_width.unwrap_or(self.inspector_width),
            welcome_tour: patch.welcome_tour.unwrap_or(self.welcome_tour),
            author_name: patch.author_name.unwrap_or(self.author_name),
            author_prompt: patch.author_prompt.unwrap_or(self.author_prompt),
            updates: patch.updates.unwrap_or(self.updates),
            skipped_version: patch.skipped_version.unwrap_or(self.skipped_version),
            tips_seen: patch.tips_seen.unwrap_or(self.tips_seen),
            page_sidebar_collapsed: patch
                .page_sidebar_collapsed
                .unwrap_or(self.page_sidebar_collapsed),
            tips_enabled: patch.tips_enabled.unwrap_or(self.tips_enabled),
            show_tool_labels: patch.show_tool_labels.unwrap_or(self.show_tool_labels),
            tags: patch.tags.unwrap_or(self.tags),
        }
    }
}

/// A partial update: at most the nine settings, each optional. Parsed only by [`SettingsPatch::from_value`], which
/// rejects every unknown key (`deny_unknown_fields`), so a patch can never name more than these nine fields.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "present")]
    pub language: Option<Language>,
    #[serde(default, deserialize_with = "present")]
    pub left_panel_width: Option<PanelWidth>,
    #[serde(default, deserialize_with = "present")]
    pub inspector_width: Option<InspectorWidth>,
    #[serde(default, deserialize_with = "present")]
    pub welcome_tour: Option<WelcomeTour>,
    #[serde(default, deserialize_with = "present")]
    pub author_name: Option<AuthorName>,
    #[serde(default, deserialize_with = "present")]
    pub author_prompt: Option<AuthorPrompt>,
    #[serde(default, deserialize_with = "present")]
    pub updates: Option<UpdatesMode>,
    #[serde(default, deserialize_with = "present")]
    pub skipped_version: Option<SkippedVersion>,
    #[serde(default, deserialize_with = "present")]
    pub tips_seen: Option<TipsSeen>,
    #[serde(default, deserialize_with = "present")]
    pub page_sidebar_collapsed: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub tips_enabled: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub show_tool_labels: Option<bool>,
    /// Replaces the tag list (ADR-119).
    #[serde(default, deserialize_with = "tags_present")]
    pub tags: Option<Vec<TagDef>>,
}

/// A field that is present must hold a valid value. Plain `Option` would read `null` as "absent" and accept it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl SettingsPatch {
    /// Validates the JSON the webview sent. It must be an object whose keys are known settings and whose values are
    /// valid for them. An empty object is a valid no-op. Anything else is `invalid_argument` (`what: "settings"`),
    /// so a bad request never reaches the file.
    pub fn from_value(value: &Value) -> Result<Self, AppError> {
        // A struct also deserializes from an array (field by field, in order), so the shape is checked first.
        if !value.is_object() {
            return Err(AppError::invalid("settings"));
        }
        Self::deserialize(value).map_err(|_| {
            // A bad tag list is named, so the UI can say which part of the request it refused (ADR-119).
            let bad_tags = value.get("tags").is_some_and(|tags| {
                Vec::<TagDef>::deserialize(tags)
                    .ok()
                    .and_then(|list| validate_tags(&list))
                    .is_none()
            });
            AppError::invalid(if bad_tags { "tags" } else { "settings" })
        })
    }
}

/// The settings of the running app: in memory, backed by one file.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    /// The current settings. Locked only for the instant of a read or an assignment, never across file IO, so `get`
    /// cannot be held up by a slow disk.
    current: Mutex<Settings>,
    /// Serialises `update`: one writer at a time keeps the file in the same order as memory. This is the lock that is
    /// held across fsync and rename.
    writer: Mutex<()>,
    /// The file on disk still holds a retired key (see [`RETIRED_KEYS`]); cleared by the next successful write.
    stale: AtomicBool,
}

impl SettingsStore {
    /// Loads the settings at `path`. Never fails; see the module docs.
    pub fn load(path: PathBuf) -> Self {
        let mut stale = false;
        let current = match read_bounded(&path) {
            Ok(bytes) => {
                stale = has_retired_keys(&bytes);
                Settings::from_stored(&bytes)
            }
            // First start: nothing stored yet.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(error) => {
                AppError::from(error).log();
                Settings::default()
            }
        };
        Self {
            path,
            current: Mutex::new(current),
            writer: Mutex::new(()),
            stale: AtomicBool::new(stale),
        }
    }

    /// Rewrites the file when it still holds a retired key, so the keys are gone after the first start. Nothing happens
    /// otherwise. A failed write is returned and the next start tries again.
    pub fn drop_retired_keys(&self) -> Result<(), AppError> {
        let _writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        if !self.stale.load(Ordering::Acquire) {
            return Ok(());
        }
        let bytes = to_file_bytes(&self.get())?;
        write_atomic(&self.path, &bytes)?;
        self.stale.store(false, Ordering::Release);
        Ok(())
    }

    /// The current settings. Never waits for a write in progress: it answers with the last persisted state.
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Applies `patch`, persists the result atomically and returns it. If persisting fails, nothing changes.
    pub fn update(&self, patch: SettingsPatch) -> Result<Settings, AppError> {
        self.update_with(patch, |bytes| write_atomic(&self.path, bytes))
    }

    /// `update` with the persisting step passed in, so a test can hold the write open.
    fn update_with(
        &self,
        patch: SettingsPatch,
        persist: impl FnOnce(&[u8]) -> io::Result<()>,
    ) -> Result<Settings, AppError> {
        // The lock guards no data (`()`), so a poisoned one is safe to keep using.
        let _writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        // Only `update` assigns `current`, and updates are serialised, so it cannot change before the assignment below.
        let current = self.get();
        let next = current.clone().apply(patch);
        if next != current {
            persist(&to_file_bytes(&next)?)?;
            self.stale.store(false, Ordering::Release);
            *self.lock() = next.clone();
        }
        Ok(next)
    }

    /// The settings are plain data, so a panic elsewhere cannot leave them half-updated: a poisoned lock is safe
    /// to keep using.
    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The pretty JSON of `settings` with a final newline.
fn to_file_bytes(settings: &Settings) -> Result<Vec<u8>, AppError> {
    let mut bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Whether stored bytes are a JSON object that names a retired key.
fn has_retired_keys(bytes: &[u8]) -> bool {
    matches!(serde_json::from_slice::<Value>(bytes), Ok(Value::Object(map)) if RETIRED_KEYS.iter().any(|key| map.contains_key(*key)))
}

/// Reads at most `MAX_SETTINGS_FILE_BYTES` of a regular file; a longer file is reported as invalid data instead of
/// being buffered.
///
/// The file is opened first and its type is read from the opened handle, never from the path: checking the path and then
/// opening it would leave a gap in which something else could be put at the path (a FIFO, a device, a link to a file the
/// user did not choose), and the check would be about the wrong thing. Opening is also where a FIFO hurts, so it is
/// opened without waiting (see `open_without_blocking`). The handle's metadata follows symlinks, so a link to a regular
/// file still works.
fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    read_regular(open_without_blocking(path)?)
}

/// Reads at most `MAX_SETTINGS_FILE_BYTES` of `file`, which must be a regular file.
fn read_regular(file: File) -> io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(limits::MAX_SETTINGS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits::MAX_SETTINGS_FILE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::error::UiError;
    use crate::storage::atomic::testutil::TempDir;

    fn store_in(dir: &TempDir) -> SettingsStore {
        SettingsStore::load(dir.path().join(FILE_NAME))
    }

    fn patch(value: Value) -> Result<SettingsPatch, AppError> {
        SettingsPatch::from_value(&value)
    }

    fn rejected(value: Value) -> String {
        serde_json::to_string(&UiError::from(patch(value).unwrap_err())).unwrap()
    }

    const INVALID_SETTINGS: &str = r#"{"code":"invalid_argument","key":"error.invalid_argument","retryable":false,"params":{"what":"settings"}}"#;

    // --- wire shape ---

    #[test]
    fn settings_serialize_with_lowercase_enum_values() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({ "language": "system", "leftPanelWidth": 220, "inspectorWidth": 300, "welcomeTour": "pending", "authorName": "", "authorPrompt": "pending", "updates": "off", "skippedVersion": null, "tipsSeen": [], "pageSidebarCollapsed": false, "tipsEnabled": true, "showToolLabels": false, "tags": [] })
        );
        let settings = Settings {
            language: Language::De,
            left_panel_width: PanelWidth::new(320).unwrap(),
            inspector_width: InspectorWidth::new(360).unwrap(),
            welcome_tour: WelcomeTour::Shown,
            author_name: AuthorName::new("Ada Lovelace").unwrap(),
            author_prompt: AuthorPrompt::Done,
            updates: UpdatesMode::On,
            skipped_version: SkippedVersion::new("1.2.3-rc.1").unwrap(),
            tips_seen: TipsSeen::new(&["textBox".to_owned()]).unwrap(),
            page_sidebar_collapsed: true,
            tips_enabled: false,
            show_tool_labels: true,
            tags: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            json!({ "language": "de", "leftPanelWidth": 320, "inspectorWidth": 360, "welcomeTour": "shown", "authorName": "Ada Lovelace", "authorPrompt": "done", "updates": "on", "skippedVersion": "1.2.3-rc.1", "tipsSeen": ["textBox"], "pageSidebarCollapsed": true, "tipsEnabled": false, "showToolLabels": true, "tags": [] })
        );
    }

    // --- the welcome tour flag (ADR-023) ---

    #[test]
    fn the_welcome_tour_is_pending_by_default_and_a_patch_can_mark_it_shown() {
        assert_eq!(Settings::default().welcome_tour, WelcomeTour::Pending);
        let patched = Settings::default().apply(patch(json!({ "welcomeTour": "shown" })).unwrap());
        assert_eq!(patched.welcome_tour, WelcomeTour::Shown);
        // Another field leaves it alone.
        let other = patched.apply(patch(json!({ "language": "de" })).unwrap());
        assert_eq!(other.welcome_tour, WelcomeTour::Shown);
    }

    #[test]
    fn an_invalid_welcome_tour_value_is_refused_in_a_patch_and_falls_back_to_pending_in_a_file() {
        for bad in [
            json!("done"),
            json!(true),
            json!(null),
            json!(1),
            json!("Shown"),
        ] {
            assert_eq!(
                rejected(json!({ "welcomeTour": bad.clone() })),
                INVALID_SETTINGS,
                "{bad}"
            );
        }
        assert_eq!(
            Settings::from_stored(br#"{"welcomeTour":"shown"}"#).welcome_tour,
            WelcomeTour::Shown
        );
        for stored in [
            r#"{"welcomeTour":"done"}"#,
            r#"{"welcomeTour":3}"#,
            r#"{"welcomeTour":null}"#,
            r#"{}"#,
        ] {
            assert_eq!(
                Settings::from_stored(stored.as_bytes()).welcome_tour,
                WelcomeTour::Pending,
                "{stored}"
            );
        }
    }

    // --- the author name (ADR-029, ADR-034) ---

    #[test]
    fn an_author_name_is_empty_or_up_to_128_characters_without_control_characters() {
        let longest = "ä".repeat(limits::MAX_AUTHOR_NAME_CHARS);
        for ok in ["", "A", "Ada Lovelace", "李雷", longest.as_str()] {
            assert_eq!(
                patch(json!({ "authorName": ok })).unwrap().author_name,
                AuthorName::new(ok),
                "{ok}"
            );
        }
        let too_long = "a".repeat(limits::MAX_AUTHOR_NAME_CHARS + 1);
        for bad in [
            json!(too_long),
            json!("a\nb"),
            json!("a\u{0}b"),
            json!("a\u{7f}"),
            json!(null),
            json!(3),
            json!(["Ada"]),
        ] {
            assert_eq!(
                rejected(json!({ "authorName": bad.clone() })),
                INVALID_SETTINGS,
                "{bad}"
            );
        }
    }

    #[test]
    fn invisible_and_bidi_characters_are_removed_from_a_name() {
        assert_eq!(
            sanitize_author("\u{202E}Ada\u{200B} Love\u{2066}lace\u{FEFF}"),
            "Ada Lovelace"
        );
        for c in [
            '\u{202A}', '\u{202E}', '\u{2066}', '\u{2069}', '\u{200B}', '\u{200F}', '\u{FEFF}',
        ] {
            assert_eq!(sanitize_author(&format!("a{c}b")), "ab", "{c:?}");
        }
        // Only invisible characters: the name becomes empty, which is allowed.
        assert_eq!(AuthorName::new("\u{200B}\u{202E}").unwrap().as_str(), "");
        // The limit counts what is left after sanitizing.
        let padded = format!("{}\u{200B}", "a".repeat(limits::MAX_AUTHOR_NAME_CHARS));
        assert!(AuthorName::new(&padded).is_some());
        assert_eq!(
            patch(json!({ "authorName": "\u{202E}Ada" }))
                .unwrap()
                .author_name,
            AuthorName::new("Ada")
        );
        // Control characters are still refused, not stripped.
        assert!(AuthorName::new("a\u{85}b").is_none());
    }

    #[test]
    fn the_author_name_is_empty_by_default_and_is_stored_and_read_back() {
        assert_eq!(Settings::default().author_name.as_str(), "");
        assert_eq!(Settings::default().author_prompt, AuthorPrompt::Pending);
        let dir = TempDir::new();
        let store = store_in(&dir);
        apply_json(
            &store,
            json!({ "authorName": "Ada", "authorPrompt": "done" }),
        )
        .unwrap();
        assert_eq!(store_in(&dir).get().author_name.as_str(), "Ada");
        assert_eq!(store_in(&dir).get().author_prompt, AuthorPrompt::Done);
        apply_json(&store, json!({ "authorName": "" })).unwrap();
        assert_eq!(store_in(&dir).get().author_name.as_str(), "");
        // A damaged stored name or prompt falls back to the default.
        for contents in [
            r#"{"authorName":5,"authorPrompt":"x"}"#,
            r#"{"authorName":"a\nb","authorPrompt":null}"#,
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get(), Settings::default());
        }
        assert_eq!(
            rejected(json!({ "authorPrompt": "later" })),
            INVALID_SETTINGS
        );
    }

    #[test]
    fn the_os_suggestion_is_valid_but_never_the_default() {
        let suggestion = AuthorName::os_suggestion();
        assert!(AuthorName::new(&suggestion).is_some());
        assert_eq!(Settings::default().author_name.as_str(), "");
    }

    // --- patch validation ---

    #[test]
    fn a_patch_accepts_every_valid_value() {
        for (name, language) in [
            ("system", Language::System),
            ("en", Language::En),
            ("de", Language::De),
        ] {
            assert_eq!(
                patch(json!({ "language": name })).unwrap(),
                SettingsPatch {
                    language: Some(language),
                    ..SettingsPatch::default()
                }
            );
        }
        assert_eq!(
            patch(json!({ "language": "en", "leftPanelWidth": 296 })).unwrap(),
            SettingsPatch {
                language: Some(Language::En),
                left_panel_width: PanelWidth::new(296),
                inspector_width: None,
                welcome_tour: None,
                author_name: None,
                author_prompt: None,
                updates: None,
                skipped_version: None,
                tips_seen: None,
                page_sidebar_collapsed: None,
                tips_enabled: None,
                show_tool_labels: None,
                tags: None,
            }
        );
    }

    #[test]
    fn tips_are_enabled_by_default_and_the_flag_must_be_a_boolean() {
        assert!(Settings::default().tips_enabled);
        assert!(Settings::from_stored(br#"{"language":"de"}"#).tips_enabled);
        assert!(Settings::from_stored(br#"{"tipsEnabled":"no"}"#).tips_enabled);
        assert!(!Settings::from_stored(br#"{"tipsEnabled":false}"#).tips_enabled);
        assert!(patch(json!({ "tipsEnabled": null })).is_err());
        assert!(patch(json!({ "tipsEnabled": 0 })).is_err());
        let off = Settings::default().apply(patch(json!({ "tipsEnabled": false })).unwrap());
        assert!(!off.tips_enabled);
    }

    #[test]
    fn tool_labels_are_off_by_default_and_the_flag_must_be_a_boolean() {
        assert!(!Settings::default().show_tool_labels);
        assert!(!Settings::from_stored(br#"{"language":"de"}"#).show_tool_labels);
        assert!(!Settings::from_stored(br#"{"showToolLabels":"yes"}"#).show_tool_labels);
        assert!(Settings::from_stored(br#"{"showToolLabels":true}"#).show_tool_labels);
        assert!(patch(json!({ "showToolLabels": null })).is_err());
        assert!(patch(json!({ "showToolLabels": 1 })).is_err());
        let on = Settings::default().apply(patch(json!({ "showToolLabels": true })).unwrap());
        assert!(on.show_tool_labels);
        assert!(on.apply(SettingsPatch::default()).show_tool_labels);
    }

    #[test]
    fn the_inspector_width_defaults_clamps_on_load_and_rejects_bad_patches() {
        assert_eq!(Settings::default().inspector_width.get(), 300);
        for (stored, expected) in [
            (r#"{"language":"de"}"#, 300),
            (r#"{"inspectorWidth":240}"#, 240),
            (r#"{"inspectorWidth":400}"#, 400),
            (r#"{"inspectorWidth":100}"#, 240),
            (r#"{"inspectorWidth":9999}"#, 480),
            (r#"{"inspectorWidth":"400"}"#, 300),
            (r#"{"inspectorWidth":-5}"#, 300),
            (r#"{"inspectorWidth":null}"#, 300),
        ] {
            assert_eq!(
                Settings::from_stored(stored.as_bytes())
                    .inspector_width
                    .get(),
                expected,
                "{stored}"
            );
        }
        let set = Settings::default().apply(patch(json!({ "inspectorWidth": 420 })).unwrap());
        assert_eq!(set.inspector_width.get(), 420);
        for bad in [
            json!(239),
            json!(481),
            json!(300.5),
            json!("300"),
            json!(null),
        ] {
            assert!(patch(json!({ "inspectorWidth": bad })).is_err());
        }
    }

    #[test]
    fn the_page_sidebar_flag_defaults_open_and_must_be_a_boolean() {
        let stored = Settings::from_stored(br#"{"pageSidebarCollapsed":true}"#);
        assert!(stored.page_sidebar_collapsed);
        assert!(
            !Settings::from_stored(br#"{"pageSidebarCollapsed":"yes"}"#).page_sidebar_collapsed
        );
        assert!(patch(json!({ "pageSidebarCollapsed": null })).is_err());
        assert!(patch(json!({ "pageSidebarCollapsed": 1 })).is_err());
        // The tool sidebar is gone (ADR-102): its flag is no longer a setting.
        assert!(patch(json!({ "toolSidebarCollapsed": true })).is_err());
    }

    #[test]
    fn tips_seen_is_bounded_deduplicated_and_ascii() {
        assert!(Settings::default().tips_seen.ids().is_empty());
        let stored = Settings::from_stored(br#"{"tipsSeen":["a","b","a"]}"#);
        assert_eq!(stored.tips_seen.ids(), ["a", "b"]);
        let many: Vec<String> = (0..=TipsSeen::MAX_IDS).map(|n| format!("t{n}")).collect();
        let long = "x".repeat(TipsSeen::MAX_ID_CHARS + 1);
        for bad in [
            json!(many),
            json!([long]),
            json!([""]),
            json!(["a b"]),
            json!(["ä"]),
            json!([5]),
            json!("a"),
            json!(null),
        ] {
            assert!(
                SettingsPatch::from_value(&json!({ "tipsSeen": bad })).is_err(),
                "{bad}"
            );
        }
        let exact: Vec<String> = (0..TipsSeen::MAX_IDS).map(|n| format!("t{n}")).collect();
        assert!(SettingsPatch::from_value(&json!({ "tipsSeen": exact })).is_ok());
        assert_eq!(
            Settings::from_stored(br#"{"tipsSeen":["a b"]}"#).tips_seen,
            TipsSeen::default()
        );
    }

    #[test]
    fn updates_default_off_and_the_skipped_version_is_checked() {
        assert_eq!(Settings::default().updates, UpdatesMode::Off);
        assert_eq!(Settings::default().skipped_version.as_deref(), None);
        let stored = Settings::from_stored(br#"{"updates":"on","skippedVersion":"2.0.0"}"#);
        assert_eq!(stored.updates, UpdatesMode::On);
        assert_eq!(stored.skipped_version.as_deref(), Some("2.0.0"));
        // A damaged file falls back field by field.
        let damaged = Settings::from_stored(br#"{"updates":"maybe","skippedVersion":"1 2"}"#);
        assert_eq!(damaged.updates, UpdatesMode::Off);
        assert_eq!(damaged.skipped_version.as_deref(), None);
        let long = "1".repeat(limits::UPDATE_VERSION_MAX_CHARS + 1);
        for bad in [
            json!({ "updates": "auto" }),
            json!({ "updates": null }),
            json!({ "skippedVersion": "" }),
            json!({ "skippedVersion": long }),
            json!({ "skippedVersion": 5 }),
            json!({ "skippedVersion": "a{202e}b" }),
        ] {
            assert!(SettingsPatch::from_value(&bad).is_err(), "{bad}");
        }
        let patch = SettingsPatch::from_value(
            &json!({ "updates": "on", "skippedVersion": null, "tipsSeen": [] }),
        )
        .unwrap();
        assert_eq!(patch.updates, Some(UpdatesMode::On));
        assert_eq!(patch.skipped_version, Some(SkippedVersion::default()));
        let applied = Settings::default().apply(patch);
        assert_eq!(applied.updates, UpdatesMode::On);
    }

    #[test]
    fn a_panel_width_patch_accepts_exactly_the_design_range() {
        for pixels in [200, 201, 248, 320, 479, 480] {
            assert_eq!(
                patch(json!({ "leftPanelWidth": pixels })).unwrap(),
                SettingsPatch {
                    left_panel_width: PanelWidth::new(pixels),
                    ..SettingsPatch::default()
                },
                "{pixels}"
            );
        }
        for bad in [
            json!(0),
            json!(199),
            json!(481),
            json!(65_535),
            json!(65_536),
            json!(-248),
            json!(248.5),
            json!(248.0),
            json!("248"),
            json!(null),
            json!(true),
            json!([248]),
            json!({ "px": 248 }),
        ] {
            assert_eq!(
                rejected(json!({ "leftPanelWidth": bad.clone() })),
                INVALID_SETTINGS,
                "{bad}"
            );
        }
        // The wire name is exact: the Rust field name is not accepted.
        assert_eq!(
            rejected(json!({ "left_panel_width": 248 })),
            INVALID_SETTINGS
        );
    }

    #[test]
    fn the_panel_width_range_is_the_one_in_limits() {
        assert_eq!(
            PanelWidth::default().get(),
            limits::LEFT_PANEL_DEFAULT_WIDTH
        );
        assert!(PanelWidth::new(limits::LEFT_PANEL_MIN_WIDTH).is_some());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MAX_WIDTH).is_some());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MIN_WIDTH - 1).is_none());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MAX_WIDTH + 1).is_none());
        // The default is inside the range (the order of the three is checked at compile time in `limits`).
        assert!(PanelWidth::new(limits::LEFT_PANEL_DEFAULT_WIDTH).is_some());
    }

    #[test]
    fn an_empty_patch_is_a_valid_no_op() {
        assert_eq!(patch(json!({})).unwrap(), SettingsPatch::default());
    }

    #[test]
    fn a_patch_rejects_unknown_enum_values() {
        for bad in [
            "Solid", "AUTO", "dark ", " dark", "", "blur", "reduced", "none", "dark\0",
        ] {
            assert_eq!(
                rejected(json!({ "glass": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
            assert_eq!(
                rejected(json!({ "theme": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
        }
        // Language tags are not accepted: only the three wire names, in lowercase.
        for bad in [
            "De", "EN", "de-DE", "en_US", "fr", "german", "", " de", "en ", "de\0", "auto",
        ] {
            assert_eq!(
                rejected(json!({ "language": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
        }
        // Values of the other setting are not valid either.
        assert_eq!(rejected(json!({ "glass": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "theme": "solid" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "language": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "theme": "de" })), INVALID_SETTINGS);
    }

    #[test]
    fn a_patch_rejects_values_that_are_not_strings() {
        for bad in [
            json!(null),
            json!(true),
            json!(0),
            json!(["auto"]),
            json!({ "auto": 1 }),
        ] {
            assert_eq!(rejected(json!({ "glass": bad.clone() })), INVALID_SETTINGS);
            assert_eq!(rejected(json!({ "theme": bad.clone() })), INVALID_SETTINGS);
            assert_eq!(rejected(json!({ "language": bad })), INVALID_SETTINGS);
        }
    }

    #[test]
    fn a_patch_rejects_unknown_keys_and_non_objects() {
        assert_eq!(rejected(json!({ "colour": "red" })), INVALID_SETTINGS);
        assert_eq!(
            rejected(json!({ "updates": "off", "../x": 1 })),
            INVALID_SETTINGS
        );
        for bad in [
            json!(null),
            json!("glass"),
            json!(3),
            json!([]),
            // A struct would also read an array field by field; a patch must be an object.
            json!(["solid", "dark"]),
            json!(["solid"]),
            json!(true),
        ] {
            assert_eq!(rejected(bad), INVALID_SETTINGS);
        }
    }

    #[test]
    fn a_patch_can_name_at_most_the_four_settings() {
        // Every key beyond the four known ones is unknown, so a patch with more than four keys never passes. The check
        // stops at the first unknown key: a huge object is refused without being walked.
        assert_eq!(
            rejected(json!({ "language": "de", "leftPanelWidth": 248, "extra": 1 })),
            INVALID_SETTINGS
        );
        let huge: serde_json::Map<String, Value> =
            (0..10_000).map(|n| (format!("key{n}"), json!(n))).collect();
        assert_eq!(rejected(Value::Object(huge)), INVALID_SETTINGS);
        // Key names are case-sensitive and exact.
        for key in [
            "Glass",
            "THEME",
            "glass ",
            "",
            "theme\0",
            "glass.language",
            "LeftPanelWidth",
            "Language",
        ] {
            assert_eq!(
                rejected(json!({ key: "auto" })),
                INVALID_SETTINGS,
                "{key:?}"
            );
        }
    }

    #[test]
    fn a_rejection_names_no_value() {
        // The error carries the fixed word "settings", never the offending input.
        let text = rejected(json!({ "glass": "C:\\Users\\user\\secret" }));
        assert!(!text.contains("secret"), "{text}");
        assert_eq!(text, INVALID_SETTINGS);
    }

    #[test]
    fn apply_replaces_only_the_named_fields() {
        let base = Settings {
            updates: UpdatesMode::On,
            language: Language::De,
            ..Settings::default()
        };
        let only_theme = patch(json!({ "language": "en" })).unwrap();
        assert_eq!(
            base.clone().apply(only_theme),
            Settings {
                updates: UpdatesMode::On,
                language: Language::En,
                ..Settings::default()
            }
        );
        let only_width = patch(json!({ "leftPanelWidth": 304 })).unwrap();
        assert_eq!(
            base.clone().apply(only_width),
            Settings {
                left_panel_width: PanelWidth::new(304).unwrap(),
                ..base.clone()
            }
        );
        assert_eq!(base.clone().apply(SettingsPatch::default()), base);
    }

    // --- tag definitions (ADR-119) ---

    fn tag(name: &str, palette_index: usize) -> Value {
        json!({ "name": name, "color": TAG_PALETTE[palette_index].0 })
    }

    #[test]
    fn a_tag_patch_is_validated_and_names_are_trimmed() {
        let patch = SettingsPatch::from_value(
            &json!({ "tags": [tag("  Methods\u{200B} ", 0), tag("Théorie", 4)] }),
        )
        .unwrap();
        let tags = patch.tags.unwrap();
        assert_eq!(tags[0].name, "Methods");
        assert_eq!(tags[1].name, "Théorie");
        assert!(SettingsPatch::from_value(&json!({ "tags": [] }))
            .unwrap()
            .tags
            .unwrap()
            .is_empty());
        let longest = "ä".repeat(limits::TAG_NAME_MAX);
        assert!(SettingsPatch::from_value(&json!({ "tags": [tag(&longest, 1)] })).is_ok());
        let exact: Vec<Value> = (0..limits::TAGS_MAX)
            .map(|n| tag(&format!("t{n}"), n % 5))
            .collect();
        assert!(SettingsPatch::from_value(&json!({ "tags": exact })).is_ok());
    }

    #[test]
    fn a_bad_tag_list_is_refused_whole_as_invalid_tags() {
        let too_long = "a".repeat(limits::TAG_NAME_MAX + 1);
        let many: Vec<Value> = (0..=limits::TAGS_MAX)
            .map(|n| tag(&format!("t{n}"), 0))
            .collect();
        let bad_lists = [
            json!([tag("", 0)]),
            json!([tag("   ", 0)]),
            json!([tag("\u{200B}", 0)]),
            json!([tag(&too_long, 0)]),
            json!([tag("a\nb", 0)]),
            json!([tag("a\u{0}", 0)]),
            json!([tag("a\u{7f}", 0)]),
            json!([tag("Same", 0), tag("same", 1)]),
            json!([tag("Straße", 0), tag("STRASSE", 1), tag("straße", 2)]),
            json!([{ "name": "x", "color": [1, 2, 3] }]),
            json!([{ "name": "x", "color": [255, 248, 78] }]),
            json!([{ "name": "x" }]),
            json!([{ "name": 5, "color": TAG_PALETTE[0].0 }]),
            json!(many),
            json!(null),
            json!("tag"),
            json!({ "name": "x" }),
        ];
        for bad in bad_lists {
            assert_eq!(
                rejected(json!({ "tags": bad.clone() })),
                r#"{"code":"invalid_argument","key":"error.invalid_argument","retryable":false,"params":{"what":"tags"}}"#,
                "{bad}"
            );
        }
        // Another bad field still says "settings".
        assert_eq!(
            rejected(json!({ "language": "x", "tags": [] })),
            INVALID_SETTINGS
        );
    }

    #[test]
    fn stored_tags_drop_invalid_entries_and_never_fail_the_load() {
        let too_long = "a".repeat(limits::TAG_NAME_MAX + 1);
        let stored = json!({
            "language": "de",
            "tags": [
                tag("Keep", 0), tag("keep", 1), tag(&too_long, 2), tag("a\nb", 0), tag(" Trim ", 3),
                { "name": "x", "color": [1, 2, 3] }, 7, null, { "color": TAG_PALETTE[0].0 }, tag("Last", 4)
            ]
        })
        .to_string();
        let settings = Settings::from_stored(stored.as_bytes());
        assert_eq!(settings.language, Language::De);
        let names: Vec<&str> = settings.tags.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(names, ["Keep", "Trim", "Last"]);
        // Not a list: no tags, the other fields stay.
        for stored in [
            r#"{"language":"de","tags":"x"}"#,
            r#"{"language":"de","tags":{}}"#,
            r#"{"language":"de","tags":null}"#,
        ] {
            let settings = Settings::from_stored(stored.as_bytes());
            assert!(settings.tags.is_empty());
            assert_eq!(settings.language, Language::De);
        }
        // More than the limit: the first TAGS_MAX valid ones are kept.
        let many: Vec<Value> = (0..limits::TAGS_MAX + 10)
            .map(|n| tag(&format!("t{n}"), 0))
            .collect();
        let settings = Settings::from_stored(json!({ "tags": many }).to_string().as_bytes());
        assert_eq!(settings.tags.len(), limits::TAGS_MAX);
        assert_eq!(settings.tags[0].name, "t0");
    }

    #[test]
    fn tags_are_persisted_replaced_and_kept_by_other_updates() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        apply_json(&store, json!({ "tags": [tag("A", 0), tag("B", 1)] })).unwrap();
        assert_eq!(store_in(&dir).get().tags.len(), 2);
        apply_json(&store, json!({ "language": "en" })).unwrap();
        assert_eq!(store_in(&dir).get().tags.len(), 2);
        let before = fs::read(dir.path().join(FILE_NAME)).unwrap();
        assert!(apply_json(&store, json!({ "tags": [tag("A", 0), tag("a", 1)] })).is_err());
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before);
        apply_json(&store, json!({ "tags": [tag("C", 2)] })).unwrap();
        let tags = store_in(&dir).get().tags;
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "C");
        assert_eq!(tags[0].color, TAG_PALETTE[2]);
    }

    // --- loading ---

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = TempDir::new();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn damaged_files_give_the_defaults() {
        for contents in [
            &b""[..],
            b"not json",
            b"[]",
            b"null",
            b"{\"glass\":",
            &[0xff, 0xfe, 0x00],
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get(), Settings::default(), "{contents:?}");
        }
    }

    #[test]
    fn invalid_fields_fall_back_one_by_one() {
        let dir = TempDir::new();
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"glass":"frosted","language":"de","leftPanelWidth":9999,"future":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            store_in(&dir).get(),
            Settings {
                language: Language::De,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn a_stored_panel_width_is_read_only_inside_the_range() {
        for (contents, expected) in [
            (r#"{"leftPanelWidth":200}"#, 200),
            (r#"{"leftPanelWidth":320}"#, 320),
            (r#"{"leftPanelWidth":480}"#, 480),
            // Out of range, wrong type or missing: the default, never a clamped guess.
            (r#"{"leftPanelWidth":199}"#, 220),
            (r#"{"leftPanelWidth":481}"#, 220),
            (r#"{"leftPanelWidth":-1}"#, 220),
            (r#"{"leftPanelWidth":300.5}"#, 220),
            (r#"{"leftPanelWidth":"300"}"#, 220),
            (r#"{"leftPanelWidth":null}"#, 220),
            (r#"{"left_panel_width":300}"#, 220),
            (r#"{}"#, 220),
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(
                store_in(&dir).get().left_panel_width.get(),
                expected,
                "{contents}"
            );
        }
    }

    #[test]
    fn an_oversized_file_is_not_read() {
        let dir = TempDir::new();
        let padding = " ".repeat(usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap());
        fs::write(
            dir.path().join(FILE_NAME),
            format!(r#"{{"language":"de"}}{padding}"#),
        )
        .unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
        // Exactly at the limit is still read.
        let padding = " ".repeat(usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap() - 17);
        fs::write(
            dir.path().join(FILE_NAME),
            format!(r#"{{"language":"de"}}{padding}"#),
        )
        .unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);
    }

    // --- updating and persisting ---

    #[test]
    fn updates_are_persisted_and_survive_a_restart() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        let updated = store
            .update(patch(json!({ "language": "de", "leftPanelWidth": 280 })).unwrap())
            .unwrap();
        assert_eq!(
            updated,
            Settings {
                language: Language::De,
                left_panel_width: PanelWidth::new(280).unwrap(),
                inspector_width: InspectorWidth::default(),
                welcome_tour: WelcomeTour::Pending,
                author_name: AuthorName::default(),
                author_prompt: AuthorPrompt::Pending,
                updates: UpdatesMode::Off,
                skipped_version: SkippedVersion::default(),
                tips_seen: TipsSeen::default(),
                page_sidebar_collapsed: false,
                tips_enabled: true,
                show_tool_labels: false,
                tags: Vec::new(),
            }
        );
        assert_eq!(store.get(), updated);
        assert_eq!(store_in(&dir).get(), updated);

        let stored: Value =
            serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({ "language": "de", "leftPanelWidth": 280, "inspectorWidth": 300, "welcomeTour": "pending", "authorName": "", "authorPrompt": "pending", "updates": "off", "skippedVersion": null, "tipsSeen": [], "pageSidebarCollapsed": false, "tipsEnabled": true, "showToolLabels": false, "tags": [] })
        );
    }

    #[test]
    fn a_partial_update_keeps_the_other_field() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        store
            .update(patch(json!({ "language": "en" })).unwrap())
            .unwrap();
        let updated = store
            .update(patch(json!({ "updates": "on" })).unwrap())
            .unwrap();
        assert_eq!(
            updated,
            Settings {
                updates: UpdatesMode::On,
                language: Language::En,
                ..Settings::default()
            }
        );
        assert_eq!(store_in(&dir).get(), updated);
    }

    #[test]
    fn writing_leaves_only_the_settings_file_behind() {
        let dir = TempDir::new();
        store_in(&dir)
            .update(patch(json!({ "language": "de" })).unwrap())
            .unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[test]
    fn an_unchanged_update_does_not_touch_the_disk() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        store.update(SettingsPatch::default()).unwrap();
        store
            .update(patch(json!({ "language": "system" })).unwrap())
            .unwrap();
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn a_failed_write_changes_nothing_in_memory() {
        let dir = TempDir::new();
        // The settings "file" is a non-empty directory, so the final rename cannot succeed.
        let path = dir.path().join(FILE_NAME);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("child"), b"x").unwrap();
        let store = SettingsStore::load(path);
        assert_eq!(store.get(), Settings::default());
        let error = store
            .update(patch(json!({ "language": "de" })).unwrap())
            .unwrap_err();
        assert_ne!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(store.get(), Settings::default());
    }

    // --- loading: only regular files are opened ---

    #[test]
    fn a_directory_at_the_settings_path_gives_the_defaults() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn read_bounded_refuses_anything_but_a_regular_file() {
        let dir = TempDir::new();
        // A directory is damaged data, not "first start": the difference decides whether the load is logged.
        let error = read_bounded(dir.path()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let error = read_bounded(&dir.path().join("missing.json")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        let file = dir.path().join(FILE_NAME);
        fs::write(&file, b"{}").unwrap();
        assert_eq!(read_bounded(&file).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_at_the_settings_path_does_not_block_the_load() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        // mkfifo(1) instead of `libc::mkfifo`, which is an unsafe call and `unsafe_code` is forbidden (the open flags above
        // come from libc as plain constants). Where mkfifo is missing there is nothing to test.
        let made = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .is_ok_and(|status| status.success());
        if !made {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(SettingsStore::load(path).get());
        });
        // A plain `open` of a FIFO that nobody writes to blocks for ever, so the load runs on its own thread.
        let settings = receiver
            .recv_timeout(WAIT)
            .expect("load returned without opening the FIFO");
        assert_eq!(settings, Settings::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_device_is_turned_down_without_being_read() {
        // `/dev/zero` never ends: reading it would only stop at the size cap, and it must not even get that far.
        let error = read_bounded(Path::new("/dev/zero")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[cfg(unix)]
    #[test]
    fn the_type_is_taken_from_the_opened_handle_not_from_the_path() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"{}").unwrap();
        let handle = open_without_blocking(&path).unwrap();
        // The path now names something else: what could be swapped in between a check of the path and an open of it.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_regular(handle).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_regular_file_is_read() {
        let dir = TempDir::new();
        let real = dir.path().join("real.json");
        fs::write(&real, br#"{"language":"de"}"#).unwrap();
        let link = dir.path().join(FILE_NAME);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(SettingsStore::load(link).get().language, Language::De);
    }

    // --- hardening: unknown keys, odd files, the whole path from the webview to the file ---

    /// What the `update_settings` command does: validate the whole patch, then persist it.
    fn apply_json(store: &SettingsStore, value: Value) -> Result<Settings, AppError> {
        store.update(SettingsPatch::from_value(&value)?)
    }

    #[test]
    fn a_patch_with_an_unknown_key_applies_nothing_and_never_touches_the_file() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        // Nothing stored yet: a rejected patch must not create the file either.
        for bad in [
            json!({ "colour": "red" }),
            json!({ "language": "de", "colour": "red" }),
            json!({ "updates": "on", "language": "de", "extra": null }),
            json!({ "language": "neon" }),
            json!(["theme", "dark"]),
        ] {
            let error = apply_json(&store, bad).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument);
        }
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(store.get(), Settings::default());

        // With a stored file: the same, byte for byte.
        apply_json(&store, json!({ "language": "en" })).unwrap();
        let before = fs::read(dir.path().join(FILE_NAME)).unwrap();
        let error =
            apply_json(&store, json!({ "updates": "on", "language": "de", "x": 1 })).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before);
        assert_eq!(store.get().language, Language::En);
        assert_eq!(store.get().updates, UpdatesMode::Off);
    }

    #[test]
    fn the_stored_file_holds_exactly_the_five_settings_as_json_with_a_final_newline() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        apply_json(&store, json!({ "updates": "on" })).unwrap();
        let bytes = fs::read(dir.path().join(FILE_NAME)).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        let stored: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            stored,
            json!({ "language": "system", "leftPanelWidth": 220, "inspectorWidth": 300, "welcomeTour": "pending", "authorName": "", "authorPrompt": "pending", "updates": "on", "skippedVersion": null, "tipsSeen": [], "pageSidebarCollapsed": false, "tipsEnabled": true, "showToolLabels": false, "tags": [] })
        );
    }

    #[test]
    fn the_language_is_persisted_and_read_back_field_by_field() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        assert_eq!(store.get().language, Language::System);
        apply_json(&store, json!({ "language": "de" })).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);
        // A partial update of another field keeps the language.
        apply_json(&store, json!({ "updates": "on" })).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);

        for (contents, expected) in [
            (r#"{"language":"en"}"#, Language::En),
            (r#"{"language":"system"}"#, Language::System),
            // Invalid, mistyped or missing: the default, never a guess.
            (r#"{"language":"De"}"#, Language::System),
            (r#"{"language":"de-DE"}"#, Language::System),
            (r#"{"language":"fr"}"#, Language::System),
            (r#"{"language":null}"#, Language::System),
            (r#"{"language":["de"]}"#, Language::System),
            (r#"{"Language":"de"}"#, Language::System),
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get().language, expected, "{contents}");
        }
    }

    #[test]
    fn fields_of_the_wrong_type_or_spelling_fall_back_to_the_defaults() {
        for contents in [
            r#"{"glass":null,"theme":["dark"]}"#,
            r#"{"glass":1,"theme":{"x":"dark"}}"#,
            r#"{"Glass":"solid","THEME":"dark"}"#,
            r#"{"glass":"Solid","theme":"DARK"}"#,
            r#"{"settings":{"updates":"on","language":"de"}}"#,
            r#"{"LeftPanelWidth":300}"#,
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get(), Settings::default(), "{contents}");
        }
    }

    #[test]
    fn a_file_with_anything_after_the_json_is_damaged_as_a_whole() {
        let dir = TempDir::new();
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"updates":"on","language":"de"} trailing"#,
        )
        .unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn a_file_one_byte_over_the_limit_is_not_read() {
        let dir = TempDir::new();
        let limit = usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap();
        let mut bytes = br#"{"language":"de"}"#.to_vec();
        bytes.resize(limit, b' ');
        fs::write(dir.path().join(FILE_NAME), &bytes).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);
        bytes.push(b' ');
        fs::write(dir.path().join(FILE_NAME), &bytes).unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn an_update_heals_a_damaged_file_and_creates_a_missing_directory() {
        let dir = TempDir::new();
        fs::write(dir.path().join(FILE_NAME), b"not json").unwrap();
        let store = store_in(&dir);
        apply_json(&store, json!({ "language": "de" })).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);

        let nested = dir.path().join("first").join("run").join(FILE_NAME);
        let store = SettingsStore::load(nested.clone());
        assert_eq!(store.get(), Settings::default());
        apply_json(&store, json!({ "updates": "on" })).unwrap();
        assert_eq!(SettingsStore::load(nested).get().updates, UpdatesMode::On);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_or_to_nothing_gives_the_defaults() {
        let dir = TempDir::new();
        let target_dir = dir.path().join("a-directory");
        fs::create_dir(&target_dir).unwrap();
        let link = dir.path().join(FILE_NAME);
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();
        assert_eq!(SettingsStore::load(link.clone()).get(), Settings::default());
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), &link).unwrap();
        assert_eq!(SettingsStore::load(link).get(), Settings::default());
    }

    // --- locking: reads do not wait for the disk, writes are serialised ---

    /// Upper bound for a step that should be instant. A failure shows up as a timeout instead of a hung test run.
    const WAIT: Duration = Duration::from_secs(10);

    /// A persisting step that signals `started`, then stays open until `release` fires.
    fn held_open(
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> impl FnOnce(&[u8]) -> io::Result<()> {
        move |_| {
            started.send(()).unwrap();
            release
                .recv_timeout(WAIT)
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))
        }
    }

    #[test]
    fn get_does_not_wait_for_a_write_in_progress() {
        let dir = TempDir::new();
        let store = Arc::new(store_in(&dir));
        let (started_sender, started) = mpsc::channel();
        let (release_sender, release) = mpsc::channel();
        let writer = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store.update_with(
                    patch(json!({ "language": "de" })).unwrap(),
                    held_open(started_sender, release),
                )
            })
        };
        started.recv_timeout(WAIT).expect("the write started");

        // The write is open (it would be inside fsync or rename). `get` runs on its own thread, so a lock that blocks
        // it fails the test with a timeout.
        let (answer_sender, answer) = mpsc::channel();
        let reader = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                let _ = answer_sender.send(store.get());
            })
        };
        let during = answer
            .recv_timeout(WAIT)
            .expect("get answered while the write was open");
        // Nothing is persisted yet, so memory still holds the old settings.
        assert_eq!(during, Settings::default());

        release_sender.send(()).unwrap();
        let updated = writer.join().unwrap().unwrap();
        reader.join().unwrap();
        assert_eq!(updated.language, Language::De);
        assert_eq!(store.get(), updated);
    }

    #[test]
    fn a_second_update_waits_for_the_first_and_builds_on_it() {
        let dir = TempDir::new();
        let store = Arc::new(store_in(&dir));
        let (started_sender, started) = mpsc::channel();
        let (release_sender, release) = mpsc::channel();
        let first = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store.update_with(
                    patch(json!({ "language": "de" })).unwrap(),
                    held_open(started_sender, release),
                )
            })
        };
        started.recv_timeout(WAIT).expect("the first write started");

        let (done_sender, done) = mpsc::channel();
        let second = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                let result = store.update(patch(json!({ "updates": "on" })).unwrap());
                let _ = done_sender.send(());
                result
            })
        };
        // The second update is queued behind the first. A pause cannot make this fail wrongly, only catch a bug.
        assert!(done.recv_timeout(Duration::from_millis(200)).is_err());

        release_sender.send(()).unwrap();
        first.join().unwrap().unwrap();
        let both = second.join().unwrap().unwrap();
        let expected = Settings {
            updates: UpdatesMode::On,
            language: Language::De,
            ..Settings::default()
        };
        assert_eq!(both, expected);
        assert_eq!(store.get(), expected);
        assert_eq!(store_in(&dir).get(), expected);
    }

    #[test]
    fn a_failed_persist_leaves_memory_alone_and_the_next_update_works() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        let error = store
            .update_with(patch(json!({ "language": "de" })).unwrap(), |_| {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            })
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::IoPermissionDenied);
        assert_eq!(store.get(), Settings::default());
        // The writer lock was released: a later update goes through.
        let updated = store
            .update(patch(json!({ "language": "en" })).unwrap())
            .unwrap();
        assert_eq!(updated.language, Language::En);
    }

    // --- retired keys (light-only redesign, ADR-100) ---

    #[test]
    fn a_file_with_the_retired_theme_and_glass_keys_loads_and_loses_them_at_startup() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            br#"{"glass":"solid","theme":"dark","language":"de"}"#,
        )
        .unwrap();
        let store = store_in(&dir);
        assert_eq!(store.get().language, Language::De);
        store.drop_retired_keys().unwrap();
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let object = stored.as_object().unwrap();
        assert!(!object.contains_key("glass") && !object.contains_key("theme"));
        assert_eq!(object["language"], "de");
        // Nothing is left to do the second time, and nothing is rewritten.
        let before = fs::read(&path).unwrap();
        store.drop_retired_keys().unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_file_without_retired_keys_is_not_touched_at_startup() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        let text = br#"{"language":"de"}"#;
        fs::write(&path, text).unwrap();
        store_in(&dir).drop_retired_keys().unwrap();
        assert_eq!(fs::read(&path).unwrap(), text);
        // A missing file stays missing.
        let empty = TempDir::new();
        store_in(&empty).drop_retired_keys().unwrap();
        assert!(!empty.path().join(FILE_NAME).exists());
    }

    #[test]
    fn the_first_update_also_drops_the_retired_keys() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, br#"{"theme":"light"}"#).unwrap();
        let store = store_in(&dir);
        store
            .update(patch(json!({ "language": "en" })).unwrap())
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("theme"));
        store.drop_retired_keys().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn the_retired_keys_are_not_valid_in_a_patch() {
        assert_eq!(rejected(json!({ "theme": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "glass": "solid" })), INVALID_SETTINGS);
    }
}
