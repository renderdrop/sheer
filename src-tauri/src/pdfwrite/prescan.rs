//! The one door lopdf loads foreign bytes through (SECURITY P12, ADR-040): [`load_untrusted`] reads the raw bytes with a small PDF
//! lexer and object parser first, then calls `Document::load_mem`. No other code in `src` calls lopdf's loaders (a test pins it).
//!
//! `Document::load_mem` decodes every object stream and xref stream it finds, with no bound on the output, so a file of a few kilobytes
//! can ask for gigabytes. The pre-scan therefore reads the file the way a PDF reader tokenizes it, never by searching bytes for keys:
//! literal strings (escapes, nesting), hex strings, comments, names with `#xx`, numbers, keywords and `<<` `>>` `[` `]` with a depth
//! limit; a top-level `N G obj` header; only the **top-level** keys of a stream dictionary (a `/Length` in `/DecodeParms` is not the
//! stream's). Object and xref streams are inflated into a counter under a budget for the file as a whole; a filter chain it cannot
//! evaluate is charged at its worst case. What it cannot place is refused, not skipped: duplicate or non-name top-level keys of a stream
//! dictionary (other dictionaries are read the way lopdf reads them, last key wins), an unterminated string, dictionary or stream,
//! nesting deeper than 64, an `obj` without its two numbers, a `stream` without its dictionary. `/Length` is resolved (and refused when
//! it cannot be) only for the two kinds that are decoded, `/ObjStm` and `/XRef`; every other stream is charged nothing and ends at its
//! length when `endstream` follows, else at the next `endstream`. A number object defined twice with different values, or also defined
//! as something else, is ambiguous: a decoded stream whose length points to it is refused (lopdf may read either definition).
//!
//! The lexer is one pass over the input with an explicit depth counter (no recursion), so it ends and cannot overflow the stack.
//! It is defence in depth, not a parser to trust: the hard bound is the engine in its own process with an address-space limit
//! (M7, SECURITY P6).

use std::collections::{HashMap, HashSet};
use std::io::Read;

use flate2::read::ZlibDecoder;
use lopdf::Document;

use crate::error::{AppError, ErrorCode};
use crate::limits;

/// Most objects an object stream may claim (`/N`).
const MAX_OBJSTM_OBJECTS: u64 = 200_000;
/// Deepest nesting of `<<` and `[` that is read.
const MAX_DEPTH: usize = 64;
/// Worst case growth of a filter chain that is not just Flate (deflate's best ratio is about 1032:1).
const WORST_RATIO: u64 = 1032;

/// Loads `bytes` with lopdf after the pre-scan. The error is `damaged_file`.
pub fn load_untrusted(bytes: &[u8]) -> Result<Document, AppError> {
    check(bytes)?;
    Document::load_mem(bytes)
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("lopdf: {error}")))
}

fn refused(detail: &str) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("pre-scan: {detail}"))
}

// --- The lexer -----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok<'a> {
    /// A non-negative whole number (saturating at `u64::MAX`).
    Int(u64),
    /// A name, `#xx` escapes resolved, without the slash.
    Name(Vec<u8>),
    /// A literal or hex string (the content is not needed).
    Str,
    DictOpen,
    DictClose,
    ArrOpen,
    ArrClose,
    /// Any other run of regular characters (`obj`, `stream`, `R`, `true`, `-1`, `3.5`, ...).
    Word(&'a [u8]),
    /// A delimiter that stands alone (`{`, `}`, a stray `)` or `>`).
    Other,
    Eof,
}

