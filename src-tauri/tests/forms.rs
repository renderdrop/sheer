//! Filling AcroForms (ADR-041, M4 package S1) against the real PDFium, through the same `AppState` the commands use: the field tree is
//! read, values are set through `apply_command` (undo, redo, limits, read-only), saved incrementally with regenerated appearances,
//! and the saved file is read again by lopdf and rendered by PDFium. A hostile form never panics. Skips, like the other engine tests,
//! when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::save::{SaveAck, SaveWarning};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::form::{
    FieldId, FieldKind, FieldSync, FieldValue, FormField, FormInfo, ReadForm, Xfa,
};
use sheer_lib::pdfwrite::forms::{read_fields, write_values};
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-forms-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn data_dir() -> &'static Path {
    static DIR: OnceLock<Scratch> = OnceLock::new();
    &DIR.get_or_init(|| Scratch::new("data")).0
}

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                Some(AppState::new(Engine::start(library)).with_data_dir(data_dir().to_owned()))
            } else {
                eprintln!("skipping the form tests: {} not found", library.display());
                None
            }
        })
        .as_ref()
}

// --- Fixtures ----------------------------------------------------------------------------------------------------------

const ON_OFF: &str = "/Type /XObject /Subtype /Form /BBox [0 0 12 12]";

/// Two pages. Page 0: text `name` ("Ada", with a background and border), `code` (max 5), read-only `ro`, check box `agree`, radio
/// group `color` (on-states A and B), combo `country`, multi-select list `langs`. Page 1: text `second`.
fn form() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new("")
                .with("/Annots [100 0 R 101 0 R 102 0 R 103 0 R 105 0 R 106 0 R 107 0 R 108 0 R]"),
            Page::new("").with("/Annots [109 0 R]"),
        ],
    );
    let p0 = page_id(0);
    let p1 = page_id(1);
    let widget = |extra: &str, page: u32| {
        format!("<< /Type /Annot /Subtype /Widget /P {page} 0 R /F 4 {extra} >>")
    };
    builder
        .object(
            100,
            &widget(
                "/FT /Tx /T (name) /V (Ada) /Rect [72 700 272 720] /DA (/Helv 12 Tf 0 0 1 rg) /MK << /BG [1 1 1] /BC [0 0 0] >> /TU (Your name)",
                p0,
            ),
        )
        .object(101, &widget("/FT /Tx /T (code) /MaxLen 5 /Rect [72 670 172 690]", p0))
        .object(102, &widget("/FT /Tx /T (ro) /Ff 1 /V (fixed) /Rect [72 640 172 660]", p0))
        .object(
            103,
            &widget(
                "/FT /Btn /T (agree) /V /Off /AS /Off /Rect [72 600 84 612] /AP << /N << /Yes 120 0 R /Off 121 0 R >> >>",
                p0,
            ),
        )
        .object(104, "<< /FT /Btn /Ff 32768 /T (color) /Kids [105 0 R 106 0 R] /V /Off >>")
        .object(
            105,
            &widget(
                "/Parent 104 0 R /Rect [72 570 84 582] /AS /Off /AP << /N << /A 120 0 R /Off 121 0 R >> >>",
                p0,
            ),
        )
        .object(
            106,
            &widget(
                "/Parent 104 0 R /Rect [100 570 112 582] /AS /Off /AP << /N << /B 120 0 R /Off 121 0 R >> >>",
                p0,
            ),
        )
        .object(
            107,
            &widget(
                "/FT /Ch /Ff 131072 /T (country) /V (de) /Opt [(de) (fr) [(us) (United States)]] /Rect [72 520 200 540]",
                p0,
            ),
        )
        .object(
            108,
            &widget(
                "/FT /Ch /Ff 2097152 /T (langs) /Opt [(en) (de) (fr) (es)] /Rect [72 420 200 500]",
                p0,
            ),
        )
        .object(109, &widget("/FT /Tx /T (second) /Rect [72 700 272 720]", p1))
        .stream(120, ON_OFF, b"0 0 12 12 re f")
        .stream(121, ON_OFF, b"")
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R 101 0 R 102 0 R 103 0 R 104 0 R 107 0 R 108 0 R 109 0 R] /DA (/Helv 0 Tf 0 g) >> >>",
        );
    builder.finish(1)
}

