//! Emoji reactions (G-26): the emoji check, the sealed plaintext, and the
//! fold every core computes the same way from the records held.
//!
//! - **Plaintext** (sealed with the channel key, like a message):
//!   `target [u8; 32] ‖ op u8 (1 add, 0 remove) ‖ len u8 ‖ emoji ‖ zeros`,
//!   always [`PLAINTEXT_LEN`] bytes, so the sealed length doesn't give the
//!   emoji away. Opening refuses `len > MAX_EMOJI_BYTES`, an emoji that
//!   isn't valid UTF-8 or fails [`valid_emoji`], an unknown op, or padding
//!   that isn't all zero.
//! - **Order:** the channel's records in causal order: deps first, and
//!   (claimed time, ID) only between records that are concurrent. A
//!   backdated record can't move ahead of what it depends on.
//! - **Rate:** at most [`RATE_LIMIT`] reaction records per author per
//!   channel within [`RATE_WINDOW_MS`] of each other (claimed times); the
//!   rest are ignored. Counted before opening, so every core counts the same.
//! - **State:** per (message, emoji, author) the last op in causal order
//!   wins. An add while the author already has [`PER_AUTHOR`] emoji on that
//!   message is ignored. A removed or deleted target, or an invalid
//!   plaintext, is ignored.
//! - **Shown:** the [`SHOWN`] emoji with the most authors (ties: the one
//!   that appeared first), listed in the order they first appeared.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

use records::{PublicKey, RecordId};

/// Most bytes of an emoji (after [`normalize`]).
pub const MAX_EMOJI_BYTES: usize = 32;
/// Most Unicode scalars of an emoji.
pub const MAX_EMOJI_SCALARS: usize = 10;
/// The sealed plaintext's fixed size: the target, op and length bytes, and
/// room for the longest emoji.
pub const PLAINTEXT_LEN: usize = 32 + 1 + 1 + MAX_EMOJI_BYTES;
/// Most distinct emoji one author has on one message at a time.
pub const PER_AUTHOR: usize = 10;
/// Most distinct emoji `Message.reactions` lists.
pub const SHOWN: usize = 20;
/// Most reaction records one author may have in one channel within
/// [`RATE_WINDOW_MS`] of each other.
pub const RATE_LIMIT: usize = 30;
pub const RATE_WINDOW_MS: u64 = 60_000;

const ZWJ: char = '\u{200D}';
const VS16: char = '\u{FE0F}';
const KEYCAP: char = '\u{20E3}';

fn is_skin_tone(c: char) -> bool {
    ('\u{1F3FB}'..='\u{1F3FF}').contains(&c)
}

fn is_regional_indicator(c: char) -> bool {
    ('\u{1F1E6}'..='\u{1F1FF}').contains(&c)
}

fn is_keycap_base(c: char) -> bool {
    c.is_ascii_digit() || c == '#' || c == '*'
}

/// An emoji base: the pictographic blocks and the older symbols that are
/// emoji. Never a control, bidi, whitespace, tag or private-use character.
fn is_emoji_base(c: char) -> bool {
    if is_skin_tone(c) || is_regional_indicator(c) {
        return false;
    }
    matches!(c,
        '\u{00A9}' | '\u{00AE}' | '\u{203C}' | '\u{2049}' | '\u{2122}' | '\u{2139}'
        | '\u{2194}'..='\u{2199}' | '\u{21A9}'..='\u{21AA}' | '\u{231A}'..='\u{231B}'
        | '\u{2328}' | '\u{23CF}' | '\u{23E9}'..='\u{23F3}' | '\u{23F8}'..='\u{23FA}'
        | '\u{24C2}' | '\u{25AA}'..='\u{25AB}' | '\u{25B6}' | '\u{25C0}'
        | '\u{25FB}'..='\u{25FE}' | '\u{2600}'..='\u{27BF}' | '\u{2934}'..='\u{2935}'
        | '\u{2B05}'..='\u{2B07}' | '\u{2B1B}'..='\u{2B1C}' | '\u{2B50}' | '\u{2B55}'
        | '\u{3030}' | '\u{303D}' | '\u{3297}' | '\u{3299}'
        | '\u{1F000}'..='\u{1FAFF}')
}

