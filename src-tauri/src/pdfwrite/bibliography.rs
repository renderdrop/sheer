//! The bibliographic record in a file (ADR-119 items 4 and 5): `/SHR_Bib` in `/Info` (read and written), the XMP packet and the
//! `/Info` strings (read only). Every byte of it is hostile input: types are checked, sizes are capped, strings are filtered for
//! display, and the XML is read with a pull parser that refuses a DOCTYPE and stops at fixed depth and event counts.

use std::collections::HashMap;
use std::io::Read;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, Stream};
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader as XmlPull;
use quick_xml::XmlVersion;

use super::annots::text_string;
use super::forms::decode_text;
use super::metadata::{parse_date, PdfDate};
use crate::documents::sanitize_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::bibliography::{
    is_doi_shape, is_iso_date, is_url_shape, normalize_isbn, BibKind, BibRecord, Person,
};

/// What one source of the file says: the same shape as the record (`kind` stays the default and is not used).
pub type BibFields = BibRecord;

/// What a file says: the user's record, XMP and Info.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BibRead {
    /// `/SHR_Bib` of `/Info`, if there is a valid one.
    pub record: Option<BibRecord>,
    pub xmp: BibFields,
    pub info: BibFields,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("lopdf: {detail}"))
}

fn info_dictionary(doc: &Document) -> Option<&Dictionary> {
    let (_, info) = doc.dereference(doc.trailer.get(b"Info").ok()?).ok()?;
    info.as_dict().ok()
}

// --- Strings ---

/// A text for display: white space collapsed, display-name filter, at most `max` characters; `None` if nothing is left.
fn clean(text: &str, max: usize) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = sanitize_text(&joined, max);
    let out = out.trim().to_owned();
    (!out.is_empty()).then_some(out)
}

/// The string `key` of `dict` (a direct string or a reference to one), decoded and cleaned.
fn string_at(doc: &Document, dict: &Dictionary, key: &[u8], max: usize) -> Option<String> {
    let (_, object) = doc.dereference(dict.get(key).ok()?).ok()?;
    let Object::String(bytes, _) = object else {
        return None;
    };
    clean(&decode_text(bytes, max.saturating_mul(4)), max)
}

fn kind_name(kind: BibKind) -> &'static str {
    match kind {
        BibKind::Book => "book",
        BibKind::Article => "article",
        BibKind::Chapter => "chapter",
        BibKind::Report => "report",
        BibKind::WebPage => "webPage",
        BibKind::Thesis => "thesis",
    }
}

fn kind_of(name: &str) -> BibKind {
    match name {
        "book" => BibKind::Book,
        "chapter" => BibKind::Chapter,
        "report" => BibKind::Report,
        "webPage" => BibKind::WebPage,
        "thesis" => BibKind::Thesis,
        _ => BibKind::Article,
    }
}

/// Text fields of `/SHR_Bib`: key, accessor.
type Field = (
    &'static str,
    fn(&mut BibRecord) -> &mut Option<String>,
    usize,
);

const TEXT_FIELDS: [Field; 14] = [
    ("T", |r| &mut r.title, limits::BIB_FIELD_MAX),
    ("Y", |r| &mut r.year, limits::BIB_YEAR_MAX),
    ("C", |r| &mut r.container_title, limits::BIB_FIELD_MAX),
    ("Vol", |r| &mut r.volume, limits::BIB_FIELD_MAX),
    ("Is", |r| &mut r.issue, limits::BIB_FIELD_MAX),
    ("P", |r| &mut r.pages, limits::BIB_FIELD_MAX),
    ("E", |r| &mut r.edition, limits::BIB_FIELD_MAX),
    ("Pub", |r| &mut r.publisher, limits::BIB_FIELD_MAX),
    ("Pl", |r| &mut r.place, limits::BIB_FIELD_MAX),
    ("DOI", |r| &mut r.doi, limits::BIB_DOI_MAX),
    ("ISBN", |r| &mut r.isbn, 24),
    ("URL", |r| &mut r.url, limits::BIB_URL_MAX),
    ("Acc", |r| &mut r.accessed, limits::BIB_YEAR_MAX),
    ("ST", |r| &mut r.short_title, limits::BIB_SHORT_TITLE_MAX),
];