fn hybrid() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("").with("/Annots [100 0 R]")]);
    builder
        .object(
            100,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [72 700 272 720] /P {} 0 R >>",
                page_id(0)
            ),
        )
        .stream(101, "", b"<xdp:xdp xmlns:xdp=\"http://ns.adobe.com/xdp/\"></xdp:xdp>")
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] /XFA [(template) 101 0 R] >> >>",
        );
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> (DocumentId, PathBuf) {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    let info = state.open_path(path.clone()).unwrap().expect("loaded");
    (info.id, std::fs::canonicalize(path).unwrap())
}

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn set(
    state: &AppState,
    id: DocumentId,
    field: FieldId,
    value: serde_json::Value,
) -> Result<(), ErrorCode> {
    state
        .apply_command(
            id,
            command(json!({"type": "setFieldValue", "field": field.get(), "value": value})),
        )
        .map(|_| ())
        .map_err(|error| error.code())
}

fn by_name<'a>(info: &'a FormInfo, name: &str) -> &'a FormField {
    info.fields
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| panic!("no field {name}"))
}

fn text(value: &str) -> serde_json::Value {
    json!({"type": "text", "text": value})
}

fn render(state: &AppState, id: DocumentId, page: u32) -> (u32, u32, Vec<u8>) {
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(page),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap();
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(frame[12..16].try_into().unwrap());
    let decoder = png::Decoder::new(std::io::Cursor::new(&frame[16..]));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    (width, height, pixels)
}

/// Pixels darker than mid-gray in the page rectangle `[x, y, w, h]` of a frame rendered at bucket 0.
fn dark_pixels(frame: &(u32, u32, Vec<u8>), rect: [f32; 4]) -> usize {
    let scale = frame.0 as f32 / 612.0;
    let mut count = 0;
    for py in (rect[1] * scale) as usize..((rect[1] + rect[3]) * scale) as usize {
        for px in (rect[0] * scale) as usize..((rect[0] + rect[2]) * scale) as usize {
            let at = (py * frame.0 as usize + px) * 3;
            if frame.2[at] < 100 && frame.2[at + 1] < 100 {
                count += 1;
            }
        }
    }
    count
}

// --- Reading -----------------------------------------------------------------------------------------------------------

#[test]
fn the_field_tree_is_read_with_kinds_values_flags_rectangles_and_tab_order() {
    let read = read_fields(&form()).unwrap();
    assert_eq!(read.xfa, Xfa::None);
    assert!(!read.has_scripts && !read.need_appearances);
    let names: Vec<&str> = read.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        ["name", "code", "ro", "agree", "color", "country", "langs", "second"]
    );
    let field = |name: &str| read.fields.iter().find(|f| f.name == name).unwrap();

    let name = field("name");
    assert_eq!(name.value, FieldValue::Text { text: "Ada".into() });
    assert_eq!(name.tooltip.as_deref(), Some("Your name"));
    assert!(matches!(name.kind, FieldKind::Text { font_size, .. } if font_size == 12.0));
    let widget = &name.widgets[0];
    // PDF space [72 700 272 720] on a 792 pt page: top left (72, 72), 200 x 20, y down.
    assert_eq!(
        (widget.rect.x, widget.rect.y, widget.rect.w, widget.rect.h),
        (72.0, 72.0, 200.0, 20.0)
    );
    assert_eq!(widget.text_color.0, [0, 0, 255]);
    assert_eq!(widget.fill.map(|c| c.0), Some([255, 255, 255]));
    assert_eq!(widget.border.map(|c| c.0), Some([0, 0, 0]));

    assert!(matches!(
        field("code").kind,
        FieldKind::Text {
            max_len: Some(5),
            ..
        }
    ));
    assert!(field("ro").read_only);
    assert_eq!(field("agree").value, FieldValue::Checked { on: false });
    assert!(matches!(field("agree").kind, FieldKind::Checkbox));

    let color = field("color");
    assert_eq!(color.widgets.len(), 2);
    assert!(matches!(&color.kind, FieldKind::Radio { states, .. } if states == &["A", "B"]));
    assert_eq!(color.widgets[1].state, Some(1));
    assert_eq!(color.value, FieldValue::Radio { selected: None });

    let country = field("country");
    assert!(
        matches!(&country.kind, FieldKind::Choice { combo: true, options, .. }
        if options.len() == 3 && options[2].export == "us" && options[2].label == "United States")
    );
    assert_eq!(
        country.value,
        FieldValue::Choice {
            selected: vec!["de".into()],
            custom: None
        }
    );
    assert!(matches!(
        field("langs").kind,
        FieldKind::Choice {
            combo: false,
            multi_select: true,
            ..
        }
    ));

    // Tab order is the position among the widgets of a page, in the page's `/Annots` order here.
    let mut first_page: Vec<(u32, &str)> = read
        .fields
        .iter()
        .flat_map(|f| {
            f.widgets
                .iter()
                .filter(|w| w.pdf.file_page == 0)
                .map(|w| (w.tab_order, f.name.as_str()))
        })
        .collect();
    first_page.sort_unstable();
    assert_eq!(
        first_page
            .iter()
            .map(|(order, _)| *order)
            .collect::<Vec<_>>(),
        (0..8).collect::<Vec<_>>()
    );
    assert_eq!(first_page[0].1, "name");
    assert_eq!(field("second").widgets[0].tab_order, 0);
}

