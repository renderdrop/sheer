//! What a PDF may make the app do (SECURITY P2, P3): the rules that stand between a document's own words and the system.
//!
//! A PDF is hostile input. The engine reads links from it (`engine::links`), and nothing it says is acted on without these
//! rules: [`links`] decides which URLs may ever be opened, and gives the only value the opener accepts.

pub mod links;
pub mod navigation;
pub mod secret;