const fn is_space(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

const fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

#[derive(Clone, Copy)]
struct Lexer<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn at(&self, pos: usize) -> Option<u8> {
        self.bytes.get(pos).copied()
    }

    fn next(&mut self) -> Result<Tok<'a>, AppError> {
        // White space and comments.
        loop {
            match self.at(self.pos) {
                Some(byte) if is_space(byte) => self.pos += 1,
                Some(b'%') => {
                    while self.at(self.pos).is_some_and(|b| b != 10 && b != 13) {
                        self.pos += 1;
                    }
                }
                _ => break,
            }
        }
        let Some(byte) = self.at(self.pos) else {
            return Ok(Tok::Eof);
        };
        match byte {
            b'(' => {
                self.pos += 1;
                self.literal_string()?;
                Ok(Tok::Str)
            }
            b'<' => {
                if self.at(self.pos + 1) == Some(b'<') {
                    self.pos += 2;
                    Ok(Tok::DictOpen)
                } else {
                    self.pos += 1;
                    loop {
                        match self.at(self.pos) {
                            None => return Err(refused("an unterminated hex string")),
                            Some(b'>') => break,
                            Some(_) => self.pos += 1,
                        }
                    }
                    self.pos += 1;
                    Ok(Tok::Str)
                }
            }
            b'>' => {
                if self.at(self.pos + 1) == Some(b'>') {
                    self.pos += 2;
                    Ok(Tok::DictClose)
                } else {
                    self.pos += 1;
                    Ok(Tok::Other)
                }
            }
            b'[' => {
                self.pos += 1;
                Ok(Tok::ArrOpen)
            }
            b']' => {
                self.pos += 1;
                Ok(Tok::ArrClose)
            }
            b'{' | b'}' | b')' => {
                self.pos += 1;
                Ok(Tok::Other)
            }
            b'/' => {
                self.pos += 1;
                Ok(Tok::Name(self.name()))
            }
            _ => {
                let start = self.pos;
                while self
                    .at(self.pos)
                    .is_some_and(|b| !is_space(b) && !is_delimiter(b))
                {
                    self.pos += 1;
                }
                let word = self.bytes.get(start..self.pos).unwrap_or_default();
                if !word.is_empty() && word.iter().all(u8::is_ascii_digit) {
                    let mut value = 0u64;
                    for digit in word {
                        value = value
                            .saturating_mul(10)
                            .saturating_add(u64::from(digit - b'0'));
                    }
                    Ok(Tok::Int(value))
                } else {
                    Ok(Tok::Word(word))
                }
            }
        }
    }

    /// The rest of a literal string whose `(` was read: escapes and balanced parentheses.
    fn literal_string(&mut self) -> Result<(), AppError> {
        let mut depth = 1usize;
        while let Some(byte) = self.at(self.pos) {
            self.pos += 1;
            match byte {
                b'\\' => self.pos += 1,
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(());
                    }
                }
                _ => {}
            }
        }
        Err(refused("an unterminated string"))
    }

    /// A name after its slash, with the `#xx` escapes resolved.
    fn name(&mut self) -> Vec<u8> {
        let hex = |b: Option<u8>| b.and_then(|b| char::from(b).to_digit(16));
        let mut out = Vec::new();
        while let Some(byte) = self.at(self.pos) {
            if is_space(byte) || is_delimiter(byte) {
                break;
            }
            if byte == b'#' {
                if let (Some(high), Some(low)) =
                    (hex(self.at(self.pos + 1)), hex(self.at(self.pos + 2)))
                {
                    if let Ok(value) = u8::try_from(high * 16 + low) {
                        out.push(value);
                        self.pos += 3;
                        continue;
                    }
                }
            }
            out.push(byte);
            self.pos += 1;
        }
        out
    }

    /// Reads past a container whose opener was read (`depth` 1) up to and including its matching closer.
    fn skip_container(&mut self) -> Result<(), AppError> {
        let mut depth = 1usize;
        while depth > 0 {
            match self.next()? {
                Tok::DictOpen | Tok::ArrOpen => {
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err(refused("nesting too deep"));
                    }
                }
                Tok::DictClose | Tok::ArrClose => depth -= 1,
                Tok::Eof => return Err(refused("an unterminated dictionary or array")),
                _ => {}
            }
        }
        Ok(())
    }
}

// --- The object parser ---------------------------------------------------------------------------------------------

/// What a value of a stream dictionary's top level is, as far as the scan needs it.
#[derive(Debug, PartialEq)]
enum Val {
    Int(u64),
    /// `a b R`: the number of the object it points to.
    Ref(u64),
    Name(Vec<u8>),
    /// An array of names only (a filter chain).
    Names(Vec<Vec<u8>>),
    Other,
}

fn parse_value(lx: &mut Lexer<'_>) -> Result<Val, AppError> {
    match lx.next()? {
        Tok::Int(first) => {
            let save = *lx;
            if let Tok::Int(_) = lx.next()? {
                if lx.next()? == Tok::Word(b"R") {
                    return Ok(Val::Ref(first));
                }
            }
            *lx = save;
            Ok(Val::Int(first))
        }
        Tok::Name(name) => Ok(Val::Name(name)),
        Tok::Word(word) => Ok(whole_number(word).map_or(Val::Other, Val::Int)),
        Tok::ArrOpen => {
            let mut names = Vec::new();
            let mut clean = true;
            loop {
                match lx.next()? {
                    Tok::Name(name) => names.push(name),
                    Tok::ArrClose => break,
                    Tok::DictOpen | Tok::ArrOpen => {
                        clean = false;
                        lx.skip_container()?;
                    }
                    Tok::Eof | Tok::DictClose => {
                        return Err(refused("an unterminated array"));
                    }
                    _ => clean = false,
                }
            }
            Ok(if clean { Val::Names(names) } else { Val::Other })
        }
        Tok::DictOpen => {
            lx.skip_container()?;
            Ok(Val::Other)
        }
        Tok::DictClose | Tok::ArrClose | Tok::Eof => Err(refused("a key without a value")),
        _ => Ok(Val::Other),
    }
}

/// The keys of a dictionary with the values the scan reads.
type Entries = Vec<(Vec<u8>, Val)>;