#[test]
fn pages_tabs_row_order_sorts_top_to_bottom_then_left_to_right() {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Tabs /R /Annots [100 0 R 101 0 R 102 0 R]")],
    );
    let p = page_id(0);
    for (n, (name, rect)) in (100u32..).zip([
        ("low", "[72 100 172 120]"),
        ("topright", "[300 700 400 720]"),
        ("topleft", "[72 700 172 720]"),
    ]) {
        builder.object(
            n,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Tx /T ({name}) /Rect {rect} /P {p} 0 R >>"
            ),
        );
    }
    builder.object(
        1,
        "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R 101 0 R 102 0 R] >> >>",
    );
    let read = read_fields(&builder.finish(1)).unwrap();
    let order =
        |name: &str| read.fields.iter().find(|f| f.name == name).unwrap().widgets[0].tab_order;
    assert_eq!(
        (order("topleft"), order("topright"), order("low")),
        (0, 1, 2)
    );
}

#[test]
fn a_hybrid_form_is_read_through_its_acroform_and_a_full_xfa_form_has_no_fields() {
    let read = read_fields(&hybrid()).unwrap();
    assert_eq!(read.xfa, Xfa::Hybrid);
    assert_eq!(read.fields.len(), 1);
    let full = read_fields(&support::fixtures::xfa()).unwrap();
    assert_eq!(full.xfa, Xfa::Full);
    assert!(full.fields.is_empty());
}

// --- Through the app state, with PDFium --------------------------------------------------------------------------------

#[test]
fn values_are_model_state_with_undo_redo_and_dirty() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("undo");
    let (id, _) = open(state, &scratch, "form.pdf", &form());
    let info = state.get_form_fields(id).unwrap();
    assert_eq!(info.fields.len(), 8);
    assert!(info.fields.iter().all(|f| f.sync == FieldSync::Clean));
    let name = by_name(&info, "name").id;
    let page = by_name(&info, "name").widgets[0].page_id;
    assert_eq!(page, PageId::new(0));
    assert_eq!(by_name(&info, "second").widgets[0].page_id, PageId::new(1));

    let changes = state
        .apply_command(
            id,
            command(json!({"type": "setFieldValue", "field": name.get(), "value": text("Grace"), "coalesce": format!("field:{}", name.get())})),
        )
        .unwrap();
    assert_eq!(changes.fields.len(), 1);
    assert_eq!(changes.fields[0].sync, FieldSync::Modified);
    assert!(changes.history.dirty && changes.history.can_undo);
    assert_eq!(changes.history.undo_label.as_deref(), Some("field.set"));
    // A second edit of the same field with the same key is the same undo step.
    state
        .apply_command(
            id,
            command(json!({"type": "setFieldValue", "field": name.get(), "value": text("Grace H"), "coalesce": format!("field:{}", name.get())})),
        )
        .unwrap();
    assert_eq!(
        by_name(&state.get_form_fields(id).unwrap(), "name").value,
        FieldValue::Text {
            text: "Grace H".into()
        }
    );
    let undone = state.undo(id).unwrap();
    assert_eq!(
        undone.fields[0].value,
        FieldValue::Text { text: "Ada".into() }
    );
    assert_eq!(undone.fields[0].sync, FieldSync::Clean);
    assert!(!undone.history.can_undo && undone.history.can_redo);
    let redone = state.redo(id).unwrap();
    assert_eq!(
        redone.fields[0].value,
        FieldValue::Text {
            text: "Grace H".into()
        }
    );
    assert_eq!(
        by_name(&state.get_form_fields(id).unwrap(), "name").sync,
        FieldSync::Modified
    );
}

