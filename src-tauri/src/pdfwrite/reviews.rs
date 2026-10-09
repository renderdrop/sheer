//! The reply links and review states of a page's annotations as the file has them (`/IRT`, `/StateModel /Review`, `/State`).
//!
//! PDFium does not say which annotation a reply points at or what state it gives, so the model reads both here, with lopdf, after the
//! engine has read the page. The positions are the engine's (every dictionary of `/Annots` counts, popups do not; `Slots::read`).
//! A file is hostile input: the page's array is capped, a link that does not point into the array is dropped, and anything that is not
//! a state of the Review model is ignored.

use std::collections::{BTreeSet, HashMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::error::AppError;
use crate::limits;
use crate::model::annotation::ReviewState;

/// What an annotation of the file says about its place in a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReviewLink {
    /// The position of the annotation it replies to.
    pub reply_to: Option<u32>,
    /// The review state it gives that annotation.
    pub state: Option<ReviewState>,
    /// The identity of the group it belongs to (F20.7, `/IRT` + `/RT /Group`, see [`Groups`]): the same for every member and for the
    /// group's first annotation, whatever page they are on.
    pub group: Option<u64>,
}

/// Longest chain of `/RT /Group` links that is followed to the group's first annotation; a longer one is no group.
const MAX_GROUP_DEPTH: usize = 64;

fn is_group_member(doc: &Document, dict: &Dictionary) -> bool {
    matches!(
        dict.get(b"RT").ok().and_then(|rt| doc.dereference(rt).ok()),
        Some((_, Object::Name(name))) if name == b"Group"
    )
}

/// The groups of a document (ISO 32000-1 12.5.6.2): an annotation with `/RT /Group` belongs to the group of the annotation its `/IRT`
/// names. The file is hostile input: a chain is followed at most [`MAX_GROUP_DEPTH`] links; an `/IRT` that is not a reference to an
/// annotation listed on a page of the document, a popup or a ring of links makes no group (the annotation reads as one on its own).
pub struct Groups {
    /// The annotations listed on the pages (by object id), and whether each is a popup.
    listed: HashMap<ObjectId, bool>,
    /// The first annotation of the group of each listed annotation and the links to it (memoised, see `resolve`).
    resolved: HashMap<ObjectId, Option<(ObjectId, usize)>>,
    /// The identity of each group by its first annotation (only firsts that have a member).
    firsts: HashMap<ObjectId, u64>,
}