/// A non-negative whole number written as a word: `+5`, `120.0` (a plain `120` is a `Tok::Int`).
fn whole_number(word: &[u8]) -> Option<u64> {
    let word = word.strip_prefix(b"+").unwrap_or(word);
    let (int, frac) = match word.iter().position(|b| *b == b'.') {
        Some(dot) => (word.get(..dot)?, word.get(dot + 1..)?),
        None => (word, &[][..]),
    };
    if int.is_empty() && frac.is_empty() {
        return None;
    }
    if !int.iter().all(u8::is_ascii_digit) || !frac.iter().all(|b| *b == b'0') {
        return None;
    }
    Some(int.iter().fold(0u64, |value, digit| {
        value
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
    }))
}

/// A whole number object's value from the token that holds it.
fn number_of(tok: &Tok<'_>) -> Option<u64> {
    match tok {
        Tok::Int(value) => Some(*value),
        Tok::Word(word) => whole_number(word),
        _ => None,
    }
}

/// The top-level keys of a dictionary whose `<<` was read, and whether it is irregular (a key twice, or something that is not a
/// key). Only a stream dictionary is refused for that, once the `stream` keyword shows it is one (lopdf takes the last key).
fn parse_dict(lx: &mut Lexer<'_>) -> Result<(Entries, bool), AppError> {
    let mut entries: Entries = Vec::new();
    let mut irregular = false;
    loop {
        match lx.next()? {
            Tok::DictClose => return Ok((entries, irregular)),
            Tok::Name(key) => {
                if entries.iter().any(|(known, _)| *known == key) {
                    irregular = true;
                }
                let value = parse_value(lx)?;
                entries.push((key, value));
            }
            Tok::Eof => return Err(refused("an unterminated dictionary")),
            Tok::DictOpen | Tok::ArrOpen => {
                irregular = true;
                lx.skip_container()?;
            }
            _ => irregular = true,
        }
    }
}

/// The whole number objects (`9 0 obj 120 endobj`, what an indirect `/Length` points to) and every other object number seen.
#[derive(Clone, Default)]
struct Defs {
    /// The value; `None` when the number was defined twice with different values.
    numbers: HashMap<u64, Option<u64>>,
    /// Numbers defined as anything but a whole number.
    others: HashSet<u64>,
}

impl Defs {
    fn add_number(&mut self, object: u64, value: u64) {
        let entry = self.numbers.entry(object).or_insert(Some(value));
        if *entry != Some(value) {
            *entry = None;
        }
    }

    fn add_other(&mut self, object: u64) {
        self.others.insert(object);
    }

    /// `None`: no such number object. `Some(None)`: ambiguous. `Some(Some(v))`: the length.
    fn number(&self, object: u64) -> Option<Option<u64>> {
        let value = *self.numbers.get(&object)?;
        Some(if self.others.contains(&object) {
            None
        } else {
            value
        })
    }

    fn size(&self) -> usize {
        self.numbers.len() + self.others.len()
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let rest = haystack.get(from..)?;
    rest.windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// Inflates `data` into a counter, at most `budget` bytes (one more is the proof of a bomb). The number of bytes it gave.
fn inflated_size(data: &[u8], budget: u64) -> u64 {
    let mut decoder = ZlibDecoder::new(data).take(budget.saturating_add(1));
    let mut chunk = [0u8; 16 * 1024];
    let mut decoded = 0u64;
    loop {
        match decoder.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => decoded += n as u64,
        }
    }
    decoded
}

fn get<'a>(entries: &'a [(Vec<u8>, Val)], key: &[u8]) -> Option<&'a Val> {
    entries
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