#[test]
fn the_limits_and_read_only_are_enforced_and_nothing_changes_on_a_refusal() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("limits");
    let (id, _) = open(state, &scratch, "form.pdf", &form());
    let info = state.get_form_fields(id).unwrap();
    let code = by_name(&info, "code").id;
    let ro = by_name(&info, "ro").id;
    let agree = by_name(&info, "agree").id;
    let color = by_name(&info, "color").id;
    let country = by_name(&info, "country").id;
    let langs = by_name(&info, "langs").id;

    assert_eq!(
        set(state, id, code, text("123456")),
        Err(ErrorCode::InvalidArgument),
        "maxlen"
    );
    assert_eq!(set(state, id, code, text("12345")), Ok(()));
    assert_eq!(
        set(state, id, code, text("a\nb")),
        Err(ErrorCode::InvalidArgument),
        "line feed"
    );
    assert_eq!(
        set(state, id, code, text("\u{4E2D}")),
        Err(ErrorCode::InvalidArgument),
        "not winansi"
    );
    assert_eq!(
        set(state, id, ro, text("x")),
        Err(ErrorCode::InvalidArgument),
        "read-only"
    );
    assert_eq!(
        set(state, id, agree, json!({"type": "radio", "selected": 0})),
        Err(ErrorCode::InvalidArgument),
        "wrong type"
    );
    assert_eq!(
        set(state, id, color, json!({"type": "radio", "selected": 2})),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        set(
            state,
            id,
            country,
            json!({"type": "choice", "selected": ["zz"], "custom": null})
        ),
        Err(ErrorCode::InvalidArgument),
        "not an option"
    );
    assert_eq!(
        set(
            state,
            id,
            country,
            json!({"type": "choice", "selected": [], "custom": "free"})
        ),
        Err(ErrorCode::InvalidArgument),
        "not editable"
    );
    assert_eq!(
        set(
            state,
            id,
            country,
            json!({"type": "choice", "selected": ["fr", "us"], "custom": null})
        ),
        Err(ErrorCode::InvalidArgument),
        "single select"
    );
    assert_eq!(
        set(
            state,
            id,
            langs,
            json!({"type": "choice", "selected": ["en", "fr"], "custom": null})
        ),
        Ok(())
    );
    assert_eq!(
        set(state, id, FieldId::new(999), text("x")),
        Err(ErrorCode::NotFound)
    );
    let after = state.get_form_fields(id).unwrap();
    assert_eq!(
        by_name(&after, "ro").value,
        FieldValue::Text {
            text: "fixed".into()
        }
    );
    assert_eq!(
        by_name(&after, "code").value,
        FieldValue::Text {
            text: "12345".into()
        }
    );
    // A batch with one bad value does not change anything (reset is such a batch).
    let bad = command(json!({"type": "batch", "label": "form.reset", "commands": [
        {"type": "setFieldValue", "field": code.get(), "value": text("")},
        {"type": "setFieldValue", "field": ro.get(), "value": text("x")},
    ]}));
    assert_eq!(
        state.apply_command(id, bad).unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        by_name(&state.get_form_fields(id).unwrap(), "code").value,
        FieldValue::Text {
            text: "12345".into()
        }
    );
    let good = command(json!({"type": "batch", "label": "form.reset", "commands": [
        {"type": "setFieldValue", "field": code.get(), "value": text("")},
        {"type": "setFieldValue", "field": langs.get(), "value": {"type": "choice", "selected": [], "custom": null}},
    ]}));
    let changes = state.apply_command(id, good).unwrap();
    assert_eq!(changes.fields.len(), 2);
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.fields.len(), 2);
    assert_eq!(
        by_name(&state.get_form_fields(id).unwrap(), "code").value,
        FieldValue::Text {
            text: "12345".into()
        }
    );
}

