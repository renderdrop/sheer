//! Reading, writing and removing document metadata (ADR-047 §5).

use std::time::{SystemTime, UNIX_EPOCH};

use lopdf::{Dictionary, Document, IncrementalDocument, Object, Stream};

use super::annots::text_string;
use super::forms::decode_text;
use super::prescan::load_untrusted;
use crate::documents::sanitize_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::metadata::{MetadataChange, MetadataValues};

/// A date for `/ModDate` and the XMP packet: UTC, to the second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdfDate {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl PdfDate {
    /// The current time (UTC). A clock before 1970 is 1970.
    pub fn now() -> Self {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        Self::from_unix(seconds)
    }

    /// The date of `seconds` since 1970-01-01 (civil-from-days, proleptic Gregorian).
    pub fn from_unix(seconds: u64) -> Self {
        let days = i64::try_from(seconds / 86_400).unwrap_or(0);
        let rest = seconds % 86_400;
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        Self {
            year: u16::try_from(year).unwrap_or(1970),
            month: u8::try_from(month).unwrap_or(1),
            day: u8::try_from(day).unwrap_or(1),
            hour: u8::try_from(rest / 3_600).unwrap_or(0),
            minute: u8::try_from(rest % 3_600 / 60).unwrap_or(0),
            second: u8::try_from(rest % 60).unwrap_or(0),
        }
    }

    /// `D:20261003123045Z`.
    pub fn pdf(self) -> String {
        format!(
            "D:{:04}{:02}{:02}{:02}{:02}{:02}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    /// `2026-10-03T12:30:45Z`.
    pub fn iso(self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// What `/Info` and the catalog's `/Metadata` hold, decoded and filtered (strings ≤ 1 000 characters, dates as ISO 8601 or `None`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetadataRead {
    pub values: MetadataValues,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub pdf_version: String,
    pub xmp_present: bool,
    pub xmp_bytes: u64,
    pub truncated: bool,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("lopdf: {detail}"))
}

/// The trailer's `/Info` dictionary, if it has a usable one.
fn info_dictionary(doc: &Document) -> Option<&Dictionary> {
    let (_, info) = doc.dereference(doc.trailer.get(b"Info").ok()?).ok()?;
    info.as_dict().ok()
}

/// A text string of `dict` for display: decoded, without control and format characters, at most 1 000 characters (`truncated` when it
/// was longer); `None` if the key is missing, not a string, or empty after the filter.
fn text_field(
    doc: &Document,
    dict: &Dictionary,
    key: &[u8],
    truncated: &mut bool,
) -> Option<String> {
    let (_, object) = doc.dereference(dict.get(key).ok()?).ok()?;
    let Object::String(bytes, _) = object else {
        return None;
    };
    let max = limits::MAX_METADATA_FIELD_CHARS;
    let decoded = decode_text(bytes, max * 4);
    let clean = sanitize_text(&decoded, usize::MAX);
    let count = clean.chars().count();
    let clean = if count > max {
        *truncated = true;
        clean.chars().take(max).collect()
    } else {
        clean
    };
    (!clean.is_empty()).then_some(clean)
}

/// A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, every part after the year optional) as ISO 8601; `None` for anything that is not a date.
pub fn parse_date(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("D:").unwrap_or(text.trim());
    let bytes = rest.as_bytes();
    let digits = |from: usize, len: usize| -> Option<Option<u32>> {
        match bytes.get(from..from + len) {
            None => Some(None),
            Some(part) if part.iter().all(u8::is_ascii_digit) => {
                Some(std::str::from_utf8(part).ok()?.parse().ok())
            }
            Some(_) => None,
        }
    };
    let run = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if !(4..=14).contains(&run) || !run.is_multiple_of(2) {
        return None;
    }
    let year = digits(0, 4)??;
    let month = digits(4, 2)?.unwrap_or(1);
    let day = digits(6, 2)?.unwrap_or(1);
    let hour = digits(8, 2)?.unwrap_or(0);
    let minute = digits(10, 2)?.unwrap_or(0);
    let second = digits(12, 2)?.unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let zone = match bytes.get(run) {
        None => String::new(),
        Some(b'Z' | b'z') => "Z".to_owned(),
        Some(sign @ (b'+' | b'-')) => {
            let tail: String = rest[run + 1..].chars().filter(|c| *c != '\'').collect();
            let (hh, mm) = match tail.len() {
                0 => ("00", "00"),
                2 => (&tail[..2], "00"),
                4 => (&tail[..2], &tail[2..]),
                _ => return None,
            };
            let (h, m): (u32, u32) = (hh.parse().ok()?, mm.parse().ok()?);
            if h > 23 || m > 59 {
                return None;
            }
            format!("{}{h:02}:{m:02}", char::from(*sign))
        }
        Some(_) => return None,
    };
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{zone}"
    ))
}

