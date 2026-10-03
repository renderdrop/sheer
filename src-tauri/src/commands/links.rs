//! `get_page_links` and `open_link`: the links of a page, and the one the user chooses (ARCHITECTURE §5, SECURITY P2, P3).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_page_links` | `docId: number`, `pageId: number` | `LinkInfo[]`: `{ index, rect, target }`, at most 1 000, `target` is `{ type: "page", pageId, y }`, `{ type: "url", url }` or `{ type: "blocked" }` |
//! | `open_link` | `docId: number`, `pageId: number`, `linkIndex: number` | nothing |
//!
//! **Nothing a PDF asks for is done.** A link is read as data. A jump to a page of the document is a `page` target and the UI scrolls
//! there. A URL is a `url` target if it is plain `http`, `https` or `mailto` (`security::links`, at most 2048 bytes), and a link to
//! anything else (a program to launch, a jump to another file, JavaScript, any other scheme) is `blocked`: it is shown as a link
//! that does nothing, and `open_link` refuses it.
//!
//! **`open_link` takes no URL.** The UI names the link by its place (document, page, index); Rust reads the page's links again, takes
//! the URL from the document, shows a native dialog with that URL in full and asks whether to open it (the texts are the UI catalogs,
//! in the language of the UI), and only if the user says so hands it to the system's opener (`tauri-plugin-opener`, called from Rust
//! only: the webview has no permission for it). The URL that was shown is the URL that is opened: it is held in a [`SafeUrl`] from
//! the read to the opener, which takes nothing else. If the user declines, nothing happens and nothing is reported.

use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::engine::{LinkTarget as EngineTarget, PageLink};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::menu;
use crate::model::reading::{LinkInfo, LinkTarget};
use crate::security::links::{summarize, SafeUrl};

/// What `open_link` needs from the desktop: the question to the user, and the opener. A trait so the logic is tested without a window.
pub trait LinkUi {
    /// Shows the URL to the user and asks whether to open it. `true` if the user agrees.
    fn confirm(&self, url: &SafeUrl) -> bool;
    /// Opens the URL with the system's handler (the browser, the mail program).
    fn open(&self, url: &SafeUrl) -> Result<(), AppError>;
}

impl AppState {
    /// The links of a page of an open document. `invalid_argument` (`page`) for a page the document does not have.
    pub fn page_links(&self, id: DocumentId, page: PageId) -> Result<Vec<LinkInfo>, AppError> {
        let page_index = self.registry.page_index(id, page)?;
        let links = self.engine.page_links(id, page_index)?;
        Ok(links
            .iter()
            .take(limits::MAX_PAGE_LINKS)
            .zip(0u32..)
            .map(|(link, index)| self.link_info(id, index, link))
            .collect())
    }

    fn link_info(&self, id: DocumentId, index: u32, link: &PageLink) -> LinkInfo {
        let target = match &link.target {
            EngineTarget::Page(spot) => match self.registry.page_id(id, spot.page_index) {
                Ok(page_id) => LinkTarget::Page { page_id, y: spot.y },
                Err(_) => LinkTarget::Blocked,
            },
            EngineTarget::Url(url) => LinkTarget::Url {
                url: url.as_str().to_owned(),
            },
            EngineTarget::Blocked => LinkTarget::Blocked,
        };
        LinkInfo {
            index,
            rect: link.rect,
            target,
        }
    }

    /// Opens link `link_index` of a page, if it is a URL the app opens and the user confirms it on `ui`. The URL is read from the
    /// document here and nowhere else. `invalid_argument` (`link`) for a link that does not exist, or that goes to a page or is
    /// blocked (there is nothing to open).
    pub fn open_link(
        &self,
        id: DocumentId,
        page: PageId,
        link_index: u32,
        ui: &dyn LinkUi,
    ) -> Result<(), AppError> {
        let page_index = self.registry.page_index(id, page)?;
        let at = usize::try_from(link_index)
            .ok()
            .filter(|&at| at < limits::MAX_PAGE_LINKS)
            .ok_or_else(|| AppError::invalid("link"))?;
        let links = self.engine.page_links(id, page_index)?;
        let Some(PageLink {
            target: EngineTarget::Url(url),
            ..
        }) = links.get(at)
        else {
            return Err(AppError::invalid("link"));
        };
        if !ui.confirm(url) {
            return Ok(());
        }
        ui.open(url)
    }
}

/// The dialog and the opener of the desktop: a native message box over the window, and the system's handler for the URL.
struct DesktopLinkUi {
    window: WebviewWindow,
}

impl LinkUi for DesktopLinkUi {
    fn confirm(&self, url: &SafeUrl) -> bool {
        let app = self.window.app_handle();
        let locale = menu::ui_locale(app);
        let name = menu::app_name(app);
        let text = |key: &str| menu::spec::text(locale, key, &name);
        // `{url}` is filled in last, so that a URL that contains `{app}` stays what it is.
        let message = text("link.confirm.message").replace("{url}", &summarize(url).dialog_text());
        self.window
            .dialog()
            .message(message)
            .title(text("link.confirm.title"))
            .kind(MessageDialogKind::Warning)
            .parent(&self.window)
            .buttons(MessageDialogButtons::OkCancelCustom(
                text("link.confirm.open"),
                text("link.confirm.cancel"),
            ))
            .blocking_show()
    }