impl Groups {
    /// Scans the `/Annots` of every page (at most `limits::MAX_ANNOTS_ARRAY` entries a page, `limits::MAX_ANNOTATIONS_PER_DOC` * 4 in all).
    pub fn of(doc: &Document) -> Self {
        let mut listed: HashMap<ObjectId, bool> = HashMap::new();
        let budget = limits::MAX_ANNOTATIONS_PER_DOC.saturating_mul(4);
        'pages: for page_id in doc.get_pages().values() {
            let Ok(page) = doc.get_dictionary(*page_id) else {
                continue;
            };
            let Some(Object::Array(array)) = page
                .get(b"Annots")
                .ok()
                .and_then(|annots| doc.dereference(annots).ok())
                .map(|(_, object)| object)
            else {
                continue;
            };
            for entry in array.iter().take(limits::MAX_ANNOTS_ARRAY) {
                if listed.len() >= budget {
                    break 'pages;
                }
                if let Ok(id) = entry.as_reference() {
                    if let Ok(Object::Dictionary(dict)) = doc.get_object(id) {
                        listed.insert(id, is_popup(dict));
                    }
                }
            }
        }
        let mut groups = Self {
            listed,
            resolved: HashMap::new(),
            firsts: HashMap::new(),
        };
        let mut ids: Vec<ObjectId> = groups.listed.keys().copied().collect();
        ids.sort_unstable();
        let mut firsts: BTreeSet<ObjectId> = BTreeSet::new();
        for id in ids {
            if let Some((first, _)) = groups.resolve(doc, id) {
                firsts.insert(first);
            }
        }
        // Sorted, so the key of a duplicate `/NM` is the same on every read; a later first with a taken key gets its object number and
        // the attempt mixed in. A hostile file can forge salted names too, so the attempts are capped: a first that finds no free key
        // within MAX_KEY_ATTEMPTS makes no group (its members read as annotations on their own).
        let mut taken: HashSet<u64> = HashSet::new();
        for first in firsts {
            let free = (0..MAX_KEY_ATTEMPTS)
                .map(|attempt| identity(doc, first, attempt))
                .find(|hash| taken.insert(*hash));
            if let Some(hash) = free {
                groups.firsts.insert(first, hash);
            }
        }
        groups
    }

    /// The first annotation of the group of the listed annotation `id` and the number of links to it, memoised in `resolved` (each
    /// annotation is walked once; a walk stops at an already resolved one). `None` when `id` is no member of a valid group.
    fn resolve(&mut self, doc: &Document, id: ObjectId) -> Option<(ObjectId, usize)> {
        if let Some(done) = self.resolved.get(&id) {
            return *done;
        }
        let mut path = vec![id];
        let mut seen: HashSet<ObjectId> = HashSet::from([id]);
        // `Some((first, links from the last node of the path))`; `last_is_first` when the walk ended at a non-member.
        let mut base: Option<(ObjectId, usize)> = None;
        let mut last_is_first = false;
        // Every round stops or grows the path, and the path stops at MAX_GROUP_DEPTH; the bound says so explicitly.
        for _ in 0..MAX_GROUP_DEPTH {
            let cur = *path.last()?;
            let Ok(Object::Dictionary(at)) = doc.get_object(cur) else {
                break;
            };
            if !is_group_member(doc, at) {
                last_is_first = true;
                base = Some((cur, 0));
                break;
            }
            let Some(next) = at.get(b"IRT").ok().and_then(|o| o.as_reference().ok()) else {
                break;
            };
            // Only an annotation of the document, never a popup or a ring; a chain stays within MAX_GROUP_DEPTH links.
            if self.listed.get(&next) != Some(&false)
                || seen.contains(&next)
                || path.len() >= MAX_GROUP_DEPTH
            {
                break;
            }
            if let Some(Some((first, links))) = self.resolved.get(&next) {
                base = Some((*first, *links));
                break;
            }
            seen.insert(next);
            path.push(next);
        }
        let Some((first, base_links)) = base else {
            self.resolved.insert(id, None);
            return None;
        };
        let count = path.len();
        let mut mine = None;
        for (at, node) in path.iter().enumerate() {
            if last_is_first && at + 1 == count {
                self.resolved.insert(*node, None);
                continue;
            }
            let links = base_links + (count - 1 - at) + usize::from(!last_is_first);
            let entry = (links < MAX_GROUP_DEPTH).then_some((first, links));
            self.resolved.insert(*node, entry);
            if at == 0 {
                mine = entry;
            }
        }
        mine
    }

    /// The group's first annotation for a member `dict` (object `own`, `None` for one written in the array itself); `None` when `dict`
    /// is not a member of a valid group.
    fn first_of(
        &self,
        doc: &Document,
        dict: &Dictionary,
        own: Option<ObjectId>,
    ) -> Option<ObjectId> {
        let mut seen: Vec<ObjectId> = own.into_iter().collect();
        let mut at = dict;
        for _ in 0..MAX_GROUP_DEPTH {
            if !is_group_member(doc, at) {
                // `dict` itself is no member; anything later is the first.
                return seen.last().copied().filter(|_| !std::ptr::eq(at, dict));
            }
            let next = at.get(b"IRT").ok()?.as_reference().ok()?;
            // Only an annotation of the document, never a popup or a ring.
            if self.listed.get(&next) != Some(&false) || seen.contains(&next) {
                return None;
            }
            seen.push(next);
            let Ok(Object::Dictionary(target)) = doc.get_object(next) else {
                return None;
            };
            at = target;
        }
        None
    }

    /// The group identity of the annotation `dict` (object `own`): as a member, the identity of its group's first; as a first, its own.
    pub fn group_of(
        &self,
        doc: &Document,
        dict: &Dictionary,
        own: Option<ObjectId>,
    ) -> Option<u64> {
        if let Some(done) = own.and_then(|id| self.resolved.get(&id)) {
            let first = done.map(|(first, _)| first).or(own);
            return first.and_then(|first| self.firsts.get(&first).copied());
        }
        if let Some(first) = self.first_of(doc, dict, own) {
            return self.firsts.get(&first).copied();
        }
        own.and_then(|id| self.firsts.get(&id).copied())
    }
}

/// Most keys tried for one group's first before it is left without a group (see [`Groups::of`]).
const MAX_KEY_ATTEMPTS: u32 = 8;