/// Drops what a hostile or foreign file put in a field that must have a shape.
fn enforce_shapes(record: &mut BibRecord) {
    if record.doi.as_deref().is_some_and(|doi| !is_doi_shape(doi)) {
        record.doi = None;
    }
    record.isbn = record.isbn.as_deref().and_then(normalize_isbn);
    if record.url.as_deref().is_some_and(|url| !is_url_shape(url)) {
        record.url = None;
    }
    if record
        .accessed
        .as_deref()
        .is_some_and(|date| !is_iso_date(date))
    {
        record.accessed = None;
    }
}

// --- /SHR_Bib ---

fn read_user_record(doc: &Document, info: &Dictionary) -> Option<BibRecord> {
    let (_, object) = doc.dereference(info.get(b"SHR_Bib").ok()?).ok()?;
    let dict = object.as_dict().ok()?;
    let (_, version) = doc.dereference(dict.get(b"V").ok()?).ok()?;
    if !matches!(version, Object::Integer(1)) {
        return None;
    }
    let mut record = BibRecord::default();
    if let Some(kind) = string_at(doc, dict, b"K", 16) {
        record.kind = kind_of(&kind);
    }
    for (key, field, max) in TEXT_FIELDS {
        *field(&mut record) = string_at(doc, dict, key.as_bytes(), max);
    }
    enforce_shapes(&mut record);
    if let Ok((_, Object::Array(items))) = doc.dereference(dict.get(b"A").unwrap_or(&Object::Null))
    {
        // At most four times the cap of entries are looked at, so junk between the persons cannot make the scan long.
        for item in items.iter().take(limits::BIB_AUTHORS_MAX * 4) {
            if record.authors.len() >= limits::BIB_AUTHORS_MAX {
                break;
            }
            let Ok((_, Object::Dictionary(person))) = doc.dereference(item) else {
                continue;
            };
            let family = string_at(doc, person, b"F", limits::BIB_PERSON_MAX).unwrap_or_default();
            let given = string_at(doc, person, b"G", limits::BIB_PERSON_MAX).unwrap_or_default();
            if !family.is_empty() || !given.is_empty() {
                record.authors.push(Person { family, given });
            }
        }
    }
    Some(record)
}

fn user_dictionary(record: &BibRecord) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("V", Object::Integer(1));
    dict.set("K", text_string(kind_name(record.kind)));
    let mut copy = record.clone();
    for (key, field, _) in TEXT_FIELDS {
        if let Some(text) = field(&mut copy).as_ref() {
            dict.set(key, text_string(text));
        }
    }
    let authors: Vec<Object> = record
        .authors
        .iter()
        .take(limits::BIB_AUTHORS_MAX)
        .map(|person| {
            let mut entry = Dictionary::new();
            entry.set("F", text_string(&person.family));
            entry.set("G", text_string(&person.given));
            Object::Dictionary(entry)
        })
        .collect();
    if !authors.is_empty() {
        dict.set("A", Object::Array(authors));
    }
    dict
}

/// Sets `/SHR_Bib` in the newest `/Info` of `doc` (an empty record removes it); `/Title`, `/Author` and the other keys stay as they
/// are, `/ModDate` becomes `now`. Edits the `/Info` the metadata write made, or makes one.
pub fn write(
    doc: &mut IncrementalDocument,
    record: &BibRecord,
    now: PdfDate,
) -> Result<(), AppError> {
    let prev = doc.get_prev_documents();
    let mut info = info_dictionary(prev).cloned().unwrap_or_default();
    let info_id = prev
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| object.as_reference().ok());
    if *record == BibRecord::default() {
        info.remove(b"SHR_Bib");
    } else {
        info.set("SHR_Bib", Object::Dictionary(user_dictionary(record)));
    }
    info.set("ModDate", Object::string_literal(now.pdf()));
    let info_id = match info_id {
        Some(id) => {
            doc.new_document.set_object(id, Object::Dictionary(info));
            id
        }
        None => doc.new_document.add_object(Object::Dictionary(info)),
    };
    doc.new_document
        .trailer
        .set("Info", Object::Reference(info_id));
    Ok(())
}

