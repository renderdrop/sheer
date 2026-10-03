//! Which URLs a link in a PDF may open (SECURITY P3): `http`, `https` and `mailto`, and only the plain, strictly spelled ones.
//!
//! The URL of a link comes from the document, and the opener hands it to the operating system (`ShellExecute` on Windows, `open`
//! on macOS), which does what the URL says: a `file:` URL opens a file, a custom scheme starts whatever registered it, and on
//! Windows a string that is not a URL at all is run as a program. So the rule is an allowlist and it is strict. [`classify`]
//! is the one function that turns a string from a PDF into a [`SafeUrl`], and a `SafeUrl` is the only thing the opener takes, so a
//! URL that was not classified cannot be opened: the type says so.
//!
//! What passes: at most `limits::MAX_URL_LEN` bytes, every one of them a character RFC 3986 allows in a URL (letters, digits,
//! `-._~`, the reserved characters `:/?#[]@!$&'()*+,;=` and `%` followed by two hex digits). So no space, quote, backslash, angle
//! bracket, control or non-ASCII character: those have to be percent-encoded in a URL and a link that is not is not opened. A quote
//! or a space is how a URL breaks out of the command line that a browser is started with. Then the scheme (case does not matter):
//!
//! - `http` and `https` need `//`, a host and no `user@` in front of it (the old trick of `https://bank.example@evil.example`);
//! - `mailto` needs an address, and may not carry `attach`, `attachment` or `attachments` as a parameter: some mail programs read
//!   them as a file to attach.
//!
//! Everything else is refused. The confirmation dialog shows the host on a line of its own (with `xn--` labels decoded beside the
//! `xn--` form, [`summarize`]) and the URL cut to a readable length, as it is opened (it is ASCII, so nothing in it can reorder or
//! hide text).

use crate::limits;

/// The schemes a link may open.
pub const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// A URL that passed [`classify`]. The only value the opener takes; it cannot be made any other way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeUrl(String);

impl SafeUrl {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Whether `byte` may appear in a URL: RFC 3986's unreserved and reserved characters, and `%`.
fn is_url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'['
                | b']'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b'%'
        )
}

/// Whether every `%` of `bytes` is followed by two hex digits.
fn percent_encoding_is_valid(bytes: &[u8]) -> bool {
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = |offset: usize| bytes.get(at + offset).is_some_and(u8::is_ascii_hexdigit);
            if !(hex(1) && hex(2)) {
                return false;
            }
            at += 3;
        } else {
            at += 1;
        }
    }
    true
}

/// `text` with its percent-encoded bytes decoded and lowercased, for looking for a word that may have been spelled with `%61`.
/// Only used to look at a parameter name, never to build a URL. A byte that is not ASCII after decoding is dropped.
fn decoded_lowercase(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |at: usize| {
        bytes
            .get(at)
            .and_then(|&digit| char::from(digit).to_digit(16))
            .and_then(|digit| u8::try_from(digit).ok())
    };
    let mut out = String::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let mut byte = bytes[at];
        if byte == b'%' {
            if let (Some(high), Some(low)) = (hex(at + 1), hex(at + 2)) {
                byte = high * 16 + low;
                at += 2;
            }
        }
        if byte.is_ascii() {
            out.push(char::from(byte.to_ascii_lowercase()));
        }
        at += 1;
    }
    out
}

/// Whether the query of a `mailto:` URL has a parameter that some mail programs read as a file to attach.
fn mailto_attaches(query: &str) -> bool {
    query.split('&').any(|parameter| {
        let name = parameter.split('=').next().unwrap_or_default();
        decoded_lowercase(name).starts_with("attach")
    })
}