    fn open(&self, url: &SafeUrl) -> Result<(), AppError> {
        // The one place the opener is called, with the one kind of value it is given here. Its error can contain the URL, which is
        // content of the document, so it is not logged.
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|_| {
            AppError::logged(ErrorCode::Internal, "the system could not open the link")
        })
    }
}

/// The links of a page: where each can be clicked and where it goes.
#[tauri::command]
pub async fn get_page_links(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<Vec<LinkInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.page_links(doc_id, page_id)).await
}

/// Opens a link of a page after the user confirmed its URL in a native dialog. The UI names the link; the URL comes from the document.
#[tauri::command]
pub async fn open_link(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
    link_index: u32,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.open_link(doc_id, page_id, link_index, &DesktopLinkUi { window })).await
}
#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::{Job, PageSpot};
    use crate::model::geometry::Rect;
    use crate::security::links::classify;

    fn rect() -> Rect {
        Rect {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
        }
    }

    fn url(text: &str) -> EngineTarget {
        EngineTarget::Url(classify(text).expect("a URL the allowlist takes"))
    }

    /// A state whose engine answers `get_page_links` with `links` and counts how often it was asked.
    fn state_with_links(
        pages: u32,
        links: Vec<EngineTarget>,
    ) -> (AppState, DocumentId, Arc<Mutex<u32>>) {
        let asked = Arc::new(Mutex::new(0));
        let count = Arc::clone(&asked);
        let (state, id) = state_with_pages(pages, move |job| {
            if let Job::PageLinks { reply, .. } = job {
                *count.lock().unwrap() += 1;
                let links = links
                    .iter()
                    .map(|target| PageLink {
                        rect: rect(),
                        target: target.clone(),
                    })
                    .collect();
                let _ = reply.send(Ok(links));
            }
        });
        (state, id, asked)
    }

    /// The dialog and the opener of the desktop, replaced: it answers the question with `agree` and writes down what it was asked
    /// and told.
    struct RecordingUi {
        agree: bool,
        shown: Mutex<Vec<String>>,
        opened: Mutex<Vec<String>>,
        fail: bool,
    }

    impl RecordingUi {
        fn new(agree: bool) -> Self {
            Self {
                agree,
                shown: Mutex::default(),
                opened: Mutex::default(),
                fail: false,
            }
        }
    }

    impl LinkUi for RecordingUi {
        fn confirm(&self, url: &SafeUrl) -> bool {
            self.shown.lock().unwrap().push(url.as_str().to_owned());
            self.agree
        }

        fn open(&self, url: &SafeUrl) -> Result<(), AppError> {
            self.opened.lock().unwrap().push(url.as_str().to_owned());
            if self.fail {
                Err(AppError::new(ErrorCode::Internal))
            } else {
                Ok(())
            }
        }
    }

    // --- get_page_links ---

    #[test]
    fn links_have_their_place_in_the_list_as_index_and_their_target_by_kind() {
        let (state, id, _) = state_with_links(
            3,
            vec![
                EngineTarget::Page(PageSpot {
                    page_index: 2,
                    y: 100.0,
                }),
                url("https://example.com/docs"),
                EngineTarget::Blocked,
            ],
        );
        let links = state.page_links(id, PageId::new(0)).unwrap();
        assert_eq!(links.len(), 3);
        assert_eq!(
            links.iter().map(|link| link.index).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(
            links[0].target,
            LinkTarget::Page {
                page_id: PageId::new(2),
                y: 100.0
            }
        );
        assert_eq!(
            links[1].target,
            LinkTarget::Url {
                url: "https://example.com/docs".to_owned()
            }
        );
        assert_eq!(links[2].target, LinkTarget::Blocked);
        assert_eq!(links[0].rect, rect());
    }

    #[test]
    fn a_jump_to_a_page_the_document_does_not_have_is_blocked() {
        let (state, id, _) = state_with_links(
            2,
            vec![EngineTarget::Page(PageSpot {
                page_index: 9,
                y: 0.0,
            })],
        );
        assert_eq!(
            state.page_links(id, PageId::new(0)).unwrap()[0].target,
            LinkTarget::Blocked
        );
    }

    #[test]
    fn at_most_1000_links_are_sent_whatever_the_engine_hands_over() {
        let (state, id, _) = state_with_links(
            1,
            (0..limits::MAX_PAGE_LINKS + 300)
                .map(|_| EngineTarget::Blocked)
                .collect(),
        );
        let links = state.page_links(id, PageId::new(0)).unwrap();
        assert_eq!(links.len(), limits::MAX_PAGE_LINKS);
        assert_eq!(links.last().unwrap().index, 999);
    }

    #[test]
    fn a_page_the_document_does_not_have_is_refused_before_the_engine_is_asked() {
        let (state, id, asked) = state_with_links(2, vec![EngineTarget::Blocked]);
        assert_eq!(
            state.page_links(id, PageId::new(2)).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .page_links(unknown, PageId::new(0))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(*asked.lock().unwrap(), 0);
    }

    // --- open_link ---

    #[test]
    fn a_confirmed_url_is_opened_once_and_it_is_the_url_that_was_shown() {
        let (state, id, asked) = state_with_links(
            1,
            vec![
                EngineTarget::Blocked,
                url("https://example.com/a?b=c"),
                url("mailto:team@example.com"),
            ],
        );
        let ui = RecordingUi::new(true);
        state.open_link(id, PageId::new(0), 1, &ui).unwrap();
        assert_eq!(*ui.shown.lock().unwrap(), ["https://example.com/a?b=c"]);
        assert_eq!(*ui.opened.lock().unwrap(), ["https://example.com/a?b=c"]);
        // The URL is read from the document on each call, not remembered from the list.
        assert_eq!(*asked.lock().unwrap(), 1);
        state.open_link(id, PageId::new(0), 2, &ui).unwrap();
        assert_eq!(
            ui.opened.lock().unwrap().last().unwrap(),
            "mailto:team@example.com"
        );
        assert_eq!(*asked.lock().unwrap(), 2);
    }

    #[test]
    fn a_url_the_user_declines_is_not_opened_and_it_is_not_an_error() {
        let (state, id, _) = state_with_links(1, vec![url("https://example.com/")]);
        let ui = RecordingUi::new(false);
        state.open_link(id, PageId::new(0), 0, &ui).unwrap();
        assert_eq!(ui.shown.lock().unwrap().len(), 1);
        assert!(ui.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn a_link_that_goes_to_a_page_or_is_blocked_has_nothing_to_open_and_the_user_is_not_asked() {
        let (state, id, _) = state_with_links(
            2,
            vec![
                EngineTarget::Page(PageSpot {
                    page_index: 1,
                    y: 0.0,
                }),
                EngineTarget::Blocked,
            ],
        );
        let ui = RecordingUi::new(true);
        for index in [0, 1] {
            let error = state.open_link(id, PageId::new(0), index, &ui).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument, "{index}");
        }
        assert!(ui.shown.lock().unwrap().is_empty());
        assert!(ui.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn a_link_that_does_not_exist_is_refused() {
        let (state, id, asked) = state_with_links(1, vec![url("https://example.com/")]);
        let ui = RecordingUi::new(true);
        // Past the end of the list, past the limit, and a number that is not an index at all.
        for index in [1, 999, 1000, 100_000, u32::MAX] {
            let error = state.open_link(id, PageId::new(0), index, &ui).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument, "{index}");
        }
        // The limit is checked before the engine is asked: only the two indices below it reached the engine.
        assert_eq!(*asked.lock().unwrap(), 2);
        assert!(ui.shown.lock().unwrap().is_empty());

        let error = state.open_link(id, PageId::new(5), 0, &ui).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .open_link(unknown, PageId::new(0), 0, &ui)
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_failure_of_the_opener_is_reported_and_the_user_was_asked_first() {
        let (state, id, _) = state_with_links(1, vec![url("https://example.com/")]);
        let mut ui = RecordingUi::new(true);
        ui.fail = true;
        let error = state.open_link(id, PageId::new(0), 0, &ui).unwrap_err();
        assert_eq!(error.code(), ErrorCode::Internal);
        assert_eq!(ui.shown.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_dialog_texts_are_in_the_ui_catalogs_in_both_languages_with_a_place_for_the_url() {
        use crate::menu::spec::{text, MenuLocale};
        for locale in MenuLocale::ALL {
            for key in [
                "link.confirm.title",
                "link.confirm.message",
                "link.confirm.open",
                "link.confirm.cancel",
            ] {
                // A key the catalog lacks comes back as the key itself.
                assert_ne!(text(locale, key, "Sheer"), key, "{locale:?} {key}");
            }
            let message = text(locale, "link.confirm.message", "Sheer");
            assert!(message.contains("{url}"), "{locale:?}: {message}");
            assert!(
                message.contains("Sheer") && !message.contains("{app}"),
                "{locale:?}: {message}"
            );
            // The URL is filled in after the app name, so a URL that says `{app}` is shown as it is.
            let shown = message.replace("{url}", "https://example.com/{app}");
            assert!(shown.contains("https://example.com/{app}"));
        }
    }

    #[test]
    fn the_opener_and_the_dialog_take_nothing_but_a_classified_url() {
        // `SafeUrl` has no public constructor: the only way to one is `classify`, so `LinkUi` cannot be handed a string.
        assert!(classify("file:///C:/Windows/System32/calc.exe").is_none());
        assert!(classify("javascript:alert(1)").is_none());
        assert!(classify("https://example.com/").is_some());
    }
}