/// Writes `record` on top of `bytes` as an incremental update.
pub fn apply(bytes: Vec<u8>, record: &BibRecord) -> Result<Vec<u8>, AppError> {
    let doc = super::load_untrusted(&bytes)?;
    if doc.is_encrypted() {
        return Err(AppError::unsupported("encrypted"));
    }
    let mut inc = IncrementalDocument::create_from(bytes, doc);
    write(&mut inc, record, PdfDate::now())?;
    let mut out = Vec::new();
    inc.save_to(&mut out).map_err(failed)?;
    Ok(out)
}

// --- Info ---

/// Splits an author string into persons: `;` or ` and ` between persons, `Family, Given` or `Given Family` in one.
pub fn split_authors(text: &str) -> Vec<Person> {
    let mut persons = Vec::new();
    let pieces: Vec<&str> = if text.contains(';') {
        text.split(';').collect()
    } else {
        split_and(text)
    };
    for piece in pieces {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let (family, given) = match piece.split_once(',') {
            Some((family, given)) => (family.trim(), given.trim()),
            None => match piece.rsplit_once(' ') {
                Some((given, family)) => (family.trim(), given.trim()),
                None => (piece, ""),
            },
        };
        let family = sanitize_text(family, limits::BIB_PERSON_MAX);
        let given = sanitize_text(given, limits::BIB_PERSON_MAX);
        if !family.is_empty() || !given.is_empty() {
            persons.push(Person { family, given });
        }
        if persons.len() >= limits::BIB_AUTHORS_MAX {
            break;
        }
    }
    persons
}

/// Splits at the word `and` (any case) between spaces.
fn split_and(text: &str) -> Vec<&str> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut start = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find(" and ") {
        let at = from + found;
        out.push(&text[start..at]);
        start = at + 5;
        from = start;
    }
    out.push(&text[start..]);
    out
}

fn read_info(doc: &Document) -> BibFields {
    let mut fields = BibFields::default();
    let Some(info) = info_dictionary(doc) else {
        return fields;
    };
    fields.title = string_at(doc, info, b"Title", limits::BIB_FIELD_MAX);
    if let Some(author) = string_at(
        doc,
        info,
        b"Author",
        limits::BIB_PERSON_MAX * limits::BIB_AUTHORS_MAX,
    ) {
        fields.authors = split_authors(&author);
    }
    if let Some(Object::String(bytes, _)) = info
        .get(b"CreationDate")
        .ok()
        .and_then(|object| doc.dereference(object).ok())
        .map(|(_, object)| object)
    {
        fields.year = parse_date(&decode_text(bytes, 64)).and_then(|iso| year_of(&iso));
    }
    fields
}

/// The year at the start of a date text (`2024-03-01`, `2024`, `2024-03`): four digits, 1000 to 2999.
fn year_of(date: &str) -> Option<String> {
    let head = date.get(..4)?;
    let valid = head.bytes().all(|b| b.is_ascii_digit())
        && matches!(head.as_bytes()[0], b'1' | b'2')
        && date
            .as_bytes()
            .get(4)
            .is_none_or(|next| !next.is_ascii_digit());
    valid.then(|| head.to_owned())
}

// --- XMP ---

const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
const NS_PRISM: &str = "http://prismstandard.org/namespaces/basic/";
const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
/// Values one property keeps (list items).
const VALUES_PER_PROPERTY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Prop {
    Title,
    Creator,
    Date,
    Publisher,
    Identifier,
    Doi,
    Container,
    Volume,
    Number,
    StartPage,
    EndPage,
    Url,
}

fn prop_of(ns: &str, local: &str) -> Option<Prop> {
    if ns == NS_DC {
        return match local {
            "title" => Some(Prop::Title),
            "creator" => Some(Prop::Creator),
            "date" => Some(Prop::Date),
            "publisher" => Some(Prop::Publisher),
            "identifier" => Some(Prop::Identifier),
            _ => None,
        };
    }
    if ns.starts_with(NS_PRISM) {
        return match local {
            "doi" => Some(Prop::Doi),
            "publicationName" => Some(Prop::Container),
            "volume" => Some(Prop::Volume),
            "number" => Some(Prop::Number),
            "startingPage" => Some(Prop::StartPage),
            "endingPage" => Some(Prop::EndPage),
            "url" => Some(Prop::Url),
            _ => None,
        };
    }
    None
}

