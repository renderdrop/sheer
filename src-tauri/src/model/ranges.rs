//! Page range text ("1-3, 5, 8-") over a document of known page count: the parser of split (ADR-036) and of the page selection of
//! the exports (ADR-049 §2). Pure, engine-free.

use serde::Deserialize;

use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// Which pages an export or a print takes (ADR-049 §2, §4); shared by images out and print. `ranges` text is parsed with
/// [`parse_ranges`] over the page count, positions in the current order; at most `limits::MAX_EXPORT_PAGES` pages result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PageSelection {
    All,
    Current { page_id: PageId },
    Pages { pages: Vec<PageId> },
    Ranges { text: String },
}

/// Parses "1-3, 5, 8-" over a document of `count` pages: 1-based inclusive ranges in the order written. A number is a one page range,
/// `8-` runs to the last page. Anything else is `invalid_argument` (`ranges`): empty text or token, `0`, a page past the end, a range
/// that runs backwards, a number of more than six digits; more than 1 000 ranges is `limit_exceeded`.
pub fn parse_ranges(text: &str, count: u32) -> Result<Vec<(u32, u32)>, AppError> {
    let invalid = || AppError::invalid("ranges");
    let tokens: Vec<&str> = text.split(',').map(str::trim).collect();
    if tokens.len() > limits::MAX_SPLIT_OUTPUTS {
        return Err(AppError::limit("outputs", limits::MAX_SPLIT_OUTPUTS as u64));
    }
    let number = |part: &str| -> Result<u32, AppError> {
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        part.parse::<u32>().map_err(|_| invalid())
    };
    let mut ranges = Vec::with_capacity(tokens.len());
    for token in tokens {
        let (start, end) = match token.split_once('-') {
            None => {
                let page = number(token)?;
                (page, page)
            }
            Some((first, last)) => {
                let (first, last) = (first.trim(), last.trim());
                (
                    number(first)?,
                    if last.is_empty() {
                        count
                    } else {
                        number(last)?
                    },
                )
            }
        };
        if start < 1 || end < start || end > count {
            return Err(invalid());
        }
        ranges.push((start, end));
    }
    Ok(ranges)
}

/// The page positions (0-based) of each 1-based inclusive range.
pub fn groups_from_ranges(ranges: &[(u32, u32)]) -> Vec<Vec<u32>> {
    ranges
        .iter()
        .map(|&(start, end)| (start - 1..end).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn a_page_selection_parses_from_the_wire() {
        let parse = |text: &str| serde_json::from_str::<PageSelection>(text);
        assert_eq!(parse(r#"{"type":"all"}"#).unwrap(), PageSelection::All);
        assert!(matches!(
            parse(r#"{"type":"current","pageId":3}"#).unwrap(),
            PageSelection::Current { .. }
        ));
        assert_eq!(
            parse(r#"{"type":"ranges","text":"1-3, 5"}"#).unwrap(),
            PageSelection::Ranges {
                text: "1-3, 5".to_owned()
            }
        );
        assert!(parse(r#"{"type":"pages","pages":[1,2]}"#).is_ok());
        assert!(parse(r#"{"type":"ranges","text":"1","x":1}"#).is_err());
        assert!(parse(r#"{"type":"everything"}"#).is_err());
    }

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn ranges_parse_pages_spans_and_open_ends() {
        assert_eq!(
            parse_ranges("1-3, 5, 8-", 10).unwrap(),
            vec![(1, 3), (5, 5), (8, 10)]
        );
        assert_eq!(parse_ranges(" 2 - 4 ", 4).unwrap(), vec![(2, 4)]);
        assert_eq!(parse_ranges("7", 7).unwrap(), vec![(7, 7)]);
        // Overlaps and any order are the user's business: each range is a file.
        assert_eq!(
            parse_ranges("5-6,1,5-6", 6).unwrap(),
            vec![(5, 6), (1, 1), (5, 6)]
        );
        assert_eq!(parse_ranges("3-", 3).unwrap(), vec![(3, 3)]);
    }

    #[test]
    fn ranges_refuse_everything_else() {
        for bad in [
            "", " ", ",", "1,", ",1", "1,,2", "0", "0-3", "1-0", "3-2", "11", "1-11", "12-", "-3",
            "a", "1-a", "1 2", "1--2", "+1", "1.5", "-", "1-2-3", "１", "0000001", "9999999",
        ] {
            assert_eq!(
                code(parse_ranges(bad, 10)),
                ErrorCode::InvalidArgument,
                "{bad:?}"
            );
        }
        let many = vec!["1"; limits::MAX_SPLIT_OUTPUTS + 1].join(",");
        assert_eq!(code(parse_ranges(&many, 10)), ErrorCode::LimitExceeded);
        assert_eq!(code(parse_ranges("1", 0)), ErrorCode::InvalidArgument);
        // The last allowed number of ranges works.
        let max = vec!["1"; limits::MAX_SPLIT_OUTPUTS].join(",");
        assert_eq!(
            parse_ranges(&max, 10).unwrap().len(),
            limits::MAX_SPLIT_OUTPUTS
        );
    }
}