/// Reads the stream after its dictionary (`lx` is just past the `stream` keyword), charges `budget` and moves `lx` past `endstream`.
fn stream(
    lx: &mut Lexer<'_>,
    entries: &[(Vec<u8>, Val)],
    defs: &Defs,
    pass: Pass,
    budget: &mut u64,
) -> Result<(), AppError> {
    let bytes = lx.bytes;
    let size = bytes.len() as u64;
    let kind = match get(entries, b"Type") {
        Some(Val::Name(name)) => name.as_slice(),
        _ => b"",
    };
    let is_objstm = kind == b"ObjStm";
    // Only these two kinds are decoded when lopdf loads a file: only they need a length that is right.
    let decoded = is_objstm || kind == b"XRef";
    let indirect = match get(entries, b"Length") {
        Some(Val::Ref(object)) => defs.number(*object),
        _ => None,
    };
    let length = if decoded {
        // Written here, or the whole number object an `a b R` points to (known after the first pass).
        let length = match get(entries, b"Length") {
            Some(Val::Int(length)) => *length,
            Some(Val::Ref(_)) => match indirect {
                Some(Some(length)) => length,
                Some(None) if pass == Pass::Charge => {
                    return Err(refused("an ambiguous indirect length"));
                }
                None if pass == Pass::Charge => {
                    return Err(refused("an indirect length that is not a number object"));
                }
                _ => 0,
            },
            None => 0,
            Some(_) => return Err(refused("a length that is not a whole number")),
        };
        if length > size {
            return Err(refused("a stream longer than the file"));
        }
        length
    } else {
        // A hint for where the data ends, nothing more.
        match get(entries, b"Length") {
            Some(Val::Int(length)) => *length,
            Some(Val::Ref(_)) => indirect.flatten().unwrap_or(0),
            _ => 0,
        }
    };
    if is_objstm {
        if let Some(Val::Int(n)) = get(entries, b"N") {
            if *n > MAX_OBJSTM_OBJECTS {
                return Err(refused("an object stream with too many objects"));
            }
        }
    }
    let mut start = lx.pos;
    match (lx.at(start), lx.at(start + 1)) {
        (Some(13), Some(10)) => start += 2,
        (Some(10 | 13), _) => start += 1,
        _ => {}
    }
    // The end: by the length when `endstream` follows it. Else the larger of the length and the distance to the next `endstream`
    // is charged (what lopdf falls back to), so an `endstream` inside the data cannot hide what the length says is there.
    let by_length = usize::try_from(length)
        .ok()
        .and_then(|length| start.checked_add(length))
        .filter(|end| *end <= bytes.len())
        .filter(|end| {
            let mut after = *end;
            while bytes.get(after).copied().is_some_and(is_space) {
                after += 1;
            }
            bytes
                .get(after..)
                .is_some_and(|rest| rest.starts_with(b"endstream"))
        });
    let (end, resume) = match by_length {
        Some(end) => {
            let after = end
                + bytes
                    .get(end..)
                    .unwrap_or_default()
                    .iter()
                    .take_while(|b| is_space(**b))
                    .count();
            (end, after + b"endstream".len())
        }
        None => {
            let found = find(bytes, b"endstream", start)
                .ok_or_else(|| refused("a stream without endstream"))?;
            let wanted = usize::try_from(length)
                .ok()
                .and_then(|length| start.checked_add(length))
                .filter(|end| *end <= bytes.len());
            if decoded {
                let wanted = wanted.ok_or_else(|| refused("a length past the end of the file"))?;
                (found.max(wanted), found + b"endstream".len())
            } else {
                (found, found + b"endstream".len())
            }
        }
    };
    let data = bytes.get(start..end).unwrap_or_default();
    lx.pos = resume;
    // The first pass only finds the stream; the other kinds are charged nothing.
    if pass == Pass::Collect || !decoded {
        return Ok(());
    }
    let charge = |budget: &mut u64, amount: u64| -> Result<(), AppError> {
        *budget = budget
            .checked_sub(amount)
            .ok_or_else(|| refused("object streams decode to too much"))?;
        Ok(())
    };
    match get(entries, b"Filter") {
        None => charge(budget, data.len() as u64),
        Some(Val::Name(name)) if is_flate(name) => charge(budget, inflated_size(data, *budget)),
        Some(Val::Names(names)) if names.len() == 1 && is_flate(&names[0]) => {
            charge(budget, inflated_size(data, *budget))
        }
        // A chain that is not just Flate, or a filter that is not written plainly: counted at its worst case.
        Some(_) => charge(budget, (data.len() as u64).saturating_mul(WORST_RATIO)),
    }
}

fn is_flate(name: &[u8]) -> bool {
    name == b"FlateDecode" || name == b"Fl"
}

/// Checks `bytes` against the bounds above: `damaged_file` for what it cannot place, a stream longer than the file, more objects in an
/// object stream than `MAX_OBJSTM_OBJECTS`, or more decoded bytes in all object and xref streams than `limits::MAX_LOAD_DECODED_BYTES`.
pub fn check(bytes: &[u8]) -> Result<(), AppError> {
    check_with(bytes, limits::MAX_LOAD_DECODED_BYTES as u64)
}

/// The first pass finds the whole number objects (`9 0 obj 120 endobj`, what an indirect `/Length` points to); the second charges.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    Collect,
    Charge,
}

fn check_with(bytes: &[u8], decoded_budget: u64) -> Result<(), AppError> {
    let mut numbers = Defs::default();
    // A stream whose length is a number object further on is skipped by its `endstream` the first time, which may lead the lexer into
    // the data of a stream that hides a fake marker: an error of such a pass is not the file's verdict (the last pass gives it), and
    // what was found is used to read again until nothing new turns up (at most three times).
    for _ in 0..3 {
        let before = numbers.size();
        let _ = pass(bytes, &mut numbers, Pass::Collect, &mut 0);
        if numbers.size() == before {
            break;
        }
    }
    let mut budget = decoded_budget;
    pass(bytes, &mut numbers, Pass::Charge, &mut budget)
}