/// The namespace of a resolved name as an owned string (`""` if unbound or unknown).
fn ns_text(result: &ResolveResult<'_>) -> String {
    match result {
        ResolveResult::Bound(ns) => ns.0.to_owned(),
        _ => String::new(),
    }
}

type Values = HashMap<Prop, Vec<(Option<String>, String)>>;

fn push_value(values: &mut Values, prop: Prop, lang: Option<String>, text: &str) {
    let Some(text) = clean(text, limits::BIB_FIELD_MAX) else {
        return;
    };
    let list = values.entry(prop).or_default();
    if list.len() < VALUES_PER_PROPERTY {
        list.push((lang, text));
    }
}

/// Appends `piece` to `buffer` while it stays within twice the field cap (the rest is cut; it is cleaned and capped again later).
fn append_capped(buffer: &mut String, piece: &str) {
    let room = limits::BIB_FIELD_MAX * 2;
    let have = buffer.chars().count();
    if have < room {
        buffer.extend(piece.chars().take(room - have));
    }
}

/// The `xml:lang` of an element: `Some(None)` if it has none, `None` if its attributes are malformed.
fn lang_of(start: &BytesStart<'_>) -> Option<Option<String>> {
    for attribute in start.attributes() {
        let attribute = attribute.ok()?;
        if attribute.key.as_ref() == "xml:lang" {
            let value = attribute.normalized_value(XmlVersion::Implicit1_0).ok()?;
            return Some(clean(&value, 32));
        }
    }
    Some(None)
}

/// Simple properties written as attributes (`<rdf:Description dc:title="..." prism:doi="...">`).
fn read_attributes(
    reader: &XmlPull<&[u8]>,
    start: &BytesStart<'_>,
    values: &mut Values,
) -> Option<()> {
    for attribute in start.attributes() {
        let attribute = attribute.ok()?;
        let (resolved, local) = reader.resolver().resolve_attribute(attribute.key);
        let ns = ns_text(&resolved);
        let local = local.as_ref();
        if let Some(prop) = prop_of(&ns, local) {
            let value = attribute.normalized_value(XmlVersion::Implicit1_0).ok()?;
            push_value(values, prop, None, &value);
        }
    }
    Some(())
}

type Item = Option<(usize, Option<String>, String)>;

fn collect(
    text: &str,
    current: &Option<(Prop, usize)>,
    depth: usize,
    direct: &mut String,
    item: &mut Item,
) {
    let Some((_, prop_depth)) = current else {
        return;
    };
    if let Some((_, _, buffer)) = item {
        append_capped(buffer, text);
    } else if depth == *prop_depth {
        append_capped(direct, text);
    }
}