/// Whether `host` is DNS-style (ASCII letters, digits and hyphens in dot-separated labels, no empty label, no hyphen at either end
/// of a label, at most 253 bytes) or a bracketed IPv6 literal.
fn is_valid_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// Whether `authority` is a real host, optionally followed by `:port` (1 to 5 digits, at most 65535), and has no credentials.
fn is_valid_authority(authority: &str) -> bool {
    let (host, port) = if authority.starts_with('[') {
        match authority.rfind(']') {
            Some(end) => {
                let (host, tail) = authority.split_at(end + 1);
                match tail {
                    "" => (host, None),
                    _ => match tail.strip_prefix(':') {
                        Some(port) => (host, Some(port)),
                        None => return false,
                    },
                }
            }
            None => return false,
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    let port_ok = port.is_none_or(|p| {
        (1..=5).contains(&p.len())
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u32>().is_ok_and(|n| n <= 65535)
    });
    port_ok && is_valid_host(host)
}

/// The URL of a link as the opener may take it, or `None` if the link may not be opened (see the module documentation).
pub fn classify(raw: &str) -> Option<SafeUrl> {
    let bytes = raw.as_bytes();
    if bytes.is_empty()
        || bytes.len() > limits::MAX_URL_LEN
        || !bytes.iter().copied().all(is_url_byte)
        || !percent_encoding_is_valid(bytes)
    {
        return None;
    }
    let (scheme, rest) = raw.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return None;
    }
    let allowed = match scheme.as_str() {
        "http" | "https" => {
            let authority = rest.strip_prefix("//")?;
            let authority = authority.split(['/', '?', '#']).next().unwrap_or_default();
            is_valid_authority(authority)
        }
        _ => {
            // mailto: an address, then maybe `?parameters`; a `//` after the scheme is not a mail address.
            let (address, query) = rest.split_once('?').unwrap_or((rest, ""));
            let fragmentless = address.split('#').next().unwrap_or_default();
            !fragmentless.is_empty() && !rest.starts_with("//") && !mailto_attaches(query)
        }
    };
    allowed.then(|| SafeUrl(raw.to_owned()))
}
/// How much of a URL the confirmation dialog shows: a link in a document can be thousands of bytes long, and a dialog that scrolls
/// hides the part the user should read (the host), so the rest is cut with `…`. The host is shown by itself above it.
pub const MAX_SHOWN_URL_CHARS: usize = 120;

/// The text of a [`SafeUrl`] for the confirmation dialog (SECURITY P3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlSummary {
    /// Where the link goes, as the URL spells it (lowercased, with the port): `xn--` labels stay as they are. For `mailto:` the
    /// domain of the address. Empty if there is none.
    pub host: String,
    /// The host with its `xn--` labels decoded, when it has any and every decoded character is a letter or digit (a name that
    /// decodes to a control or direction character is shown as `xn--` only). It is shown beside the `xn--` form, never instead
    /// of it: a decoded name can be a look-alike of another.
    pub host_decoded: Option<String>,
    /// The URL, cut to [`MAX_SHOWN_URL_CHARS`] characters (it is ASCII, so a cut cannot split a character) with `…` at the cut.
    pub shown: String,
    pub truncated: bool,
}

impl UrlSummary {
    /// The block that replaces `{url}` in the dialog text: the host on a line of its own, then the URL.
    pub fn dialog_text(&self) -> String {
        let host = match &self.host_decoded {
            Some(decoded) => format!("{} ({decoded})", self.host),
            None => self.host.clone(),
        };
        if host.is_empty() {
            self.shown.clone()
        } else {
            format!("{host}\n\n{}", self.shown)
        }
    }
}

/// Describes `url` for the dialog: its host, the host with punycode decoded, and the URL shortened.
pub fn summarize(url: &SafeUrl) -> UrlSummary {
    let text = url.as_str();
    let (scheme, rest) = text.split_once(':').unwrap_or(("", text));
    let host_part = if scheme.eq_ignore_ascii_case("mailto") {
        let address = rest.split(['?', '#']).next().unwrap_or_default();
        address.rsplit_once('@').map_or("", |(_, domain)| domain)
    } else {
        let authority = rest.strip_prefix("//").unwrap_or_default();
        authority.split(['/', '?', '#']).next().unwrap_or_default()
    };
    let host = host_part.to_ascii_lowercase();
    let host_decoded = decode_host(&host);
    let (shown, truncated) = if text.chars().count() > MAX_SHOWN_URL_CHARS {
        let cut: String = text.chars().take(MAX_SHOWN_URL_CHARS).collect();
        (format!("{cut}…"), true)
    } else {
        (text.to_owned(), false)
    };
    UrlSummary {
        host,
        host_decoded,
        shown,
        truncated,
    }
}