/// Drops one trailing U+FE0F, so 👍 and 👍+FE0F are the same emoji, then
/// checks it. `None` if it isn't one [`valid_emoji`] accepts.
pub fn normalize(emoji: &str) -> Option<String> {
    let emoji = emoji.strip_suffix(VS16).unwrap_or(emoji);
    // Stored without a trailing VS16 (`Reaction::decode` refuses one).
    (!emoji.ends_with(VS16) && valid_emoji(emoji)).then(|| emoji.to_owned())
}

/// The v1 emoji check (the UI's sanitizer must match it): 1 to
/// [`MAX_EMOJI_BYTES`] bytes and at most [`MAX_EMOJI_SCALARS`] scalars,
/// made of elements joined by single ZWJs (never first, last or doubled).
/// An element is an emoji base with at most one VS16 or skin tone straight
/// after it, a pair of regional indicators, or a keycap `[0-9#*] FE0F? 20E3`.
/// Tags (U+E0020–E007F), and so subdivision flags, aren't in v1.
pub fn valid_emoji(emoji: &str) -> bool {
    if emoji.is_empty() || emoji.len() > MAX_EMOJI_BYTES {
        return false;
    }
    let chars: Vec<char> = emoji.chars().collect();
    if chars.len() > MAX_EMOJI_SCALARS {
        return false;
    }
    let mut i = 0;
    loop {
        // One element.
        let Some(&c) = chars.get(i) else { return false };
        i += 1;
        if is_keycap_base(c) {
            if chars.get(i) == Some(&VS16) {
                i += 1;
            }
            if chars.get(i) != Some(&KEYCAP) {
                return false;
            }
            i += 1;
        } else if is_regional_indicator(c) {
            if !chars.get(i).is_some_and(|c| is_regional_indicator(*c)) {
                return false;
            }
            i += 1;
        } else if is_emoji_base(c) {
            if chars.get(i).is_some_and(|c| *c == VS16 || is_skin_tone(*c)) {
                i += 1;
            }
        } else {
            return false;
        }
        // The end, or a ZWJ and another element.
        match chars.get(i) {
            None => return true,
            Some(&ZWJ) => i += 1,
            Some(_) => return false,
        }
    }
}

/// What one reaction record says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reaction {
    pub target: RecordId,
    pub on: bool,
    /// Normalized and checked.
    pub emoji: String,
}

impl Reaction {
    /// The fixed-size plaintext; `None` for an emoji [`normalize`] refuses.
    pub fn encode(target: RecordId, emoji: &str, on: bool) -> Option<Vec<u8>> {
        let emoji = normalize(emoji)?;
        let mut out = Vec::with_capacity(PLAINTEXT_LEN);
        out.extend_from_slice(target.as_bytes());
        out.push(u8::from(on));
        out.push(emoji.len() as u8);
        out.extend_from_slice(emoji.as_bytes());
        out.resize(PLAINTEXT_LEN, 0);
        Some(out)
    }

    /// Parses an opened plaintext; `None` for anything [`Reaction::encode`]
    /// wouldn't have written (the emoji is checked as stored, not
    /// re-normalized).
    pub fn decode(plaintext: &[u8]) -> Option<Reaction> {
        if plaintext.len() != PLAINTEXT_LEN {
            return None;
        }
        let (target, rest) = plaintext.split_first_chunk::<32>()?;
        let (&op, rest) = rest.split_first()?;
        let (&len, rest) = rest.split_first()?;
        let len = usize::from(len);
        if op > 1 || len > MAX_EMOJI_BYTES {
            return None;
        }
        let (emoji, padding) = rest.split_at(len);
        if padding.iter().any(|b| *b != 0) {
            return None;
        }
        let emoji = std::str::from_utf8(emoji).ok()?;
        // Stored normalized: a trailing FE0F would be a second spelling.
        if emoji.ends_with(VS16) || !valid_emoji(emoji) {
            return None;
        }
        Some(Reaction { target: RecordId::from_bytes(*target), on: op == 1, emoji: emoji.to_owned() })
    }
}