/// Reads the bibliographic properties of an XMP packet. `None` for anything that is not safe and well-formed XML: a DOCTYPE, nesting
/// deeper than `BIB_XMP_DEPTH_MAX`, more than `BIB_XMP_EVENTS_MAX` events, an undefined entity, text that is not UTF-8, a mismatched
/// tag, a packet over `MAX_XMP_BYTES`. What the packet says in the Dublin Core and PRISM namespaces (by namespace URI, not by prefix)
/// comes back, all strings cleaned and capped. Nothing is expanded beyond the five predefined entities and character references,
/// and nothing is fetched.
pub fn parse_xmp(packet: &[u8]) -> Option<BibFields> {
    if u64::try_from(packet.len()).ok()? > limits::MAX_XMP_BYTES {
        return None;
    }
    let packet = packet.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(packet);
    let mut reader = XmlPull::from_reader(packet);
    let mut buf = Vec::new();
    let mut values = Values::new();
    let mut events = 0usize;
    let mut depth = 0usize;
    // The property being read (and the depth of its element), the text directly in it, and the list item inside it.
    let mut current: Option<(Prop, usize)> = None;
    let mut direct = String::new();
    let mut item: Item = None;
    loop {
        events += 1;
        if events > limits::BIB_XMP_EVENTS_MAX {
            return None;
        }
        buf.clear();
        let (resolved, event) = reader.read_resolved_event_into(&mut buf).ok()?;
        let ns = ns_text(&resolved);
        match event {
            Event::Eof => break,
            Event::DocType(_) => return None,
            Event::Start(start) => {
                depth += 1;
                if depth > limits::BIB_XMP_DEPTH_MAX {
                    return None;
                }
                let local = start.local_name().as_ref().to_owned();
                if current.is_none() {
                    read_attributes(&reader, &start, &mut values)?;
                    if let Some(prop) = prop_of(&ns, &local) {
                        current = Some((prop, depth));
                        direct.clear();
                    }
                } else if ns == NS_RDF && local == "li" && item.is_none() {
                    item = Some((depth, lang_of(&start)?, String::new()));
                }
            }
            Event::Empty(start) => {
                if depth + 1 > limits::BIB_XMP_DEPTH_MAX {
                    return None;
                }
                if current.is_none() {
                    read_attributes(&reader, &start, &mut values)?;
                }
            }
            Event::End(_) => {
                if let Some((_, lang, text)) = item.take_if(|(at, _, _)| *at == depth) {
                    if let Some((prop, _)) = current {
                        push_value(&mut values, prop, lang, &text);
                    }
                }
                if let Some((prop, at)) = current {
                    if at == depth {
                        if !values.contains_key(&prop) {
                            push_value(&mut values, prop, None, &direct);
                        }
                        current = None;
                        direct.clear();
                    }
                }
                depth = depth.checked_sub(1)?;
            }
            Event::Text(text) => collect(&text, &current, depth, &mut direct, &mut item),
            Event::CData(data) => {
                let text: &str = &data;
                collect(text, &current, depth, &mut direct, &mut item);
            }
            Event::GeneralRef(entity) => {
                let ch = match entity.resolve_char_ref().ok()? {
                    Some(ch) => ch,
                    None => match &*entity {
                        "lt" => '<',
                        "gt" => '>',
                        "amp" => '&',
                        "quot" => '"',
                        "apos" => '\u{27}',
                        _ => return None,
                    },
                };
                let mut utf8 = [0u8; 4];
                let text: &str = ch.encode_utf8(&mut utf8);
                collect(text, &current, depth, &mut direct, &mut item);
            }
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) => {}
        }
    }
    Some(fields_of(&values))
}

fn first(values: &Values, prop: Prop) -> Option<String> {
    values
        .get(&prop)
        .and_then(|list| list.first())
        .map(|(_, text)| text.clone())
}

/// A DOI of whatever spelling (`doi:`, `urn:doi:`, a resolver address) as the bare `10.x/y` form, if it is one.
fn doi_of(text: &str) -> Option<String> {
    let text = text.trim();
    let lower = text.to_ascii_lowercase();
    let mut rest = text;
    for prefix in [
        "urn:doi:",
        "doi:",
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
    ] {
        if lower.starts_with(prefix) {
            rest = text.get(prefix.len()..)?;
            break;
        }
    }
    let rest = rest.trim();
    (rest.chars().count() <= limits::BIB_DOI_MAX && is_doi_shape(rest)).then(|| rest.to_owned())
}

fn fields_of(values: &Values) -> BibFields {
    let mut fields = BibFields::default();
    if let Some(list) = values.get(&Prop::Title) {
        fields.title = list
            .iter()
            .find(|(lang, _)| lang.as_deref() == Some("x-default"))
            .or_else(|| list.iter().find(|(lang, _)| lang.is_none()))
            .or_else(|| list.first())
            .map(|(_, text)| text.clone());
    }
    if let Some(list) = values.get(&Prop::Creator) {
        for (_, text) in list {
            for person in split_authors(text) {
                if fields.authors.len() < limits::BIB_AUTHORS_MAX {
                    fields.authors.push(person);
                }
            }
        }
    }
    fields.year = first(values, Prop::Date).and_then(|date| year_of(&date));
    fields.publisher = first(values, Prop::Publisher);
    fields.doi = first(values, Prop::Doi)
        .and_then(|text| doi_of(&text))
        .or_else(|| {
            values
                .get(&Prop::Identifier)
                .into_iter()
                .flatten()
                .filter(|(_, text)| text.to_ascii_lowercase().contains("doi"))
                .find_map(|(_, text)| doi_of(text))
        });
    fields.container_title = first(values, Prop::Container);
    fields.volume = first(values, Prop::Volume);
    fields.issue = first(values, Prop::Number);
    fields.pages = match (first(values, Prop::StartPage), first(values, Prop::EndPage)) {
        (Some(start), Some(end)) => Some(format!("{start}\u{2013}{end}")),
        (Some(page), None) | (None, Some(page)) => Some(page),
        (None, None) => None,
    };
    fields.url = first(values, Prop::Url);
    enforce_shapes(&mut fields);
    fields
}