/// `host` with every `xn--` label decoded, or `None` if it has none, one does not decode, or the result has anything but letters,
/// digits, dots and hyphens in it. A port after the host is kept.
fn decode_host(host: &str) -> Option<String> {
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if !port.contains(']') => (name, Some(port)),
        _ => (host, None),
    };
    if !name.split('.').any(|label| label.starts_with("xn--")) {
        return None;
    }
    let labels: Option<Vec<String>> = name
        .split('.')
        .map(|label| match label.strip_prefix("xn--") {
            Some(encoded) => punycode_decode(encoded),
            None => Some(label.to_owned()),
        })
        .collect();
    let decoded = labels?.join(".");
    if !decoded
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    Some(match port {
        Some(port) => format!("{decoded}:{port}"),
        None => decoded,
    })
}

/// Decodes one punycode label without its `xn--` prefix (RFC 3492). `None` for anything malformed or too big.
fn punycode_decode(input: &str) -> Option<String> {
    const BASE: u32 = 36;
    const T_MIN: u32 = 1;
    const T_MAX: u32 = 26;
    const MAX_CHARS: usize = 63;
    if !input.is_ascii() || input.len() > MAX_CHARS {
        return None;
    }
    let (basic, encoded) = match input.rfind('-') {
        Some(at) => (&input[..at], &input[at + 1..]),
        None => ("", input),
    };
    let mut output: Vec<char> = basic.chars().collect();
    let (mut n, mut i, mut bias) = (128u32, 0u32, 72u32);
    let mut digits = encoded.bytes().peekable();
    while digits.peek().is_some() {
        let old_i = i;
        let (mut weight, mut k) = (1u32, BASE);
        loop {
            let digit = match digits.next()? {
                c @ b'a'..=b'z' => u32::from(c - b'a'),
                c @ b'A'..=b'Z' => u32::from(c - b'A'),
                c @ b'0'..=b'9' => u32::from(c - b'0') + 26,
                _ => return None,
            };
            i = i.checked_add(digit.checked_mul(weight)?)?;
            let threshold = if k <= bias {
                T_MIN
            } else if k >= bias + T_MAX {
                T_MAX
            } else {
                k - bias
            };
            if digit < threshold {
                break;
            }
            weight = weight.checked_mul(BASE - threshold)?;
            k += BASE;
        }
        let count = u32::try_from(output.len() + 1).ok()?;
        bias = adapt(i - old_i, count, old_i == 0);
        n = n.checked_add(i / count)?;
        i %= count;
        output.insert(usize::try_from(i).ok()?, char::from_u32(n)?);
        if output.len() > MAX_CHARS {
            return None;
        }
        i += 1;
    }
    Some(output.into_iter().collect())
}