/// A node of the causal order: an ID, its claimed time and its deps.
pub struct Node<'a> {
    pub id: RecordId,
    pub ts: u64,
    pub deps: &'a [RecordId],
}

/// The causal order of `nodes`: every record after the deps it has among
/// them, and among those ready at once, the smallest (claimed time, ID)
/// first. Deps that aren't among `nodes` count as met.
pub fn causal_order(nodes: &[Node]) -> Vec<RecordId> {
    let index: HashMap<RecordId, usize> = nodes.iter().enumerate().map(|(i, n)| (n.id, i)).collect();
    let mut waiting = vec![0usize; nodes.len()];
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (i, node) in nodes.iter().enumerate() {
        let deps: HashSet<&RecordId> = node.deps.iter().collect();
        for dep in deps {
            if let Some(&d) = index.get(dep) {
                waiting[i] += 1;
                children[d].push(i);
            }
        }
    }
    let mut ready: BinaryHeap<Reverse<(u64, RecordId, usize)>> = nodes
        .iter()
        .enumerate()
        .filter(|(i, _)| waiting[*i] == 0)
        .map(|(i, n)| Reverse((n.ts, n.id, i)))
        .collect();
    let mut order = Vec::with_capacity(nodes.len());
    while let Some(Reverse((_, id, i))) = ready.pop() {
        order.push(id);
        for &child in &children[i] {
            waiting[child] -= 1;
            if waiting[child] == 0 {
                ready.push(Reverse((nodes[child].ts, nodes[child].id, child)));
            }
        }
    }
    order
}

/// The per-author rate count of one channel, in causal order.
#[derive(Default)]
pub struct Rate {
    counted: HashMap<PublicKey, BTreeMap<u64, usize>>,
}

impl Rate {
    /// How many counted records of `author` are within the window of `ts`.
    pub fn near(&self, author: PublicKey, ts: u64) -> usize {
        let Some(times) = self.counted.get(&author) else { return 0 };
        let low = ts.saturating_sub(RATE_WINDOW_MS - 1);
        let high = ts.saturating_add(RATE_WINDOW_MS - 1);
        times.range(low..=high).map(|(_, n)| n).sum()
    }

    /// Counts the record if it is within the limit; `false` if it isn't.
    pub fn admit(&mut self, author: PublicKey, ts: u64) -> bool {
        if self.near(author, ts) >= RATE_LIMIT {
            return false;
        }
        *self.counted.entry(author).or_default().entry(ts).or_default() += 1;
        true
    }
}

/// The reactions on one message.
#[derive(Default)]
pub struct OnMessage {
    /// (emoji, author) → on.
    state: HashMap<(String, PublicKey), bool>,
    /// Where each emoji was first turned on, in causal order.
    first: HashMap<String, usize>,
    /// How many emoji each author has on.
    per_author: HashMap<PublicKey, usize>,
}

impl OnMessage {
    pub fn is_on(&self, emoji: &str, author: PublicKey) -> bool {
        self.state.get(&(emoji.to_owned(), author)).copied().unwrap_or(false)
    }

    pub fn count_of(&self, author: PublicKey) -> usize {
        self.per_author.get(&author).copied().unwrap_or(0)
    }

    /// Applies one op at causal position `at`; `false` if it is ignored
    /// (an add over [`PER_AUTHOR`]).
    pub fn apply(&mut self, author: PublicKey, emoji: &str, on: bool, at: usize) -> bool {
        let was = self.is_on(emoji, author);
        if on && !was {
            if self.count_of(author) >= PER_AUTHOR {
                return false;
            }
            *self.per_author.entry(author).or_default() += 1;
            self.first.entry(emoji.to_owned()).or_insert(at);
        } else if !on && was {
            *self.per_author.entry(author).or_default() -= 1;
        }
        self.state.insert((emoji.to_owned(), author), on);
        true
    }