#[test]
fn saving_writes_values_and_appearances_incrementally_and_pdfium_shows_them() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("save");
    let original = form();
    let (id, path) = open(state, &scratch, "form.pdf", &original);
    let before = render(state, id, 0);
    let info = state.get_form_fields(id).unwrap();
    let field = |name: &str| by_name(&info, name).id;
    set(state, id, field("name"), text("Gr\u{FC}n \u{20AC}")).unwrap();
    set(state, id, field("code"), text("AB")).unwrap();
    set(
        state,
        id,
        field("agree"),
        json!({"type": "checked", "on": true}),
    )
    .unwrap();
    set(
        state,
        id,
        field("color"),
        json!({"type": "radio", "selected": 1}),
    )
    .unwrap();
    set(
        state,
        id,
        field("country"),
        json!({"type": "choice", "selected": ["us"], "custom": null}),
    )
    .unwrap();
    set(
        state,
        id,
        field("langs"),
        json!({"type": "choice", "selected": ["de", "es"], "custom": null}),
    )
    .unwrap();
    set(state, id, field("second"), text("Page two")).unwrap();

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(saved.warnings.iter().all(|w| *w != SaveWarning::XfaRemoved));
    assert_eq!(saved.changes.fields.len(), 7);
    assert!(saved
        .changes
        .fields
        .iter()
        .all(|f| f.sync == FieldSync::Clean));
    assert!(!saved.changes.history.dirty);

    // The original bytes first, then the update; never NeedAppearances.
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..original.len()], original.as_slice());
    assert!(!String::from_utf8_lossy(&bytes[original.len()..]).contains("NeedAppearances"));

    // Read again: the values are in the file, and so are the appearances.
    let reread = read_fields(&bytes).unwrap();
    let value = |name: &str| {
        reread
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap()
            .value
            .clone()
    };
    assert_eq!(
        value("name"),
        FieldValue::Text {
            text: "Gr\u{FC}n \u{20AC}".into()
        }
    );
    assert_eq!(value("code"), FieldValue::Text { text: "AB".into() });
    assert_eq!(value("agree"), FieldValue::Checked { on: true });
    assert_eq!(value("color"), FieldValue::Radio { selected: Some(1) });
    assert_eq!(
        value("country"),
        FieldValue::Choice {
            selected: vec!["us".into()],
            custom: None
        }
    );
    assert_eq!(
        value("langs"),
        FieldValue::Choice {
            selected: vec!["de".into(), "es".into()],
            custom: None
        }
    );
    let look = |num: u32| sheer_lib::pdfwrite::forms::inspect_widget(&bytes, num).unwrap();
    let ap_content = |num: u32| look(num).appearance.unwrap();
    // "Grün €" in WinAnsi: G r ü n space euro.
    assert!(
        ap_content(100).contains("<4772FC6E2080> Tj"),
        "{}",
        ap_content(100)
    );
    assert!(ap_content(100).contains("/Tx BMC") && ap_content(100).contains("/Helv 12 Tf"));
    assert!(
        ap_content(100).contains("0 0 1 rg"),
        "the text colour of the /DA"
    );
    assert!(ap_content(101).contains("<4142> Tj"));
    assert!(ap_content(109).contains("<50616765"), "page two's field");
    assert!(
        ap_content(107).contains("<556E6974656420537461746573> Tj"),
        "the label of the choice"
    );
    assert!(
        ap_content(108).contains("re f"),
        "the highlighted rows of the list"
    );
    let state_of = |num: u32| look(num).state.unwrap();
    assert_eq!(state_of(103), "Yes");
    assert_eq!(
        (state_of(105), state_of(106)),
        ("Off".to_owned(), "B".to_owned())
    );
    assert_eq!(look(104).value.as_deref(), Some("B"));

    // PDFium reloaded the file: the name field now shows text, the check box is filled.
    assert!(
        dark_pixels(&render(state, id, 0), [72.0, 72.0, 200.0, 20.0])
            > dark_pixels(&before, [72.0, 72.0, 200.0, 20.0])
    );
    assert!(
        dark_pixels(&render(state, id, 0), [72.0, 180.0, 12.0, 12.0]) > 40,
        "the check mark of the on-state"
    );

    // The model after the save: same ids, clean, values as saved.
    let after = state.get_form_fields(id).unwrap();
    assert_eq!(after.fields.len(), 8);
    assert_eq!(by_name(&after, "name").id, field("name"));
    assert!(after.fields.iter().all(|f| f.sync == FieldSync::Clean));
    assert_eq!(
        by_name(&after, "agree").value,
        FieldValue::Checked { on: true }
    );
    // And it can be changed and saved again.
    set(
        state,
        id,
        field("agree"),
        json!({"type": "checked", "on": false}),
    )
    .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let again = read_fields(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        again
            .fields
            .iter()
            .find(|f| f.name == "agree")
            .unwrap()
            .value,
        FieldValue::Checked { on: false }
    );
}