/// The bytes of the catalog's `/Metadata` stream if it is plain or a single Flate stream, at most `MAX_XMP_BYTES` once inflated.
fn xmp_bytes(doc: &Document, stream: &Stream) -> Option<Vec<u8>> {
    let max = limits::MAX_XMP_BYTES;
    if u64::try_from(stream.content.len()).ok()? > max {
        return None;
    }
    let filter = stream
        .dict
        .get(b"Filter")
        .ok()
        .and_then(|object| doc.dereference(object).ok())
        .map(|(_, object)| object);
    let is_flate = |object: &Object| {
        object
            .as_name()
            .is_ok_and(|name| name == b"FlateDecode" || name == b"Fl")
    };
    let flate = match filter {
        None => false,
        Some(Object::Array(items)) if items.is_empty() => false,
        Some(Object::Array(items)) if items.len() == 1 && is_flate(&items[0]) => true,
        Some(object) if is_flate(object) => true,
        Some(_) => return None,
    };
    if !flate {
        return Some(stream.content.clone());
    }
    if stream.dict.has(b"DecodeParms") {
        return None;
    }
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(&stream.content[..])
        .take(max + 1)
        .read_to_end(&mut out)
        .ok()?;
    (u64::try_from(out.len()).ok()? <= max).then_some(out)
}

fn read_xmp(doc: &Document) -> BibFields {
    let stream = doc
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Metadata").ok())
        .and_then(|object| doc.dereference(object).ok())
        .and_then(|(_, object)| object.as_stream().ok());
    stream
        .and_then(|stream| xmp_bytes(doc, stream))
        .and_then(|bytes| parse_xmp(&bytes))
        .unwrap_or_default()
}