    /// The emoji to show and who has each on: the [`SHOWN`] with the most
    /// authors (ties: first to appear), in the order they first appeared.
    /// Authors sorted, so every core lists them the same.
    pub fn shown(&self) -> Vec<(String, Vec<PublicKey>)> {
        let mut by_emoji: HashMap<&str, Vec<PublicKey>> = HashMap::new();
        for ((emoji, author), on) in &self.state {
            if *on {
                by_emoji.entry(emoji).or_default().push(*author);
            }
        }
        let first = |emoji: &str| self.first.get(emoji).copied().unwrap_or(usize::MAX);
        let mut list: Vec<(String, Vec<PublicKey>)> = by_emoji
            .into_iter()
            .map(|(emoji, mut authors)| {
                authors.sort();
                (emoji.to_owned(), authors)
            })
            .collect();
        list.sort_by_key(|(emoji, authors)| (Reverse(authors.len()), first(emoji)));
        list.truncate(SHOWN);
        list.sort_by_key(|(emoji, _)| first(emoji));
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> PublicKey {
        PublicKey::from_bytes([n; 32])
    }

    #[test]
    fn common_emoji_are_valid() {
        for ok in [
            "👍", "❤", "😂", "🎉", "👍🏽", "👩‍💻", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇮🇱", "🇺🇸", "1️⃣", "#⃣",
            "*️⃣", "✅", "©", "☺️", "🫶",
        ] {
            assert!(normalize(ok).is_some(), "{ok:?} {:x?}", ok.chars().map(u32::from).collect::<Vec<_>>());
        }
    }

    #[test]
    fn a_trailing_vs16_is_the_same_emoji() {
        assert_eq!(normalize("❤️").as_deref(), Some("❤"));
        assert_eq!(normalize("👍\u{FE0F}").as_deref(), Some("👍"));
        assert_eq!(normalize("👍🏻\u{FE0F}").as_deref(), Some("👍🏻"));
        // Only one is dropped: a second VS16 is never valid.
        assert_eq!(normalize("👍\u{FE0F}\u{FE0F}"), None);
    }

    #[test]
    fn fuzz_style_refusals() {
        let bad = [
            "", " ", "a", "1", "#", "*", "12", "👍 ", " 👍", "👍\n", "\u{200D}👍", "👍\u{200D}",
            "👍\u{200D}\u{200D}👍", "\u{FE0F}", "\u{FE0F}👍", "👍\u{1F3FB}\u{1F3FB}", "\u{1F3FB}",
            "👍\u{FE0F}\u{1F3FB}", "\u{20E3}", "1\u{FE0F}", "🇮", "🇮🇱🇺", "\u{202E}👍", "👍\u{202E}",
            "\u{2066}👍", "👍\u{200F}", "👍\u{0000}", "\u{0007}", "👍\u{00A0}", "👍\u{3000}",
            "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "👍\u{E0041}", "\u{E0020}",
            "\u{E000}", "👍👍", "👍a", "a\u{200D}👍", "\u{200B}👍", "👍\u{FEFF}",
        ];
        for b in bad {
            assert!(normalize(b).is_none(), "accepted {:x?}", b.chars().map(u32::from).collect::<Vec<_>>());
        }
        // Every control, bidi, whitespace and tag scalar alone, and after a
        // base, and as a joiner's partner.
        let suspects = (0u32..0x20)
            .chain(0x7F..0xA0)
            .chain([0x200B, 0x200C, 0x200E, 0x200F, 0x2028, 0x2029, 0x2060, 0xFEFF])
            .chain(0x202A..=0x202E)
            .chain(0x2066..=0x2069)
            .chain(0x2000..=0x200A)
            .chain(0xE0000..=0xE007F)
            .filter_map(char::from_u32)
            .chain(char::from_u32(0x3000))
            .chain(char::from_u32(0x00A0))
            .chain([' ', '\t']);
        for c in suspects {
            for s in [c.to_string(), format!("👍{c}"), format!("{c}👍"), format!("👍\u{200D}{c}")] {
                assert!(normalize(&s).is_none(), "accepted {:x?}", s.chars().map(u32::from).collect::<Vec<_>>());
            }
        }
        // Length limits.
        assert!(normalize(&"👍\u{200D}".repeat(5).trim_end_matches('\u{200D}').to_owned()).is_some());
        let eleven = vec!["👍"; 6].join("\u{200D}");
        assert!(normalize(&eleven).is_none(), "11 scalars");
        let long = vec!["🫶"; 5].join("\u{200D}"); // 5*4 + 4*3 = 32 bytes, 9 scalars
        assert_eq!(long.len(), 32);
        assert!(normalize(&long).is_some());
        assert!(normalize(&format!("{long}\u{1F3FB}")).is_none(), "33 bytes");
    }

    #[test]
    fn plaintext_is_fixed_size_and_strict() {
        let target = RecordId::from_bytes([7; 32]);
        let short = Reaction::encode(target, "👍", true).unwrap();
        let long = Reaction::encode(target, "👨‍👩‍👧‍👦", false).unwrap();
        assert_eq!(short.len(), PLAINTEXT_LEN);
        assert_eq!(long.len(), PLAINTEXT_LEN);
        assert_eq!(
            Reaction::decode(&short),
            Some(Reaction { target, on: true, emoji: "👍".into() })
        );
        assert_eq!(Reaction::decode(&long).unwrap().on, false);
        // Non-zero padding, a bad length, a bad op, a wrong size, bad UTF-8,
        // an invalid emoji or a stored trailing VS16: refused.
        let mut padded = short.clone();
        *padded.last_mut().unwrap() = 1;
        assert_eq!(Reaction::decode(&padded), None);
        let mut len = short.clone();
        len[33] = 33;
        assert_eq!(Reaction::decode(&len), None);
        let mut op = short.clone();
        op[32] = 2;
        assert_eq!(Reaction::decode(&op), None);
        assert_eq!(Reaction::decode(&short[..PLAINTEXT_LEN - 1]), None);
        assert_eq!(Reaction::decode(&[short.clone(), vec![0]].concat()), None);
        let mut utf8 = short.clone();
        utf8[34] = 0xFF;
        assert_eq!(Reaction::decode(&utf8), None);
        let mut spelled = short[..34].to_vec();
        spelled[33] = 7;
        spelled.extend_from_slice("👍\u{FE0F}".as_bytes());
        spelled.resize(PLAINTEXT_LEN, 0);
        assert_eq!(Reaction::decode(&spelled), None);
        let mut text = short[..34].to_vec();
        text[33] = 1;
        text.push(b'a');
        text.resize(PLAINTEXT_LEN, 0);
        assert_eq!(Reaction::decode(&text), None);
        assert_eq!(Reaction::encode(target, "a", true), None);
    }

    #[test]
    fn causal_order_puts_deps_first_whatever_the_time() {
        let id = |n: u8| RecordId::from_bytes([n; 32]);
        let (a, b, c) = (id(1), id(2), id(3));
        let deps_b = [a];
        let deps_c = [b];
        // c is backdated to before a, but depends on b, which depends on a.
        let nodes = [
            Node { id: c, ts: 1, deps: &deps_c },
            Node { id: a, ts: 100, deps: &[] },
            Node { id: b, ts: 200, deps: &deps_b },
        ];
        assert_eq!(causal_order(&nodes), [a, b, c]);
        // Concurrent records: by time, then ID.
        let nodes = [Node { id: b, ts: 5, deps: &[] }, Node { id: a, ts: 5, deps: &[] }, Node { id: c, ts: 1, deps: &[] }];
        assert_eq!(causal_order(&nodes), [c, a, b]);
    }

    #[test]
    fn rate_counts_within_a_minute_either_side() {
        let mut rate = Rate::default();
        for i in 0..RATE_LIMIT as u64 {
            assert!(rate.admit(key(1), 1_000_000 + i));
        }
        assert!(!rate.admit(key(1), 1_000_000 + 59_000), "31st within the window");
        assert!(rate.admit(key(2), 1_000_000), "per author");
        assert!(rate.admit(key(1), 1_000_000 + 30 + RATE_WINDOW_MS), "a minute later");
    }

    #[test]
    fn per_author_cap_and_last_op_wins() {
        let mut m = OnMessage::default();
        let emoji: Vec<String> = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        for (i, e) in emoji.iter().take(PER_AUTHOR).enumerate() {
            assert!(m.apply(key(1), e, true, i));
        }
        assert!(!m.apply(key(1), &emoji[10], true, 10), "an 11th is ignored");
        assert!(m.apply(key(2), &emoji[10], true, 11), "others aren't limited by it");
        assert!(m.apply(key(1), &emoji[0], false, 12));
        assert!(m.apply(key(1), &emoji[10], true, 13), "a removal frees a place");
        assert!(!m.is_on(&emoji[0], key(1)));
        let shown = m.shown();
        assert_eq!(shown.len(), 10, "emoji 1 to 10; emoji 0 was removed");
        assert_eq!(shown[0].0, emoji[1], "first-appearance order; the removed one is gone");
        assert_eq!(shown.last().unwrap(), &(emoji[10].clone(), vec![key(1), key(2)]));
    }

    /// The security lead's case: a backdated 11th reaction that depends on
    /// the earlier ten (as any record written after them does) still comes
    /// after them, so it can't displace one.
    #[test]
    fn a_backdated_reaction_does_not_displace_an_earlier_one() {
        let ids: Vec<RecordId> = (1..=11u8).map(|n| RecordId::from_bytes([n; 32])).collect();
        let deps: Vec<[RecordId; 1]> = ids.iter().map(|id| [*id]).collect();
        let mut nodes = vec![Node { id: ids[0], ts: 1_000, deps: &[] }];
        for i in 1..10 {
            nodes.push(Node { id: ids[i], ts: 1_000 + i as u64, deps: &deps[i - 1] });
        }
        // The 11th claims a time before all of them.
        nodes.push(Node { id: ids[10], ts: 1, deps: &deps[9] });
        let order = causal_order(&nodes);
        assert_eq!(order, ids, "deps first, whatever the claimed time");
        let emoji: Vec<String> = ('\u{1F600}'..='\u{1F60A}').map(String::from).collect();
        let mut m = OnMessage::default();
        for (at, id) in order.iter().enumerate() {
            let i = ids.iter().position(|x| x == id).unwrap();
            m.apply(key(1), &emoji[i], true, at);
        }
        assert!(m.is_on(&emoji[0], key(1)), "the earliest stays");
        assert!(!m.is_on(&emoji[10], key(1)), "the backdated 11th is the one ignored");
    }

    #[test]
    fn shown_keeps_the_twenty_most_popular() {
        let mut m = OnMessage::default();
        // 21 emoji by one author each, then a popular one that appeared last.
        let all: Vec<char> = ('\u{1F600}'..='\u{1F620}').collect();
        let mut at = 0;
        for (n, chunk) in all.chunks(PER_AUTHOR).enumerate() {
            for c in chunk {
                assert!(m.apply(key(n as u8 + 10), &c.to_string(), true, at));
                at += 1;
            }
        }
        let popular = all.last().unwrap().to_string();
        for k in 1..5 {
            m.apply(key(k), &popular, true, at);
            at += 1;
        }
        let shown = m.shown();
        assert_eq!(shown.len(), SHOWN);
        assert!(shown.iter().any(|(e, a)| *e == popular && a.len() == 5), "a late popular emoji isn't hidden");
        assert_eq!(shown.last().unwrap().0, popular, "listed where it first appeared");
    }
}