#[test]
fn a_hybrid_form_loses_its_xfa_on_save_and_a_full_one_is_refused() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("xfa");
    let (id, path) = open(state, &scratch, "hybrid.pdf", &hybrid());
    let info = state.get_form_fields(id).unwrap();
    assert_eq!(info.xfa, Xfa::Hybrid);
    set(state, id, info.fields[0].id, text("Ada")).unwrap();
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(saved.warnings.contains(&SaveWarning::XfaRemoved));
    let read = read_fields(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(read.xfa, Xfa::None);
    assert_eq!(
        read.fields[0].value,
        FieldValue::Text { text: "Ada".into() }
    );

    let (full, _) = open(state, &scratch, "full.pdf", &support::fixtures::xfa());
    assert_eq!(
        state.get_form_fields(full).unwrap_err().code(),
        ErrorCode::UnsupportedFeature
    );
    // A document without a form has none.
    let (plain, _) = open(state, &scratch, "plain.pdf", &support::fixtures::text());
    assert!(state.get_form_fields(plain).unwrap().fields.is_empty());
}

#[test]
fn a_page_deleted_before_the_first_read_takes_its_widgets_with_it() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("pages");
    let (id, _) = open(state, &scratch, "form.pdf", &form());
    state
        .apply_command(id, command(json!({"type": "deletePages", "pages": [1]})))
        .unwrap();
    let info = state.get_form_fields(id).unwrap();
    assert_eq!(info.fields.len(), 7);
    assert!(info.fields.iter().all(|f| f.name != "second"));
}

// --- Hostile forms -----------------------------------------------------------------------------------------------------

fn broken(fields: &str, objects: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("").with("/Annots [100 0 R]")]);
    let p = page_id(0);
    builder.object(
        100,
        &format!(
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (a) /Rect [72 700 272 720] /P {p} 0 R >>"
        ),
    );
    let mut extra = Vec::new();
    for part in objects.split(';').filter(|part| !part.trim().is_empty()) {
        let (number, body) = part.split_once('=').unwrap();
        extra.push((
            number.trim().parse::<u32>().unwrap(),
            body.trim().to_owned(),
        ));
    }
    for (number, body) in &extra {
        builder.object(*number, body);
    }
    builder.object(
        1,
        &format!("<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [{fields}] >> >>"),
    );
    builder.finish(1)
}