/// Reads `/SHR_Bib`, the XMP packet and the `/Info` strings of `doc`. Nothing in it is trusted; what does not fit is left out.
pub fn read(doc: &Document) -> Result<BibRead, AppError> {
    Ok(BibRead {
        record: info_dictionary(doc).and_then(|info| read_user_record(doc, info)),
        xmp: read_xmp(doc),
        info: read_info(doc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::bibliography::BibKind;

    const HEAD: &str = "<?xpacket begin=\"x\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\
        <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">";
    const TAIL: &str = "</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";

    fn packet(body: &str) -> String {
        format!("{HEAD}{body}{TAIL}")
    }

    #[test]
    fn a_normal_packet_is_read_by_namespace() {
        let xml = packet(
            "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
             xmlns:prism=\"http://prismstandard.org/namespaces/basic/2.0/\" prism:volume=\"12\">\
             <dc:title><rdf:Alt><rdf:li xml:lang=\"de\">Titel</rdf:li><rdf:li xml:lang=\"x-default\">The &lt;Title&gt; &amp; more</rdf:li></rdf:Alt></dc:title>\
             <dc:creator><rdf:Seq><rdf:li>Lovelace, Ada</rdf:li><rdf:li>Charles Babbage</rdf:li></rdf:Seq></dc:creator>\
             <dc:date><rdf:Seq><rdf:li>2021-05-04T10:00:00Z</rdf:li></rdf:Seq></dc:date>\
             <dc:identifier>doi:10.1000/xyz123</dc:identifier>\
             <prism:publicationName>Journal of Tests</prism:publicationName>\
             <prism:startingPage>10</prism:startingPage><prism:endingPage>20</prism:endingPage>\
             </rdf:Description>",
        );
        let fields = parse_xmp(xml.as_bytes()).unwrap();
        assert_eq!(fields.title.as_deref(), Some("The <Title> & more"));
        assert_eq!(
            fields.authors,
            vec![
                Person {
                    family: "Lovelace".into(),
                    given: "Ada".into()
                },
                Person {
                    family: "Babbage".into(),
                    given: "Charles".into()
                }
            ]
        );
        assert_eq!(fields.year.as_deref(), Some("2021"));
        assert_eq!(fields.doi.as_deref(), Some("10.1000/xyz123"));
        assert_eq!(fields.container_title.as_deref(), Some("Journal of Tests"));
        assert_eq!(fields.volume.as_deref(), Some("12"));
        assert_eq!(fields.pages.as_deref(), Some("10\u{2013}20"));
        assert_eq!(fields.kind, BibKind::Article);
    }

    #[test]
    fn the_prefix_means_nothing_only_the_namespace_does() {
        let wrong = packet(
            "<rdf:Description xmlns:dc=\"http://example.com/not-dc/\"><dc:title>Nope</dc:title></rdf:Description>",
        );
        assert_eq!(parse_xmp(wrong.as_bytes()).unwrap(), BibFields::default());
        let renamed = packet(
            "<rdf:Description xmlns:x=\"http://purl.org/dc/elements/1.1/\"><x:title>Yes</x:title></rdf:Description>",
        );
        assert_eq!(
            parse_xmp(renamed.as_bytes()).unwrap().title.as_deref(),
            Some("Yes")
        );
        let unbound = packet("<rdf:Description><dc:title>Unbound</dc:title></rdf:Description>");
        assert!(parse_xmp(unbound.as_bytes()).is_none_or(|f| f.title.is_none()));
    }

    #[test]
    fn a_doctype_and_entity_tricks_abort_the_read() {
        let doctype = format!(
            "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY a \"aaaa\">]>{}",
            packet("")
        );
        assert!(parse_xmp(doctype.as_bytes()).is_none());
        let laughs = "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;&lol;&lol;\">]><lolz>&lol2;</lolz>";
        assert!(parse_xmp(laughs.as_bytes()).is_none());
        // An entity used without a DOCTYPE is undefined.
        let undefined = packet(
            "<rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>&xxe;</dc:title></rdf:Description>",
        );
        assert!(parse_xmp(undefined.as_bytes()).is_none());
        // Character references are fine; control characters are filtered.
        let chars = packet(
            "<rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>A&#x41;&#7;&#8238;B</dc:title></rdf:Description>",
        );
        assert_eq!(
            parse_xmp(chars.as_bytes()).unwrap().title.as_deref(),
            Some("AAB")
        );
    }

    #[test]
    fn nesting_events_and_size_are_bounded() {
        let deep = format!(
            "{}{}",
            "<a>".repeat(limits::BIB_XMP_DEPTH_MAX + 1),
            "</a>".repeat(limits::BIB_XMP_DEPTH_MAX + 1)
        );
        assert!(parse_xmp(deep.as_bytes()).is_none());
        let ok = format!(
            "{}{}",
            "<a>".repeat(limits::BIB_XMP_DEPTH_MAX),
            "</a>".repeat(limits::BIB_XMP_DEPTH_MAX)
        );
        assert!(parse_xmp(ok.as_bytes()).is_some());
        let many = format!("<a>{}</a>", "<b/>".repeat(limits::BIB_XMP_EVENTS_MAX + 1));
        assert!(parse_xmp(many.as_bytes()).is_none());
        let huge = vec![b' '; usize::try_from(limits::MAX_XMP_BYTES).unwrap() + 1];
        assert!(parse_xmp(&huge).is_none());
    }

    #[test]
    fn malformed_text_and_markup_are_refused() {
        let mut bytes = packet(
            "<rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>AB</dc:title></rdf:Description>",
        )
        .into_bytes();
        let at = bytes.windows(2).position(|w| w == b"AB").unwrap();
        bytes[at] = 0xFF;
        bytes[at + 1] = 0xFE;
        assert!(parse_xmp(&bytes).is_none());
        assert!(parse_xmp(b"<a><b></a></b>").is_none());
        assert!(parse_xmp(b"</a>").is_none());
        assert!(parse_xmp(b"<a xmlns:=\"x\" a=").is_none());
    }

    #[test]
    fn long_values_are_capped_and_a_bad_doi_or_url_is_dropped() {
        let long = "x".repeat(5_000);
        let xml = packet(&format!(
            "<rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:prism=\"http://prismstandard.org/namespaces/basic/2.0/\" \
             prism:doi=\"not a doi\" prism:url=\"javascript:alert(1)\"><dc:title>{long}</dc:title></rdf:Description>"
        ));
        let fields = parse_xmp(xml.as_bytes()).unwrap();
        assert_eq!(fields.title.unwrap().chars().count(), limits::BIB_FIELD_MAX);
        assert_eq!(fields.doi, None);
        assert_eq!(fields.url, None);
    }

    #[test]
    fn authors_are_split_into_persons() {
        let p = |family: &str, given: &str| Person {
            family: family.into(),
            given: given.into(),
        };
        assert_eq!(
            split_authors("Lovelace, Ada; Babbage, Charles"),
            vec![p("Lovelace", "Ada"), p("Babbage", "Charles")]
        );
        assert_eq!(
            split_authors("Ada Lovelace and Charles Babbage"),
            vec![p("Lovelace", "Ada"), p("Babbage", "Charles")]
        );
        assert_eq!(split_authors("Plato"), vec![p("Plato", "")]);
        assert_eq!(split_authors(" ; ;").len(), 0);
        let many = (0..100).map(|n| format!("F{n}, G")).collect::<Vec<_>>();
        assert_eq!(
            split_authors(&many.join("; ")).len(),
            limits::BIB_AUTHORS_MAX
        );
    }

    #[test]
    fn the_short_title_is_stored_as_st_and_older_files_read_without_it() {
        let read_back = |dict: Dictionary| {
            let mut doc = Document::with_version("1.7");
            let mut info = Dictionary::new();
            info.set("SHR_Bib", Object::Dictionary(dict));
            let id = doc.add_object(Object::Dictionary(info));
            doc.trailer.set("Info", Object::Reference(id));
            read(&doc).unwrap().record.unwrap()
        };
        let record = BibRecord {
            title: Some("T".into()),
            short_title: Some("Kurz".into()),
            ..BibRecord::default()
        };
        assert!(user_dictionary(&record).has(b"ST"));
        assert_eq!(read_back(user_dictionary(&record)), record);
        let plain = BibRecord {
            short_title: None,
            ..record.clone()
        };
        assert!(!user_dictionary(&plain).has(b"ST"));
        assert_eq!(read_back(user_dictionary(&plain)).short_title, None);
        // A hostile value is capped like any field.
        let mut hostile = user_dictionary(&plain);
        hostile.set("ST", text_string(&"x".repeat(5_000)));
        assert_eq!(
            read_back(hostile).short_title.unwrap().chars().count(),
            limits::BIB_SHORT_TITLE_MAX
        );
    }

    #[test]
    fn the_isbn_is_stored_as_isbn_and_older_files_read_without_it() {
        let read_back = |dict: Dictionary| {
            let mut doc = Document::with_version("1.7");
            let mut info = Dictionary::new();
            info.set("SHR_Bib", Object::Dictionary(dict));
            let id = doc.add_object(Object::Dictionary(info));
            doc.trailer.set("Info", Object::Reference(id));
            read(&doc).unwrap().record.unwrap()
        };
        let record = BibRecord {
            title: Some("T".into()),
            isbn: Some("9783161484100".into()),
            ..BibRecord::default()
        };
        assert!(user_dictionary(&record).has(b"ISBN"));
        assert_eq!(read_back(user_dictionary(&record)), record);
        let plain = BibRecord {
            isbn: None,
            ..record.clone()
        };
        assert!(!user_dictionary(&plain).has(b"ISBN"));
        assert_eq!(read_back(user_dictionary(&plain)).isbn, None);
        let mut hostile = user_dictionary(&plain);
        hostile.set("ISBN", text_string("9783161484101"));
        assert_eq!(read_back(hostile).isbn, None);
    }

    #[test]
    fn a_year_is_four_digits_at_the_start() {
        assert_eq!(year_of("2021-05-04").as_deref(), Some("2021"));
        assert_eq!(year_of("1999").as_deref(), Some("1999"));
        assert_eq!(year_of("20210"), None);
        assert_eq!(year_of("0021"), None);
        assert_eq!(year_of("abcd"), None);
        assert_eq!(year_of("20"), None);
    }
}