/// Longest `/NM` that identifies a group's first annotation; a longer one is not looked at (the object number is used).
const MAX_NAME_BYTES: usize = 256;

/// What identifies the group whose first annotation is `first`: its `/NM`, else its object number.
///
/// From `attempt` 1 on, the object number and the attempt are mixed in as well, to tell apart two firsts of a hostile file that carry
/// the same `/NM`.
fn identity(doc: &Document, first: ObjectId, attempt: u32) -> u64 {
    let name = match doc.get_object(first) {
        Ok(Object::Dictionary(dict)) => match dict.get(b"NM") {
            Ok(Object::String(bytes, _)) if !bytes.is_empty() && bytes.len() <= MAX_NAME_BYTES => {
                Some(bytes.clone())
            }
            _ => None,
        },
        _ => None,
    };
    let mut identity = name.unwrap_or_else(|| format!("obj {} {}", first.0, first.1).into_bytes());
    if attempt > 0 {
        identity.extend_from_slice(format!("\0obj {} {} #{attempt}", first.0, first.1).as_bytes());
    }
    crate::model::annotation::group_hash(&identity)
}

fn is_popup(dict: &Dictionary) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Popup")
}

/// Longest `/State` or `/StateModel` that is read: the words of the Review and Marked models are far shorter, so a longer string is not one
/// and is not even copied.
const MAX_STATE_BYTES: usize = 16;

fn text(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Vec<u8>> {
    match doc.dereference(dict.get(key).ok()?).ok()?.1 {
        Object::String(bytes, _) | Object::Name(bytes) if bytes.len() <= MAX_STATE_BYTES => {
            Some(bytes.clone())
        }
        _ => None,
    }
}

/// The links of the annotations of page `page_index` of `bytes`, by position (only those that reply to something or give a state).
pub fn read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, ReviewLink>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let pages = doc.get_pages();
    let Some(page_id) = pages.get(&page_index.saturating_add(1)) else {
        return Ok(HashMap::new());
    };
    let Ok(page) = doc.get_dictionary(*page_id) else {
        return Ok(HashMap::new());
    };
    let entries: Vec<Object> = match page
        .get(b"Annots")
        .ok()
        .and_then(|annots| doc.dereference(annots).ok())
        .map(|(_, object)| object)
    {
        Some(Object::Array(array)) => array
            .iter()
            .take(limits::MAX_ANNOTS_ARRAY)
            .cloned()
            .collect(),
        _ => return Ok(HashMap::new()),
    };
    let mut counted: Vec<(Option<ObjectId>, &Dictionary)> = Vec::new();
    for entry in &entries {
        let Ok((id, Object::Dictionary(dict))) = doc.dereference(entry) else {
            continue;
        };
        if !is_popup(dict) {
            counted.push((entry.as_reference().ok().or(id), dict));
        }
    }
    let positions: HashMap<ObjectId, u32> = counted
        .iter()
        .zip(0u32..)
        .filter_map(|((id, _), position)| id.map(|id| (id, position)))
        .collect();
    let groups = Groups::of(&doc);
    let mut links = HashMap::new();
    for ((own, dict), position) in counted.iter().zip(0u32..) {
        let mut link = link_of(&doc, dict, position, &positions);
        link.group = groups.group_of(&doc, dict, *own);
        if link != ReviewLink::default() {
            links.insert(position, link);
        }
    }
    break_cycles(&mut links);
    Ok(links)
}

/// Takes the reply link off every annotation that is on a cycle of replies (A replies to B and B to A, or a longer ring): such a link
/// has no parent to hang under. The annotations that merely reply into a ring keep their link (the ring's members are roots).
pub(super) fn break_cycles(links: &mut HashMap<u32, ReviewLink>) {
    let mut on_cycle = Vec::new();
    for start in links.keys() {
        let mut at = *start;
        // A walk longer than the number of links has entered a ring.
        for _ in 0..=links.len() {
            match links.get(&at).and_then(|link| link.reply_to) {
                Some(parent) => at = parent,
                None => break,
            }
            if at == *start {
                on_cycle.push(*start);
                break;
            }
        }
    }
    for position in on_cycle {
        if let Some(link) = links.get_mut(&position) {
            link.reply_to = None;
        }
    }
    links.retain(|_, link| *link != ReviewLink::default());
}