#[test]
fn hostile_forms_do_not_panic_and_stay_within_limits() {
    let deep: String = (0..60u32)
        .map(|n| format!("{} = << /T (n{n}) /Kids [{} 0 R] >>;", 200 + n, 201 + n))
        .collect();
    let many = "100 0 R ".repeat(30_000);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("a kid that is its parent", broken("200 0 R", "200 = << /T (loop) /Kids [200 0 R] >>")),
        (
            "a ring of fields",
            broken("200 0 R", "200 = << /T (a) /Kids [201 0 R] >>; 201 = << /T (b) /Kids [200 0 R] >>"),
        ),
        ("a tree far too deep", broken("200 0 R", &deep)),
        ("a huge field list", broken(&many, "")),
        (
            "absurd numbers",
            broken(
                "200 0 R",
                "200 = << /FT /Tx /T (x) /MaxLen 99999999999999 /Ff -1 /Q 9999999999 /Rect [1e30 -1e30 0 0] /MK << /R 7777 /BG [9 9 9] >> /DA (/Helv 1e40 Tf) >>",
            ),
        ),
        (
            "options that are not options",
            broken("200 0 R", "200 = << /FT /Ch /T (c) /Ff 131072 /Opt [1 [2] [] << >> (a) [(b) 7]] /V [3 (a) (a)] /TI -5 >>"),
        ),
        (
            "a button with no appearance",
            broken("200 0 R", "200 = << /FT /Btn /T (b) /Rect [0 0 10 10] /AP << /N 5 >> /AS 6 /V << >> >>"),
        ),
        ("an unnamed field with a missing kid", broken("200 0 R 999 0 R", "200 = << /Kids [998 0 R 100 0 R] >>")),
        ("a name over the limit", broken("200 0 R", &format!("200 = << /FT /Tx /T ({}) >>", "n".repeat(5000)))),
        ("a value over the limit", broken("200 0 R", &format!("200 = << /FT /Tx /T (v) /V ({}) >>", "v".repeat(100_000)))),
    ];
    for (name, bytes) in &cases {
        let result = std::panic::catch_unwind(|| read_fields(bytes));
        assert!(result.is_ok(), "{name} panicked");
        if let Ok(Ok(read)) = result {
            assert!(read.fields.len() <= 10_000, "{name}");
            assert!(
                read.fields.iter().all(|f| f.name.chars().count() <= 512),
                "{name}"
            );
            assert!(
                read.fields.iter().all(|f| match &f.value {
                    FieldValue::Text { text } => text.chars().count() <= 32_768,
                    _ => true,
                }),
                "{name}"
            );
        }
    }
    // Every prefix of a good form is a damaged file: an error or a form, never a panic.
    let good = form();
    for cut in (0..good.len()).step_by(97) {
        let prefix = &good[..cut];
        assert!(
            std::panic::catch_unwind(|| read_fields(prefix)).is_ok(),
            "cut at {cut}"
        );
    }
}

#[test]
fn writing_a_field_the_file_does_not_have_is_an_error_not_a_panic() {
    let read: ReadForm = read_fields(&form()).unwrap();
    let mut field = read.fields[0].clone();
    field.obj.num = 4242;
    field.value = FieldValue::Text { text: "x".into() };
    assert!(write_values(form(), &[field], false).is_err());
    // Nothing to write: the file comes back as it was.
    let original = form();
    assert_eq!(
        write_values(original.clone(), &[], true).unwrap().bytes,
        original
    );
}

#[test]
fn hostile_forms_through_the_app_state_never_panic() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("hostile");
    let deep: String = (0..60u32)
        .map(|n| format!("{} = << /T (n{n}) /Kids [{} 0 R] >>;", 200 + n, 201 + n))
        .collect();
    let docs = [
        broken("200 0 R", "200 = << /T (loop) /Kids [200 0 R] >>"),
        broken("200 0 R", &deep),
        broken(
            "200 0 R",
            "200 = << /FT /Ch /T (c) /Opt [1 [2] (a)] /V [3 (a)] >>",
        ),
    ];
    for (index, bytes) in docs.iter().enumerate() {
        let Ok(Some(info)) = state.open_path({
            let path = scratch.file(&format!("h{index}.pdf"));
            std::fs::write(&path, bytes).unwrap();
            path
        }) else {
            continue;
        };
        let _ = state.get_form_fields(info.id);
        let _ = state.get_form_fields(info.id);
    }
}

// --- Politur M4: radio groups, comb fields and MaxLen (structure only, no PDFium) ------------------------------------------

/// A one page file whose only field is the text widget 100 with `extra` in its dictionary.
fn text_widget(extra: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("").with("/Annots [100 0 R]")]);
    let p = page_id(0);
    builder
        .object(
            100,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Tx /T (a) /Rect [72 700 172 720] /F 4 /P {p} 0 R {extra} >>"
            ),
        )
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] /DA (/Helv 0 Tf 0 g) >> >>",
        );
    builder.finish(1)
}