fn date_field(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<String> {
    let (_, object) = doc.dereference(dict.get(key).ok()?).ok()?;
    let Object::String(bytes, _) = object else {
        return None;
    };
    parse_date(&decode_text(bytes, 64))
}

/// The catalog's `/Metadata` stream, if it is one.
fn xmp_stream(doc: &Document) -> Option<&Stream> {
    let catalog = doc.catalog().ok()?;
    let (_, object) = doc.dereference(catalog.get(b"Metadata").ok()?).ok()?;
    object.as_stream().ok()
}

/// Reads the trailer `/Info` and the catalog `/Metadata` of `doc`.
pub fn read(doc: &Document) -> Result<MetadataRead, AppError> {
    let mut truncated = false;
    let mut out = MetadataRead {
        pdf_version: doc.version.chars().take(16).collect(),
        ..MetadataRead::default()
    };
    if let Some(info) = info_dictionary(doc) {
        let mut field = |key: &[u8]| text_field(doc, info, key, &mut truncated);
        out.values = MetadataValues {
            title: field(b"Title"),
            author: field(b"Author"),
            subject: field(b"Subject"),
            keywords: field(b"Keywords"),
            creator: field(b"Creator"),
            producer: field(b"Producer"),
        };
        out.created = date_field(doc, info, b"CreationDate");
        out.modified = date_field(doc, info, b"ModDate");
    }
    if let Some(xmp) = xmp_stream(doc) {
        out.xmp_present = true;
        out.xmp_bytes = u64::try_from(xmp.content.len()).unwrap_or(u64::MAX);
    }
    out.truncated = truncated;
    Ok(out)
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // What XML 1.0 cannot carry at all.
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// An XMP packet of the values: Dublin Core title, creator, description, `pdf:Keywords`, `pdf:Producer`, `xmp:CreatorTool` and the
/// dates, every text XML-escaped.
fn xmp_packet(m: &MetadataValues, created: Option<&str>, modified: &str) -> Vec<u8> {
    let mut body = String::new();
    if let Some(title) = &m.title {
        body += &format!(
            "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>",
            escape(title)
        );
    }
    if let Some(author) = &m.author {
        body += &format!(
            "<dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>",
            escape(author)
        );
    }
    if let Some(subject) = &m.subject {
        body += &format!(
            "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>",
            escape(subject)
        );
    }
    if let Some(keywords) = &m.keywords {
        body += &format!("<pdf:Keywords>{}</pdf:Keywords>", escape(keywords));
    }
    if let Some(producer) = &m.producer {
        body += &format!("<pdf:Producer>{}</pdf:Producer>", escape(producer));
    }
    if let Some(creator) = &m.creator {
        body += &format!("<xmp:CreatorTool>{}</xmp:CreatorTool>", escape(creator));
    }
    if let Some(created) = created {
        body += &format!("<xmp:CreateDate>{}</xmp:CreateDate>", escape(created));
    }
    body += &format!("<xmp:ModifyDate>{}</xmp:ModifyDate>", escape(modified));
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
         <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">{body}</rdf:Description>\
         </rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"
    )
    .into_bytes()
}

/// Appends a new `/Info` (keeping the keys it does not edit, `/ModDate` = `now`) and, if `had_xmp`, a regenerated XMP packet.
/// A key is written only where the value differs from what the file reads as, so a string that was cut or filtered for display is
/// not replaced by the display form when it was not edited.
pub fn write(
    doc: &mut IncrementalDocument,
    m: &MetadataValues,
    had_xmp: bool,
    now: PdfDate,
) -> Result<(), AppError> {
    let prev = doc.get_prev_documents();
    let file = read(prev)?;
    let mut info = info_dictionary(prev).cloned().unwrap_or_default();
    let info_id = prev
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| object.as_reference().ok());
    let xmp_id = prev
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Metadata").ok())
        .and_then(|object| object.as_reference().ok());
    let fields: [(&[u8], &Option<String>, &Option<String>); 6] = [
        (b"Title", &m.title, &file.values.title),
        (b"Author", &m.author, &file.values.author),
        (b"Subject", &m.subject, &file.values.subject),
        (b"Keywords", &m.keywords, &file.values.keywords),
        (b"Creator", &m.creator, &file.values.creator),
        (b"Producer", &m.producer, &file.values.producer),
    ];
    for (key, value, in_file) in fields {
        if value == in_file {
            continue;
        }
        match value {
            Some(text) => info.set(key, text_string(text)),
            None => {
                info.remove(key);
            }
        }
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
    if had_xmp {
        if let Some(id) = xmp_id {
            let packet = xmp_packet(m, file.created.as_deref(), &now.iso());
            let mut dict = Dictionary::new();
            dict.set("Type", Object::Name(b"Metadata".to_vec()));
            dict.set("Subtype", Object::Name(b"XML".to_vec()));
            doc.new_document
                .set_object(id, Object::Stream(Stream::new(dict, packet)));
        }
    }
    Ok(())
}

/// Takes the keys `/Metadata` and `/PieceInfo` out of a dictionary and the dictionaries and arrays in it.
fn strip_dictionary(dict: &mut Dictionary, depth: usize) {
    dict.remove(b"Metadata");
    dict.remove(b"PieceInfo");
    if depth < limits::MAX_COPY_NESTING {
        for (_, value) in dict.iter_mut() {
            strip_object(value, depth + 1);
        }
    }
}

fn strip_object(object: &mut Object, depth: usize) {
    if depth > limits::MAX_COPY_NESTING {
        return;
    }
    match object {
        Object::Dictionary(dict) => strip_dictionary(dict, depth),
        Object::Stream(stream) => strip_dictionary(&mut stream.dict, depth),
        Object::Array(items) => items
            .iter_mut()
            .for_each(|item| strip_object(item, depth + 1)),
        _ => {}
    }
}

/// Removes `/Info`, every `/Metadata` and every `/PieceInfo`; what only they referred to is dropped with them.
pub fn strip(doc: &mut Document) -> Result<(), AppError> {
    doc.trailer.remove(b"Info");
    for object in doc.objects.values_mut() {
        strip_object(object, 0);
    }
    // Streams that are `/Type /Metadata` and are not referenced from anywhere now go with the unreferenced objects.
    doc.prune_objects();
    Ok(())
}

/// Writes `change` on top of `bytes`: a set is an incremental update, a removal a whole new file (the caller compacts it).
pub fn apply(bytes: Vec<u8>, change: &MetadataChange) -> Result<Vec<u8>, AppError> {
    let doc = load_untrusted(&bytes)?;
    if doc.is_encrypted() {
        return Err(AppError::unsupported("encrypted"));
    }
    match change {
        MetadataChange::Set { values, had_xmp } => {
            let mut inc = IncrementalDocument::create_from(bytes, doc);
            write(&mut inc, values, *had_xmp, PdfDate::now())?;
            let mut out = Vec::new();
            inc.save_to(&mut out).map_err(failed)?;
            Ok(out)
        }
        MetadataChange::Strip => {
            let mut doc = doc;
            drop(bytes);
            strip(&mut doc)?;
            let mut out = Vec::new();
            doc.save_to(&mut out).map_err(failed)?;
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_read_strictly_and_written_as_iso() {
        assert_eq!(
            parse_date("D:20261003123045Z").as_deref(),
            Some("2026-10-03T12:30:45Z")
        );
        assert_eq!(
            parse_date("D:20261003123045+02'00'").as_deref(),
            Some("2026-10-03T12:30:45+02:00")
        );
        assert_eq!(
            parse_date("D:20261003123045-05'30").as_deref(),
            Some("2026-10-03T12:30:45-05:30")
        );
        assert_eq!(parse_date("D:2026").as_deref(), Some("2026-01-01T00:00:00"));
        assert_eq!(
            parse_date("20240229").as_deref(),
            Some("2024-02-29T00:00:00")
        );
        for bad in [
            "",
            "D:",
            "D:20261301",
            "D:20230229",
            "D:20261003250000",
            "D:2026100312304",
            "D:2026-10-03",
            "tomorrow",
            "D:20261003123045X",
            "D:20261003123045+99'00'",
        ] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_clock_is_turned_into_a_civil_date() {
        let date = PdfDate::from_unix(1_791_030_645);
        assert_eq!(date.iso(), "2026-10-03T12:30:45Z");
        assert_eq!(date.pdf(), "D:20261003123045Z");
        assert_eq!(PdfDate::from_unix(0).iso(), "1970-01-01T00:00:00Z");
        assert_eq!(
            PdfDate::from_unix(951_782_400).iso(),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn the_xmp_packet_escapes_what_it_holds() {
        let values = MetadataValues {
            title: Some("A <b> & \"c\"".to_owned()),
            ..MetadataValues::default()
        };
        let packet = String::from_utf8(xmp_packet(&values, None, "2026-10-03T00:00:00Z")).unwrap();
        assert!(packet.contains("A &lt;b&gt; &amp; &quot;c&quot;"));
        assert!(!packet.contains("<b>"));
    }
}
