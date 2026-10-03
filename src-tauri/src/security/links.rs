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
//! Everything else is refused. The confirmation dialog shows the URL as it is opened (it is ASCII, so nothing in it can reorder or
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
            !authority.is_empty() && !authority.contains('@')
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

    #[test]
    fn the_allowlist_is_exactly_the_three_schemes() {
        assert_eq!(ALLOWED_SCHEMES, ["http", "https", "mailto"]);
    }
}