/// The link of the annotation `dict` at `position`: what it replies to (`positions` maps the object ids of the page's annotations to
/// their position) and the review state it gives.
pub(super) fn link_of(
    doc: &Document,
    dict: &Dictionary,
    position: u32,
    positions: &HashMap<ObjectId, u32>,
) -> ReviewLink {
    // A note in a group (`/RT /Group`) with its first on the same page reads as a reply (F19.1); any other member of a group is linked
    // by `group` (F20.7, `DocState::link_replies` decides).
    let reply_to = dict
        .get(b"IRT")
        .ok()
        .and_then(|object| object.as_reference().ok())
        .and_then(|id| positions.get(&id).copied())
        .filter(|parent| *parent != position);
    let model = text(doc, dict, b"StateModel");
    let state = match model.as_deref() {
        Some(b"Review") | None => text(doc, dict, b"State").and_then(|s| ReviewState::from_pdf(&s)),
        Some(_) => None,
    };
    // A `/StateModel` too long to be read is not the Review model either.
    let state = if model.is_none() && dict.has(b"StateModel") {
        None
    } else {
        state
    };
    ReviewLink {
        reply_to,
        state,
        group: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn file(annots: Vec<Dictionary>) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let refs: Vec<Object> = annots
            .into_iter()
            .map(|dict| Object::Reference(doc.add_object(dict)))
            .collect();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => refs,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
            ),
        );
        let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn replies_and_states_are_read_by_position_and_popups_do_not_count() {
        // Object numbers in `file` follow the order of the list: 2 (first) is the number after the Pages id (1).
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "Contents" => Object::string_literal("hello")},
            dictionary! {"Subtype" => "Popup"},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => Object::string_literal("Review"), "State" => Object::string_literal("Completed")},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => Object::string_literal("Marked"), "State" => Object::string_literal("Marked")},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((99, 0))},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        assert_eq!(links.get(&0), None);
        assert_eq!(
            links.get(&1),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: Some(ReviewState::Completed),
                group: None
            })
        );
        assert_eq!(
            links.get(&2),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None,
                group: None
            }),
            "a state of another model is not a review state"
        );
        assert_eq!(links.get(&3), None, "a link that points nowhere is dropped");
        assert!(read_page(&bytes, 5).unwrap().is_empty());
    }

    #[test]
    fn a_state_string_longer_than_a_state_word_is_ignored() {
        let long = Object::String(vec![b'C'; 5_000_000 / 100], lopdf::StringFormat::Literal);
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight"},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "State" => long.clone()},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => long, "State" => Object::string_literal("Completed")},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        // Both still reply; neither gives a state.
        assert_eq!(
            links.get(&1),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None,
                group: None
            })
        );
        assert_eq!(
            links.get(&2),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None,
                group: None
            })
        );
    }

    #[test]
    fn replies_that_point_at_each_other_are_refused() {
        // A (1) replies to B (2) and B to A: a cycle, no link; a third replies to itself; a fourth replies into the ring and keeps its link.
        let bytes = file(vec![
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((3, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((4, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0))},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        assert_eq!(links.get(&0), None, "a cycle is no thread");
        assert_eq!(links.get(&1), None);
        assert_eq!(links.get(&3).and_then(|l| l.reply_to), Some(0));
        assert_eq!(links.get(&2), None, "a reply to itself is no reply");
    }

    fn member(irt: u32) -> Dictionary {
        dictionary! {"Subtype" => "Highlight", "IRT" => Object::Reference((irt, 0)), "RT" => "Group"}
    }

    #[test]
    fn groups_are_followed_to_their_first_and_broken_links_make_none() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "NM" => Object::string_literal("first")},
            member(2),
            // A member of a member: the same group.
            member(3),
            // A ring of two.
            member(6),
            member(5),
            // A link to nothing, and a plain reply.
            member(99),
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "RT" => "R"},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        let key = Some(crate::model::annotation::group_hash(b"first"));
        for position in 0..3 {
            assert_eq!(
                links.get(&position).and_then(|l| l.group),
                key,
                "{position}"
            );
        }
        for position in 3..7 {
            assert_eq!(
                links.get(&position).and_then(|l| l.group),
                None,
                "{position}"
            );
        }
        assert_eq!(links.get(&6).and_then(|l| l.reply_to), Some(0));
    }

    #[test]
    fn two_firsts_with_the_same_name_are_two_groups() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "NM" => Object::string_literal("dup")},
            dictionary! {"Subtype" => "Highlight", "NM" => Object::string_literal("dup")},
            member(2),
            member(3),
        ]);
        let links = read_page(&bytes, 0).unwrap();
        let group = |p: u32| links.get(&p).and_then(|l| l.group);
        assert!(group(0).is_some() && group(1).is_some());
        assert_ne!(group(0), group(1), "a duplicate /NM does not merge groups");
        assert_eq!(group(2), group(0));
        assert_eq!(group(3), group(1));
        let again = read_page(&bytes, 0).unwrap();
        assert_eq!(again.get(&0), links.get(&0), "the keys are stable");
    }

    fn named(name: &[u8]) -> Dictionary {
        dictionary! {"Subtype" => "Highlight", "NM" => Object::String(name.to_vec(), lopdf::StringFormat::Literal)}
    }

    #[test]
    // Regression file of the v2.0.0 audit (it looped with the old one-salt identity); with attempt-numbered salts it no longer
    // collides, the cap itself is covered by `a_first_whose_every_key_is_forged_makes_no_group`.
    fn a_name_forged_to_match_a_salted_key_still_ends_with_distinct_keys() {
        // The audit's file (ADR-144): A (object 2) `/NM "x"`, B (3) carries the salted name of C, C (4) `/NM "x"` again; each first
        // has one member. The old code salted C to exactly B's name and looped forever.
        let bytes = file(vec![
            named(b"x"),
            named(b"x\0obj 4 0"),
            named(b"x"),
            member(2),
            member(3),
            member(4),
        ]);
        let links = read_page(&bytes, 0).unwrap();
        let group = |p: u32| links.get(&p).and_then(|l| l.group);
        let keys: HashSet<u64> = (0..3).filter_map(group).collect();
        assert_eq!(keys.len(), 3, "three firsts, three distinct keys");
        for first in 0..3 {
            assert_eq!(group(first + 3), group(first), "{first}");
        }
        assert_eq!(read_page(&bytes, 0).unwrap(), links, "the keys are stable");
    }

    #[test]
    fn a_first_whose_every_key_is_forged_makes_no_group() {
        // A (2) `/NM "x"`; B1..B7 (3..9) carry the names of C's salted attempts 1..7; C (10) `/NM "x"`. C finds no free key within
        // MAX_KEY_ATTEMPTS and is left ungrouped, with its member; the others keep their groups.
        let last = 2 + MAX_KEY_ATTEMPTS;
        let mut annots = vec![named(b"x")];
        annots.extend(
            (1..MAX_KEY_ATTEMPTS).map(|k| named(format!("x\0obj {last} 0 #{k}").as_bytes())),
        );
        annots.push(named(b"x"));
        annots.extend((2..=last).map(member));
        let links = read_page(&file(annots), 0).unwrap();
        let group = |p: u32| links.get(&p).and_then(|l| l.group);
        let c = MAX_KEY_ATTEMPTS;
        let firsts = c + 1;
        assert_eq!(group(c), None, "C has no free key");
        assert_eq!(group(firsts + c), None, "and so neither has its member");
        let keys: HashSet<u64> = (0..c).filter_map(group).collect();
        assert_eq!(keys.len() as u32, c, "the others keep distinct keys");
        for first in 0..c {
            assert_eq!(group(firsts + first), group(first), "{first}");
        }
    }

    #[test]
    fn a_long_chain_resolves_every_member_once() {
        // 60 members chained to one first, in an order that makes each walk start from the far end.
        let mut annots = vec![dictionary! {"Subtype" => "Highlight"}];
        annots.extend((1..=60u32).map(|n| member(n + 1)));
        let links = read_page(&file(annots), 0).unwrap();
        let key = links.get(&0).and_then(|l| l.group);
        assert!(key.is_some());
        assert!((1..=60).all(|p| links.get(&p).and_then(|l| l.group) == key));
    }

    #[test]
    fn a_chain_longer_than_the_depth_cap_is_no_group() {
        let depth = MAX_GROUP_DEPTH as u32 + 2;
        let mut annots = vec![dictionary! {"Subtype" => "Highlight"}];
        // Entry n (object n + 2) links to the one before it.
        annots.extend((1..=depth).map(|n| member(n + 1)));
        let links = read_page(&file(annots), 0).unwrap();
        assert_eq!(links.get(&depth).and_then(|l| l.group), None);
        assert!(links.get(&1).and_then(|l| l.group).is_some());
    }
}