/// The decoded content of the normal appearance stream of object `num`.
fn normal_ap(bytes: &[u8], num: u32) -> String {
    let doc = sheer_lib::pdfwrite::prescan::load_untrusted(bytes).unwrap();
    let widget = doc.get_dictionary((num, 0)).unwrap();
    let ap = widget.get(b"AP").unwrap().as_dict().unwrap();
    let id = ap.get(b"N").unwrap().as_reference().unwrap();
    let stream = doc.get_object(id).unwrap().as_stream().unwrap();
    let data = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());
    String::from_utf8_lossy(&data).into_owned()
}

#[test]
fn a_radio_group_selects_one_widget_and_writes_the_value_and_states() {
    let read = read_fields(&form()).unwrap();
    let mut field = read
        .fields
        .iter()
        .find(|f| f.name == "color")
        .unwrap()
        .clone();
    field.value = FieldValue::Radio { selected: Some(1) };
    let written = write_values(form(), &[field.clone()], false).unwrap();
    let doc = sheer_lib::pdfwrite::prescan::load_untrusted(&written.bytes).unwrap();
    let state = |num: u32| {
        doc.get_dictionary((num, 0))
            .unwrap()
            .get(b"AS")
            .unwrap()
            .as_name()
            .unwrap()
            .to_vec()
    };
    assert_eq!(state(105), b"Off");
    assert_eq!(state(106), b"B");
    let group = doc.get_dictionary((104, 0)).unwrap();
    assert_eq!(group.get(b"V").unwrap().as_name().unwrap(), b"B");
    // Selecting nothing turns every button off.
    field.value = FieldValue::Radio { selected: None };
    let cleared = write_values(form(), &[field], false).unwrap();
    let doc = sheer_lib::pdfwrite::prescan::load_untrusted(&cleared.bytes).unwrap();
    for num in [105, 106] {
        let as_ = doc.get_dictionary((num, 0)).unwrap().get(b"AS").unwrap();
        assert_eq!(as_.as_name().unwrap(), b"Off");
    }
}

#[test]
fn a_comb_field_gets_one_cell_per_character_up_to_max_len() {
    let bytes = text_widget("/Ff 16777216 /MaxLen 6");
    let read = read_fields(&bytes).unwrap();
    let mut field = read.fields[0].clone();
    assert!(matches!(
        field.kind,
        FieldKind::Text {
            comb: true,
            max_len: Some(6),
            ..
        }
    ));
    field.value = FieldValue::Text { text: "ABC".into() };
    let written = write_values(bytes.clone(), &[field.clone()], false).unwrap();
    let content = normal_ap(&written.bytes, 100);
    assert_eq!(content.matches(" Tj").count(), 3, "{content}");
    // Text longer than the cells is cut at the last cell.
    field.value = FieldValue::Text {
        text: "ABCDEFGHIJ".into(),
    };
    let written = write_values(bytes, &[field], false).unwrap();
    assert_eq!(normal_ap(&written.bytes, 100).matches(" Tj").count(), 6);
    // Comb needs a MaxLen: without one the field is plain text.
    let plain = read_fields(&text_widget("/Ff 16777216")).unwrap();
    assert!(matches!(
        plain.fields[0].kind,
        FieldKind::Text { comb: false, .. }
    ));
}

#[test]
fn a_negative_zero_or_absurd_max_len_is_no_max_len() {
    for max in ["-3", "0", "99999999999999", "-9223372036854775808"] {
        let bytes = text_widget(&format!("/Ff 16777216 /MaxLen {max}"));
        let read = read_fields(&bytes).unwrap();
        let mut field = read.fields[0].clone();
        assert!(
            matches!(
                field.kind,
                FieldKind::Text {
                    comb: false,
                    max_len: None,
                    ..
                }
            ),
            "{max}: {:?}",
            field.kind
        );
        field.value = FieldValue::Text {
            text: "hello".into(),
        };
        let written = write_values(bytes, &[field], false).unwrap();
        assert!(normal_ap(&written.bytes, 100).contains("Tj"), "{max}");
    }
}