fn pass(bytes: &[u8], objects: &mut Defs, pass: Pass, budget: &mut u64) -> Result<(), AppError> {
    let mut recent = [0u64; 2];
    let mut lx = Lexer { bytes, pos: 0 };
    // How many whole numbers came right before the token being read (`obj` needs two).
    let mut numbers = 0u8;
    // Not a number object: the entries are only read, the second pass fills in.
    let known = objects.clone();
    loop {
        match lx.next()? {
            Tok::Eof => return Ok(()),
            Tok::Int(value) => {
                numbers = (numbers + 1).min(2);
                recent = [recent[1], value];
            }
            Tok::Word(b"obj") => {
                if numbers < 2 {
                    return Err(refused("an obj without its object number"));
                }
                numbers = 0;
                let object = recent[0];
                let save = lx;
                if lx.next()? == Tok::DictOpen {
                    objects.add_other(object);
                    let (entries, irregular) = parse_dict(&mut lx)?;
                    let after_dict = lx;
                    if lx.next()? == Tok::Word(b"stream") {
                        if irregular {
                            return Err(refused(
                                "a stream dictionary with a key twice or a stray token",
                            ));
                        }
                        stream(&mut lx, &entries, &known, pass, budget)?;
                    } else {
                        lx = after_dict;
                    }
                } else {
                    lx = save;
                    // `9 0 obj 120 endobj`: a whole number object.
                    let value = lx.next()?;
                    match (number_of(&value), lx.next()?) {
                        (Some(value), Tok::Word(b"endobj")) => objects.add_number(object, value),
                        _ => objects.add_other(object),
                    }
                    lx = save;
                }
            }
            Tok::Word(b"stream") => return Err(refused("a stream without its dictionary")),
            Tok::DictOpen | Tok::ArrOpen => {
                numbers = 0;
                lx.skip_container()?;
            }
            _ => numbers = 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::write::ZlibEncoder;
    use flate2::Compression;

    use super::*;

    fn deflate(raw: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    /// A file with one stream object: `dict` between `<<` and `>>`, then `data`, with `gap` between `>>` and `stream`.
    fn file(dict: &str, gap: &str, data: &[u8]) -> Vec<u8> {
        let mut out = format!("%PDF-1.5\n4 0 obj\n<< {dict} >>{gap}stream\n").into_bytes();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out
    }

    fn objstm(n: u64, data: &[u8], length: u64) -> Vec<u8> {
        file(
            &format!("/Type /ObjStm /N {n} /First 5 /Filter /FlateDecode /Length {length}"),
            "\n",
            data,
        )
    }

    /// 3 MiB of zeros, deflated: a bomb that fits in a few kilobytes.
    fn bomb() -> Vec<u8> {
        deflate(&vec![0u8; 3 * 1024 * 1024])
    }

    const SMALL: u64 = 1024 * 1024;

    /// Refused because of what the stream inflates to, not for any other reason: it passes with room enough.
    fn refuses_by_budget(bytes: &[u8]) {
        refuses(bytes);
        assert!(check_with(bytes, 8 * 1024 * 1024).is_ok());
    }

    fn refuses(bytes: &[u8]) {
        assert_eq!(
            check_with(bytes, SMALL).unwrap_err().code(),
            ErrorCode::DamagedFile
        );
    }

    #[test]
    fn an_ordinary_object_stream_and_plain_files_pass() {
        let packed = deflate(b"1 0 << /A 1 >>");
        assert!(check(&objstm(1, &packed, packed.len() as u64)).is_ok());
        assert!(check(b"%PDF-1.4\n%%EOF\n").is_ok());
        assert!(check(b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer << /Root 1 0 R >>\nstartxref\n9\n%%EOF").is_ok());
    }

    #[test]
    fn an_implausible_n_or_length_is_refused() {
        let packed = deflate(b"x");
        let many = objstm(9_000_000, &packed, packed.len() as u64);
        assert_eq!(check(&many).unwrap_err().code(), ErrorCode::DamagedFile);
        let long = objstm(1, &packed, 4_000_000_000);
        assert_eq!(check(&long).unwrap_err().code(), ErrorCode::DamagedFile);
    }

    #[test]
    fn a_stream_that_inflates_past_the_budget_is_refused() {
        let packed = bomb();
        assert!(packed.len() < 64 * 1024, "a bomb is small");
        let file = objstm(1, &packed, packed.len() as u64);
        refuses(&file);
        assert!(check_with(&file, 4 * 1024 * 1024).is_ok());
    }

    // --- The bypasses of both security reviews ---

    #[test]
    fn an_xobj_key_as_the_last_key_does_not_hide_the_stream() {
        let packed = bomb();
        let dict = format!(
            "/Type /ObjStm /N 1 /Filter /FlateDecode /Length {} /Xobj 1",
            packed.len()
        );
        refuses_by_budget(&file(&dict, "\n", &packed));
    }

    #[test]
    fn a_fake_header_inside_a_string_or_a_comment_does_not_start_an_object() {
        let packed = bomb();
        let base = format!(
            "/Type /ObjStm /N 1 /Filter /FlateDecode /Length {}",
            packed.len()
        );
        refuses_by_budget(&file(&format!("/P (1 0 obj <<) {base}"), "\n", &packed));
        refuses_by_budget(&file(&format!("/P <31203020> {base}"), "\n", &packed));
        refuses_by_budget(&file(&format!("% 1 0 obj <<\n{base}"), "\n", &packed));
        // A string with nested parentheses and an escaped one.
        refuses_by_budget(&file(
            &format!("/P (a (1 0 obj <<) \\) b) {base}"),
            "\n",
            &packed,
        ));
    }

    #[test]
    fn a_length_inside_decode_parms_is_not_the_streams_length() {
        let packed = bomb();
        let dict =
            "/Type /ObjStm /N 1 /Filter /FlateDecode /DecodeParms << /Length 0 >> /Length 9 0 R";
        refuses_by_budget(&with_number_object(&file(dict, "\n", &packed), 9, 17));
    }

    /// `file` with the number object `<id> 0 obj <value> endobj` in front of its first object.
    fn with_number_object(file: &[u8], id: u64, value: u64) -> Vec<u8> {
        let header = b"%PDF-1.5\n";
        let mut out = header.to_vec();
        out.extend_from_slice(format!("{id} 0 obj\n{value}\nendobj\n").as_bytes());
        out.extend_from_slice(&file[header.len()..]);
        out
    }

    #[test]
    fn an_indirect_length_is_resolved_and_the_larger_figure_is_charged() {
        let dict = "/Type /ObjStm /N 1 /Filter /FlateDecode /Length 9 0 R";
        // The data starts with a fake `endstream`; the number object says how long it really is.
        let mut data = b"endstream\n".to_vec();
        data.extend(bomb());
        let right = with_number_object(&file(dict, "\n", &data), 9, data.len() as u64);
        assert!(check_with(&right, 8 * 1024 * 1024).is_ok());
        // An `endstream` inside the stream data and a length that points past it: what the length says is there is read, so the bomb
        // behind the fake marker is charged.
        let mut inner = b"x endstream y".to_vec();
        inner.extend(bomb());
        let hidden = with_number_object(&file(dict, "\n", &inner), 9, inner.len() as u64);
        assert!(check_with(&hidden, 8 * 1024 * 1024).is_ok());
        // The charge follows the length, not the first `endstream`: a chain that is counted at its worst case, behind a fake marker.
        let chain = "/Type /ObjStm /N 1 /Filter [/ASCII85Decode /FlateDecode] /Length 9 0 R";
        let mut fake = b"endstream\n".to_vec();
        fake.extend(vec![b'a'; 2000]);
        let charged = with_number_object(&file(chain, "\n", &fake), 9, fake.len() as u64);
        assert!(check_with(&charged, 8 * 1024 * 1024).is_ok());
        refuses(&charged);
    }

    #[test]
    fn an_unresolvable_or_wrong_length_is_refused() {
        let packed = deflate(b"x");
        let dict = "/Type /ObjStm /N 1 /Filter /FlateDecode /Length 9 0 R";
        // No such object, an object that is not a number, a negative or a fractional length.
        refuses(&file(dict, "\n", &packed));
        let mut not_a_number = file(dict, "\n", &packed);
        not_a_number.splice(9..9, b"9 0 obj\n<< /A 1 >>\nendobj\n".iter().copied());
        refuses(&not_a_number);
        refuses(&file("/Type /ObjStm /N 1 /Length -5", "\n", &packed));
        refuses(&file("/Type /ObjStm /N 1 /Length 1.5", "\n", &packed));
    }

    #[test]
    fn an_indirect_length_past_the_end_of_the_file_is_refused() {
        let packed = deflate(b"x");
        let dict = "/Type /ObjStm /N 1 /Filter /FlateDecode /Length 9 0 R";
        refuses(&with_number_object(
            &file(dict, "\n", &packed),
            9,
            4_000_000_000,
        ));
        // Not more than the file, but past its end from where the data starts.
        let plain = file(dict, "\n", &packed);
        let edge = with_number_object(&plain, 9, plain.len() as u64 - 10);
        refuses(&edge);
    }

    #[test]
    fn escaped_names_are_seen_for_what_they_are() {
        let packed = bomb();
        let dict = format!(
            "/Type /Obj#53tm /N 1 /Filter /Flate#44ecode /Length {}",
            packed.len()
        );
        refuses_by_budget(&file(&dict, "\n", &packed));
    }

    #[test]
    fn a_comment_before_stream_does_not_hide_it() {
        let packed = bomb();
        let dict = format!(
            "/Type /ObjStm /N 1 /Filter /FlateDecode /Length {}",
            packed.len()
        );
        refuses_by_budget(&file(&dict, " % hello\n% more\n", &packed));
    }

    // --- Ambiguity is refused or charged ---

    #[test]
    fn xref_streams_and_filter_chains_are_counted() {
        let packed = bomb();
        let len = packed.len();
        refuses(&file(
            &format!("/Type /XRef /Filter /FlateDecode /Length {len}"),
            "\n",
            &packed,
        ));
        // ASCII85 then Flate cannot be evaluated: it counts at the worst case and is refused when that does not fit.
        let chain = file(
            &format!("/Type /ObjStm /N 1 /Filter [/ASCII85Decode /FlateDecode] /Length {len}"),
            "\n",
            &packed,
        );
        assert!(check_with(&chain, 1024 * 1024 * 1024).is_ok());
        refuses(&chain);
    }

    #[test]
    fn duplicate_keys_unterminated_and_too_deep_structures_are_refused() {
        let packed = deflate(b"x");
        refuses(&file(
            "/Type /ObjStm /Type /Catalog /Length 1",
            "\n",
            &packed,
        ));
        refuses(b"%PDF-1.5\n4 0 obj\n<< /Type /Catalog (never closed >>\nendobj\n");
        refuses(b"%PDF-1.5\n4 0 obj\n<< /A <</B 1 /C ");
        refuses(b"%PDF-1.5\n4 0 obj\n<< /A <616");
        let deep = format!(
            "%PDF-1.5\n4 0 obj\n<< /A {} 1 {} >>\nendobj\n",
            "[".repeat(80),
            "]".repeat(80)
        );
        refuses(deep.as_bytes());
        refuses(b"%PDF-1.5\nobj <<>>\n");
        refuses(b"%PDF-1.5\n<< /A 1 >> stream\nxx\nendstream\n");
    }

    #[test]
    fn the_length_decides_where_the_data_ends() {
        // A fake `endstream` in the data does not cut it short while the direct length is right.
        let mut data = b"endstream\n".to_vec();
        data.extend(deflate(b"x"));
        let ok = file(
            &format!(
                "/Type /ObjStm /N 1 /Filter /FlateDecode /Length {}",
                data.len()
            ),
            "\n",
            &data,
        );
        assert!(check_with(&ok, 1024).is_ok());
        // Objects that look real inside the data of a stream are not read as objects.
        let hidden = file(
            "/Length 40",
            "\n",
            b"1 0 obj << /Type /ObjStm /N 99999999 >> ",
        );
        assert!(check_with(&hidden, 1024).is_ok());
    }

    // --- Politur: real files are not refused, ambiguity is ---

    #[test]
    fn other_streams_are_charged_nothing_and_their_length_is_not_judged() {
        let data = b"BT (hi) Tj ET";
        for length in ["120.0", "+5", "-3", "(x)", "9 0 R", "99999999999", "1.5"] {
            let dict = format!("/Length {length} /Filter /FlateDecode");
            assert!(
                check_with(&file(&dict, "\n", data), 1024).is_ok(),
                "{length}"
            );
        }
        // An indirect length that lives in an object stream (not a top-level number object).
        assert!(check_with(&file("/Length 12 0 R", "\n", data), 1024).is_ok());
        // Still lexed in order: the next object after such a stream is read.
        let mut next = file("/Length 120.0", "\n", data);
        next.extend_from_slice(
            b"5 0 obj\n<< /A 1 /A 2 /Type /ObjStm /Length 1 >>\nstream\nx\nendstream\nendobj\n",
        );
        refuses(&next);
    }

    #[test]
    fn whole_reals_and_signs_are_read_as_lengths_of_decoded_streams() {
        let packed = deflate(b"1 0 << /A 1 >>");
        let n = packed.len();
        for length in [format!("{n}.0"), format!("+{n}")] {
            let dict = format!("/Type /ObjStm /N 1 /Filter /FlateDecode /Length {length}");
            assert!(
                check_with(&file(&dict, "\n", &packed), SMALL).is_ok(),
                "{length}"
            );
        }
        // A bomb behind such a length is still charged.
        let bomb = bomb();
        let dict = format!(
            "/Type /ObjStm /N 1 /Filter /FlateDecode /Length {}.0",
            bomb.len()
        );
        refuses_by_budget(&file(&dict, "\n", &bomb));
    }

    #[test]
    fn a_number_object_defined_twice_differently_is_ambiguous() {
        let dict = "/Type /ObjStm /N 1 /Filter /FlateDecode /Length 9 0 R";
        let packed = bomb();
        let right = with_number_object(&file(dict, "\n", &packed), 9, packed.len() as u64);
        refuses_by_budget_with_room(&right);
        // The same value twice is the same definition.
        let same = with_number_object(&right, 9, packed.len() as u64);
        refuses_by_budget_with_room(&same);
        let mut differing = with_number_object(&right, 9, 5);
        differing.extend_from_slice(b"9 0 obj\n7\nendobj\n");
        assert_eq!(
            check_with(&differing, 8 * 1024 * 1024).unwrap_err().code(),
            ErrorCode::DamagedFile
        );
        // A number object that is also defined as something else.
        let mut other = right.clone();
        other.extend_from_slice(b"9 0 obj\n<< /A 1 >>\nendobj\n");
        assert_eq!(
            check_with(&other, 8 * 1024 * 1024).unwrap_err().code(),
            ErrorCode::DamagedFile
        );
        // For a stream that is not decoded the ambiguity does not matter.
        let mut plain = with_number_object(&file("/Length 9 0 R", "\n", b"abc"), 9, 3);
        plain.extend_from_slice(b"9 0 obj\n7\nendobj\n");
        assert!(check_with(&plain, 1024).is_ok());
    }

    /// Passes with room enough and is refused by the small budget: the bomb is charged.
    fn refuses_by_budget_with_room(bytes: &[u8]) {
        refuses_by_budget(bytes);
    }

    #[test]
    fn irregular_dictionaries_pass_unless_they_head_a_stream() {
        assert!(check(b"%PDF-1.4\n1 0 obj\n<< /A 1 /A 2 >>\nendobj\n").is_ok());
        assert!(
            check(b"%PDF-1.4\n1 0 obj\n<< /A 1 (stray) 7 << /B 1 >> [1] /C 2 >>\nendobj\n").is_ok()
        );
        assert!(check(
            b"%PDF-1.4\n1 0 obj\n<< /A 1 (stray) /B 2 >>\nstream\nxx\nendstream\nendobj\n"
        )
        .is_err());
        assert!(check(
            b"%PDF-1.4\n1 0 obj\n<< /A 1 << /B 1 >> /C 2 >>\nstream\nxx\nendstream\nendobj\n"
        )
        .is_err());
        // Unterminated ones are still refused.
        refuses(b"%PDF-1.4\n1 0 obj\n<< /A 1 (stray");
        refuses(b"%PDF-1.4\n1 0 obj\n<< /A 1 [ ");
    }

    // --- Termination ---

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    #[test]
    fn random_and_mutated_bytes_never_panic_and_always_end() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        // Pieces a PDF is made of, so that random mixes get deep into the parser.
        let pieces: [&[u8]; 18] = [
            b"<<",
            b">>",
            b"[",
            b"]",
            b"(",
            b")",
            b"<",
            b">",
            b"/Type",
            b"/ObjStm",
            b"/Length",
            b" 1 0 obj ",
            b" stream\n",
            b"endstream",
            b"endobj",
            b"%",
            b"\\",
            b"#4",
        ];
        for _ in 0..400 {
            let mut bytes = Vec::new();
            for _ in 0..(rng.next() % 60) {
                if rng.next().is_multiple_of(3) {
                    bytes.push(rng.next().to_le_bytes()[0]);
                } else {
                    bytes.extend_from_slice(pieces[(rng.next() % pieces.len() as u64) as usize]);
                }
            }
            let _ = check_with(&bytes, SMALL);
        }
        // Mutations of a good file and of the hostile corpus.
        let packed = deflate(b"1 0 << /A 1 >>");
        let mut seeds = vec![objstm(1, &packed, packed.len() as u64)];
        let corpus = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("malformed");
        if let Ok(entries) = std::fs::read_dir(corpus) {
            for entry in entries.flatten().take(60) {
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    if bytes.len() < 256 * 1024 {
                        seeds.push(bytes);
                    }
                }
            }
        }
        for seed in &seeds {
            let _ = check_with(seed, SMALL);
            for _ in 0..20 {
                let mut bytes = seed.clone();
                for _ in 0..=(rng.next() % 8) {
                    let at = (rng.next() % bytes.len().max(1) as u64) as usize;
                    match rng.next() % 3 {
                        0 if at < bytes.len() => bytes[at] = rng.next().to_le_bytes()[0],
                        1 => bytes.truncate(at),
                        _ => {
                            let piece = pieces[(rng.next() % pieces.len() as u64) as usize];
                            let at = at.min(bytes.len());
                            bytes.splice(at..at, piece.iter().copied());
                        }
                    }
                }
                let _ = check_with(&bytes, SMALL);
            }
        }
    }

    #[test]
    fn no_other_code_calls_a_lopdf_loader() {
        fn walk(dir: &std::path::Path, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && path.file_name().is_some_and(|n| n != "prescan.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let aliased = text.contains("lopdf::Document as")
                        || text.contains("Document as ")
                        || (text.contains("lopdf")
                            && text.contains("Reader::")
                            && !text.contains("ImageReader::"));
                    if aliased
                        || [
                            "load_mem(",
                            "load_from(",
                            "load_filtered(",
                            "load_metadata",
                            "Document::load(",
                        ]
                        .iter()
                        .any(|call| text.contains(call))
                    {
                        hits.push(path.display().to_string());
                    }
                }
            }
        }
        let mut hits = Vec::new();
        walk(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut hits,
        );
        assert!(
            hits.is_empty(),
            "raw lopdf loads outside prescan.rs: {hits:?}"
        );
    }
}