/// The bias adaptation of RFC 3492 section 6.1.
fn adapt(delta: u32, count: u32, first: bool) -> u32 {
    let mut delta = if first { delta / 700 } else { delta / 2 };
    delta += delta / count;
    let mut k = 0;
    while delta > 455 {
        delta /= 35;
        k += 36;
    }
    k + 36 * delta / (delta + 38)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted(url: &str) -> bool {
        classify(url).is_some()
    }

    #[test]
    fn plain_web_and_mail_urls_pass_unchanged() {
        for url in [
            "http://example.com",
            "https://example.com/path/to/page.html?query=a%20b&x=1#fragment",
            "HTTPS://EXAMPLE.COM/",
            "https://example.com:8443/a",
            "https://[2001:db8::1]/",
            "https://example.com/it's(fine)*;,+!$",
            "mailto:someone@example.com",
            "mailto:someone@example.com?subject=Hello%20there&body=Hi",
            "MAILTO:a@b.c",
        ] {
            let safe = classify(url).unwrap_or_else(|| panic!("{url} was refused"));
            assert_eq!(safe.as_str(), url, "the URL is not rewritten");
        }
    }

    #[test]
    fn every_other_scheme_is_refused() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "file://server/share/payload.exe",
            "javascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "ftp://example.com/",
            "ssh://example.com/",
            "tel:+4930123456",
            "sms:+4930123456",
            "ms-msdt:/id%20PCWDiagnostic",
            "vbscript:msgbox(1)",
            "steam://run/1",
            "slack://open",
            "about:blank",
            "blob:https://example.com/1",
            "view-source:https://example.com",
            // Not a URL at all: on Windows ShellExecute would run it.
            "calc.exe",
            "C:\\Windows\\System32\\calc.exe",
            "\\\\server\\share\\payload.exe",
            "/usr/bin/open",
            "www.example.com",
            "example.com:8080/path",
            "",
            ":",
            "//example.com/",
        ] {
            assert!(!accepted(url), "{url} was accepted");
        }
    }

    #[test]
    fn a_scheme_has_to_be_spelled_out_exactly() {
        for url in [
            " http://example.com",
            "http://example.com ",
            "http ://example.com",
            "ht\ttp://example.com",
            "https//example.com",
            "https:/example.com",
            "https:example.com",
            "https:///path",
            "https://",
            "https://?x=1",
            "https://#frag",
            "https:\\\\example.com",
            "httpx://example.com",
            "xhttp://example.com",
            "http:://example.com",
        ] {
            assert!(!accepted(url), "{url:?} was accepted");
        }
    }

    #[test]
    fn a_url_that_could_break_out_of_a_command_line_or_hide_its_host_is_refused() {
        for url in [
            // Quotes, spaces and the characters a URL has to percent-encode.
            "https://example.com/a b",
            "https://example.com/\"--no-sandbox",
            "https://example.com/'><script>",
            "https://example.com/<a>",
            "https://example.com/a\\b",
            "https://example.com/a^b",
            "https://example.com/a`b",
            "https://example.com/{a}",
            "https://example.com/a|b",
            // Control characters, a line break, NUL.
            "https://example.com/a\nb",
            "https://example.com/a\rb",
            "https://example.com/a\tb",
            "https://example.com/a\0b",
            "https://example.com/\u{7f}",
            // Not ASCII: a look-alike host, a direction override, a zero-width character.
            "https://exаmple.com/",
            "https://example.com/\u{202e}txt.exe",
            "https://example.com/\u{200b}",
            "https://münchen.example/",
            // A broken percent-encoding.
            "https://example.com/100%",
            "https://example.com/%zz",
            "https://example.com/%4",
            // Credentials in front of the host.
            "https://paypal.com@evil.example/",
            "https://user:password@example.com/",
            "http://@example.com/",
        ] {
            assert!(!accepted(url), "{url:?} was accepted");
        }
        assert!(accepted("https://example.com/%7Euser/100%25"));
        // An `@` after the host is part of a path or a query and harmless.
        assert!(accepted("https://example.com/@user"));
        assert!(accepted("https://example.com/?email=a@b.c"));
    }

    #[test]
    fn a_web_url_needs_a_real_host() {
        for url in [
            "https://%00",
            "https://.",
            "http://:80",
            "https://a..b",
            "https://-a.com",
            "https://a-.com",
            "https://a.com.:80x",
            "https://a.com:99999",
            "https://a.com:123456",
            "https://a.com:",
            "https://[zz]",
            "https://[::1",
            "https://[::1]x",
            "https://ex%61mple.com",
        ] {
            assert!(!accepted(url), "{url:?} was accepted");
        }
        for url in [
            "https://example.com:8443/x",
            "https://xn--bcher-kva.de",
            "https://[::1]/",
            "https://[::1]:8080/",
            "http://127.0.0.1",
            "https://a.com:65535",
        ] {
            assert!(accepted(url), "{url:?} was refused");
        }
    }

    #[test]
    fn a_mail_link_needs_an_address_and_may_not_ask_for_an_attachment() {
        for url in [
            "mailto:",
            "mailto:?subject=x",
            "mailto:#",
            "mailto://someone@example.com",
            "mailto:a@b.c?attach=C:/secret.txt",
            "mailto:a@b.c?subject=x&attachment=file",
            "mailto:a@b.c?Attachments=file",
            "mailto:a@b.c?%61ttach=file",
            "mailto:a@b.c?x=1&ATTACH=file",
        ] {
            assert!(!accepted(url), "{url:?} was accepted");
        }
        // A word that merely contains the letters in a value is fine.
        assert!(accepted("mailto:a@b.c?subject=attach%20me"));
        assert!(accepted("mailto:a@b.c?cc=x@y.z&body=see%20attachment"));
    }

    #[test]
    fn the_length_limit_counts_bytes_and_is_inclusive() {
        let prefix = "https://example.com/";
        let at_limit = format!("{prefix}{}", "a".repeat(limits::MAX_URL_LEN - prefix.len()));
        assert_eq!(at_limit.len(), limits::MAX_URL_LEN);
        assert!(accepted(&at_limit));
        assert!(!accepted(&format!("{at_limit}a")));
        assert!(!accepted(&"a".repeat(1_000_000)));
    }

    fn summary(url: &str) -> UrlSummary {
        summarize(&classify(url).expect("a URL the allowlist takes"))
    }

    #[test]
    fn the_host_is_shown_by_itself_and_punycode_is_decoded_beside_the_xn_form() {
        let plain = summary("https://Example.com:8443/a?b=c");
        assert_eq!(plain.host, "example.com:8443");
        assert_eq!(plain.host_decoded, None);
        assert_eq!(
            plain.dialog_text(),
            "example.com:8443\n\nhttps://Example.com:8443/a?b=c"
        );

        let idn = summary("https://xn--bcher-kva.example/");
        assert_eq!(idn.host, "xn--bcher-kva.example");
        assert_eq!(idn.host_decoded.as_deref(), Some("bücher.example"));
        assert_eq!(
            idn.dialog_text(),
            "xn--bcher-kva.example (bücher.example)\n\nhttps://xn--bcher-kva.example/"
        );
        // A look-alike of a Latin name (Cyrillic letters), with a port.
        assert_eq!(punycode_decode("80ak6aa92e").as_deref(), Some("аррӏе"));
        assert_eq!(
            summary("https://xn--80ak6aa92e.com:81/")
                .host_decoded
                .as_deref(),
            Some("аррӏе.com:81")
        );
    }

    #[test]
    fn broken_or_unfit_punycode_is_shown_as_xn_only() {
        for label in [
            "",
            "-",
            "a-",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "ab!c",
            "99999999999999",
        ] {
            // Whatever it is, it neither panics nor decodes to something with a control character.
            if let Some(decoded) = punycode_decode(label) {
                assert!(decoded.chars().all(|c| !c.is_control()));
            }
        }
        assert_eq!(summary("https://xn--zzzzzzzzzzzz.com/").host_decoded, None);
        assert_eq!(
            summary("https://example.com/xn--bcher-kva").host_decoded,
            None
        );
    }

    #[test]
    fn a_long_url_is_cut_and_the_cut_is_marked() {
        let long = format!("https://example.com/{}", "a".repeat(2000));
        let shown = summary(&long);
        assert!(shown.truncated);
        assert_eq!(shown.shown.chars().count(), MAX_SHOWN_URL_CHARS + 1);
        assert!(shown.shown.ends_with('…'));
        assert!(shown
            .dialog_text()
            .starts_with("example.com\n\nhttps://example.com/"));
        let exact = format!(
            "https://example.com/{}",
            "a".repeat(MAX_SHOWN_URL_CHARS - "https://example.com/".len())
        );
        assert_eq!(exact.len(), MAX_SHOWN_URL_CHARS);
        assert!(!summary(&exact).truncated);
    }

    #[test]
    fn a_mail_link_shows_the_domain_of_its_address() {
        let mail = summary("mailto:someone@Example.com?subject=hi");
        assert_eq!(mail.host, "example.com");
        assert_eq!(summary("mailto:someone").host, "");
        assert_eq!(summary("mailto:someone").dialog_text(), "mailto:someone");
        assert_eq!(summary("https://[::1]:8080/").host, "[::1]:8080");
    }
    #[test]
    fn the_allowlist_is_exactly_the_three_schemes() {
        assert_eq!(ALLOWED_SCHEMES, ["http", "https", "mailto"]);
    }
}
