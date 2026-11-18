//! Channel messages: judged by `authority` against the control log, sealed
//! and opened through the [`GroupCipher`].
//!
//! - Every channel record is judged with `authority::check_channel` over the
//!   channel records held ([`Graph`]). Only `Accept` counts: pending, refused
//!   and voided records are neither shown nor used.
//! - Every `KeyRotation` record goes to `apply_rotation` once (accepted or
//!   not); the accepted ones go to `set_accepted` (deny by default, GAP-5).
//! - An accepted `Message` is decrypted; a body that doesn't open, or opens
//!   under a rotation authority doesn't accept (`Opened.accepted == false`,
//!   #21), or whose text is over `message_text_ok`, isn't shown.
//!
//! TODO(#21): show untrusted messages as such instead of hiding them.
//! TODO(groupkeys): re-request the part records `apply_rotation` evicted.
//! TODO(B4-4): re-check pending records when what they wait for arrives
//! (today every read judges again from scratch).

use std::collections::{BTreeSet, HashMap, HashSet};

use authority::{
    check_channel, check_stub, message_text_ok, ChannelGraph, Entry, Resolver, State, Verdict,
};
use records::{ChannelId, Kind, PublicKey, Record, RecordId, Scope, ServerId, Stub, MAX_DEPS};

use crate::model::Log;
use crate::ports::{CipherError, GroupCipher, Opened};
use crate::reaction::{causal_order, Gate, Node, OnMessage, Reaction};

/// The channel records of one server, as `authority` asks about them: full
/// records, and the stubs of pruned ones (B6-p), served by `entry`.
pub(crate) struct Graph<'a> {
    by_id: HashMap<RecordId, &'a Record>,
    stubs: &'a HashMap<RecordId, Stub>,
    children: HashMap<RecordId, Vec<RecordId>>,
}

impl<'a> Graph<'a> {
    pub fn new(records: &'a [Record], stubs: &'a HashMap<RecordId, Stub>) -> Graph<'a> {
        let mut children: HashMap<RecordId, Vec<RecordId>> = HashMap::new();
        let edges = records
            .iter()
            .map(|r| (r.id(), r.deps()))
            .chain(stubs.values().map(|s| (s.id(), s.deps())));
        for (id, deps) in edges {
            for dep in deps {
                children.entry(*dep).or_default().push(id);
            }
        }
        Graph { by_id: records.iter().map(|r| (r.id(), r)).collect(), stubs, children }
    }

    fn deps(&self, id: RecordId) -> Option<&[RecordId]> {
        match self.by_id.get(&id) {
            Some(record) => Some(record.deps()),
            None => self.stubs.get(&id).map(Stub::deps),
        }
    }
}

impl ChannelGraph for Graph<'_> {
    fn is_ancestor(&self, ancestor: RecordId, of: RecordId) -> bool {
        let mut seen = HashSet::new();
        let mut stack = vec![of];
        while let Some(id) = stack.pop() {
            if id == ancestor {
                return true;
            }
            if seen.insert(id) {
                stack.extend(self.deps(id).unwrap_or_default().iter().copied());
            }
        }
        false
    }

    fn record(&self, id: RecordId) -> Option<Record> {
        self.by_id.get(&id).map(|r| (*r).clone())
    }

    fn entry(&self, id: RecordId) -> Option<Entry> {
        match self.by_id.get(&id) {
            Some(record) => Some(Entry::Full((*record).clone())),
            None => self.stubs.get(&id).cloned().map(Entry::Pruned),
        }
    }

    fn children(&self, id: RecordId) -> Vec<RecordId> {
        self.children.get(&id).cloned().unwrap_or_default()
    }
}

/// Whether authority accepts a held stub (a held, accepted delete or newer
/// edit replaced its record).
fn stub_accepted(resolver: &Resolver, stub: &Stub, graph: &Graph) -> bool {
    check_stub(resolver, stub, graph) == Verdict::Accept
}

/// The records of `channel`, in the order they were added.
pub(crate) fn channel_records(log: &Log, channel: ChannelId) -> Vec<Record> {
    log.channel.iter().filter(|r| r.scope() == Scope::Channel(channel)).cloned().collect()
}

fn accepted(resolver: &Resolver, record: &Record, graph: &Graph) -> bool {
    check_channel(resolver, record, graph) == Verdict::Accept
}

/// The channels authority knows for `server`: those its accepted
/// `ChannelCreate` records made (`State.channels`, #113). A server from
/// before #113 has none and keeps its derived #general. Nothing about any
/// other channel ever reaches the cipher, whatever records name it.
pub(crate) fn known_channels(server: ServerId, state: &State) -> BTreeSet<ChannelId> {
    let mut known: BTreeSet<ChannelId> = state.channels.keys().copied().collect();
    if known.is_empty() {
        known.insert(crate::model::default_channel(server));
    }
    known
}

fn in_known(record: &Record, known: &BTreeSet<ChannelId>) -> bool {
    matches!(record.scope(), Scope::Channel(c) if known.contains(&c))
}

/// Brings the cipher up to date for `server`, in the order it needs:
/// the known channels, then the accepted rotations, then every stored
/// rotation of those channels. Done before every read and send, so an
/// unlock (which starts from nothing) or a lock in between loses nothing;
/// a rotation it already holds is a no-op (`Applied::Duplicate`).
/// TODO(perf): replay only after an unlock, once the core drives it.
pub(crate) fn sync_cipher(cipher: &dyn GroupCipher, server: ServerId, log: &Log) {
    let known = known_channels(server, log.resolver.state());
    cipher.set_channels(server, &known);
    let graph = Graph::new(&log.channel, &log.stubs);
    let rotations: Vec<&Record> = log
        .channel
        .iter()
        .filter(|r| r.kind() == Kind::KeyRotation && in_known(r, &known))
        .collect();
    let ok: BTreeSet<RecordId> =
        rotations.iter().filter(|r| accepted(&log.resolver, r, &graph)).map(|r| r.id()).collect();
    cipher.set_accepted(server, &ok);
    for record in rotations {
        // An error is a rotation we can't use; nothing else to do.
        let _ = cipher.apply_rotation(record);
    }
}

/// A shown message: its record (full or pruned) and opened text.
pub(crate) struct Shown {
    pub record: Meta,
    /// The latest accepted edit's text, else the original; empty once deleted.
    pub text: String,
    /// The claimed time of the edit shown, if any.
    pub edited_at: Option<u64>,
    /// A tombstone: the message keeps its place, its text is gone.
    pub deleted: bool,
    /// G-26: the emoji shown under it and who has each on
    /// (`reaction::OnMessage::shown`); none on a deleted message.
    pub reactions: Vec<(String, Vec<PublicKey>)>,
    /// A placeholder: the message keeps its place, but its text doesn't
    /// open here (TODO #21, the PO's table). `text` is empty, with no
    /// reactions.
    pub unreadable: Option<Unreadable>,
}

/// Why a shown message has no text (the PO's placeholder rules).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unreadable {
    /// Sealed under a key this device doesn't hold, by someone who had
    /// already seen me join (the lost-message P1 residual). Not final: a
    /// later rotation may open it. Before my join, it stays hidden instead.
    NoKey,
    /// Opens only under a rotation authority doesn't accept (#21): shown
    /// without its author, text or reactions.
    Untrusted,
}

/// The control records from my latest `Join` on (it included): a channel
/// record whose auth deps name one was written by someone who had seen me
/// join. The server's creator (no `Join`, the genesis author) has them
/// all. None when I'm unknown or neither. `log.records` is deps-first, so
/// one pass is enough.
pub(crate) fn after_my_join(log: &Log, me: Option<PublicKey>) -> HashSet<RecordId> {
    let mut after = HashSet::new();
    let Some(me) = me else { return after };
    let join = log.records.iter().rev().find(|r| r.kind() == Kind::Join && r.author() == me);
    let creator = log.records.first().is_some_and(|g| g.kind() == Kind::Genesis && g.author() == me);
    if join.is_none() && !creator {
        return after;
    }
    let join = join.map(Record::id);
    for record in &log.records {
        if join.is_none() || Some(record.id()) == join || record.deps().iter().any(|d| after.contains(d)) {
            after.insert(record.id());
        }
    }
    after
}

/// G-26: the reactions of one channel, folded in causal order
/// (`crate::reaction` has the rules).
pub(crate) struct Reactions {
    pub on: HashMap<RecordId, OnMessage>,
    /// The time and rate rules, for a new reaction's checks.
    pub gate: Gate,
}

/// Folds the accepted `Reaction` records of `channel` onto `live`, its
/// shown messages that aren't deleted, at `now` (the core clock: records
/// from more than ten minutes ahead wait).
pub(crate) fn reactions(
    cipher: &dyn GroupCipher,
    server: ServerId,
    channel: ChannelId,
    log: &Log,
    live: &HashSet<RecordId>,
    now: u64,
) -> Reactions {
    let scope = Scope::Channel(channel);
    let records: Vec<&Record> = log.channel.iter().filter(|r| r.scope() == scope).collect();
    let mut folded = Reactions { on: HashMap::new(), gate: Gate::new(now) };
    let nodes: Vec<Node> = records
        .iter()
        .map(|r| Node { id: r.id(), ts: r.ts(), deps: r.deps() })
        .chain(
            log.stubs
                .values()
                .filter(|s| s.scope() == scope)
                .map(|s| Node { id: s.id(), ts: s.ts(), deps: s.deps() }),
        )
        .collect();
    let by_id: HashMap<RecordId, &Record> = records.iter().map(|r| (r.id(), *r)).collect();
    let index: HashMap<RecordId, &Node> = nodes.iter().map(|n| (n.id, n)).collect();
    let graph = Graph::new(&log.channel, &log.stubs);
    for (at, id) in causal_order(&nodes).into_iter().enumerate() {
        let reaction = by_id
            .get(&id)
            .filter(|r| r.kind() == Kind::Reaction && accepted(&log.resolver, r, &graph));
        // Every node feeds the effective times; a reaction is counted only
        // within the time and rate rules (`Gate::take`).
        if !folded.gate.take(index[&id], reaction.map(|r| r.author())) {
            continue;
        }
        let Some(record) = reaction else { continue };
        let opened = match cipher.decrypt(server, channel, record.author(), record.body()) {
            Ok(Opened { plaintext, accepted: true }) => Reaction::decode(&plaintext),
            _ => None,
        };
        let Some(reaction) = opened.filter(|r| live.contains(&r.target)) else { continue };
        folded.on.entry(reaction.target).or_default().apply(
            record.author(),
            &reaction.emoji,
            reaction.on,
            at,
        );
    }
    folded
}

/// Opens a message or edit body; `None` unless it opens under an accepted
/// rotation (#21) as text within `message_text_ok`.
fn open(
    cipher: &dyn GroupCipher,
    server: ServerId,
    channel: ChannelId,
    author: PublicKey,
    body: &[u8],
) -> Option<String> {
    try_open(cipher, server, channel, author, body).ok()
}

/// As [`open`], with why it didn't: `Some(_)` for a placeholder's reason,
/// `None` for what is never shown (malformed, or text over the limit).
fn try_open(
    cipher: &dyn GroupCipher,
    server: ServerId,
    channel: ChannelId,
    author: PublicKey,
    body: &[u8],
) -> Result<String, Option<Unreadable>> {
    match cipher.decrypt(server, channel, author, body) {
        Ok(Opened { plaintext, accepted: true }) => {
            let text = String::from_utf8(plaintext).map_err(|_| None)?;
            if message_text_ok(&text) {
                Ok(text)
            } else {
                Err(None)
            }
        }
        Ok(Opened { accepted: false, .. }) => Err(Some(Unreadable::Untrusted)),
        Err(CipherError::NoKey) => Err(Some(Unreadable::NoKey)),
        Err(_) => Err(None),
    }
}

/// An edit's or delete's target: the first 32 bytes of its body (authority
/// has checked it names a `Message` in its deps).
pub(crate) fn target(record: &Record) -> Option<RecordId> {
    record.body().first_chunk::<32>().map(|id| RecordId::from_bytes(*id))
}

/// The accepted messages of `channel` that open, oldest first by their
/// claimed time, then ID.
pub(crate) fn messages(
    cipher: &dyn GroupCipher,
    server: ServerId,
    channel: ChannelId,
    log: &Log,
    now: u64,
    me: Option<PublicKey>,
) -> Vec<Shown> {
    if !known_channels(server, log.resolver.state()).contains(&channel) {
        return Vec::new();
    }
    let replaced = Replaced::of(log, channel);
    let graph = Graph::new(&log.channel, &log.stubs);
    let after = after_my_join(log, me);
    let seen_join = |auth_deps: &[RecordId]| auth_deps.iter().any(|d| after.contains(d));
    // Full messages, and stubs of messages a delete or edit replaced.
    let full = channel_records(log, channel)
        .into_iter()
        .filter(|r| r.kind() == Kind::Message && accepted(&log.resolver, r, &graph))
        .map(|r| (Meta::of_record(&r), seen_join(r.auth_deps()), Some(r)));
    let pruned = log
        .stubs
        .values()
        .filter(|s| s.scope() == Scope::Channel(channel) && s.kind() == Kind::Message)
        .filter(|s| stub_accepted(&log.resolver, s, &graph))
        .map(|s| (Meta::of_stub(s), seen_join(s.auth_deps()), None));
    let mut shown: Vec<Shown> = full
        .chain(pruned)
        .filter_map(|(meta, seen_join, record)| {
            if replaced.deleted.contains(&meta.id) {
                return Some(Shown {
                    record: meta,
                    text: String::new(),
                    edited_at: None,
                    deleted: true,
                    reactions: Vec::new(),
                    unreadable: None,
                });
            }
            // The PO's rules: untrusted always gets a placeholder; no key
            // only when the author had seen me join (else hidden, as all
            // history from before my join).
            let placeholder =
                |why: Option<Unreadable>| why.filter(|w| *w != Unreadable::NoKey || seen_join);
            let mut why = None;
            if let Some(edit) = replaced.latest_edit.get(&meta.id) {
                let opened = edit
                    .body()
                    .get(32..)
                    .ok_or(None)
                    .and_then(|body| try_open(cipher, server, channel, edit.author(), body));
                match opened {
                    Ok(text) => {
                        return Some(Shown {
                            record: meta,
                            text,
                            edited_at: Some(edit.ts()),
                            deleted: false,
                            reactions: Vec::new(),
                            unreadable: None,
                        })
                    }
                    // An edit that doesn't open: the original, if it does.
                    Err(e) => why = e,
                }
            }
            let opened = match &record {
                Some(record) => try_open(cipher, server, channel, record.author(), record.body()),
                // Pruned: only its edit had a text, and that didn't open.
                None => Err(why),
            };
            match opened {
                Ok(text) => Some(Shown {
                    record: meta,
                    text,
                    edited_at: None,
                    deleted: false,
                    reactions: Vec::new(),
                    unreadable: None,
                }),
                Err(e) => placeholder(e).map(|why| Shown {
                    record: meta,
                    text: String::new(),
                    edited_at: None,
                    deleted: false,
                    reactions: Vec::new(),
                    unreadable: Some(why),
                }),
            }
        })
        .collect();
    shown.sort_by_key(|s| (s.record.ts(), s.record.id()));
    // Most channels have no reactions: skip the fold (and its causal order).
    let scope = Scope::Channel(channel);
    if !log.channel.iter().any(|r| r.kind() == Kind::Reaction && r.scope() == scope) {
        return shown;
    }
    // Placeholders take no reactions.
    let live: HashSet<RecordId> = shown
        .iter()
        .filter(|s| !s.deleted && s.unreadable.is_none())
        .map(|s| s.record.id())
        .collect();
    let folded = reactions(cipher, server, channel, log, &live, now);
    for s in &mut shown {
        if let Some(on) = folded.on.get(&s.record.id()) {
            s.reactions = on.shown();
        }
    }
    shown
}

/// What a shown message needs of its record, full or pruned.
pub(crate) struct Meta {
    id: RecordId,
    author: PublicKey,
    ts: u64,
}

impl Meta {
    fn of_record(record: &Record) -> Meta {
        Meta { id: record.id(), author: record.author(), ts: record.ts() }
    }

    fn of_stub(stub: &Stub) -> Meta {
        Meta { id: stub.id(), author: stub.author(), ts: stub.ts() }
    }

    pub fn id(&self) -> RecordId {
        self.id
    }

    pub fn author(&self) -> PublicKey {
        self.author
    }

    pub fn ts(&self) -> u64 {
        self.ts
    }
}

/// Which messages accepted deletes and edits replaced, in one channel.
struct Replaced {
    deleted: HashSet<RecordId>,
    /// The latest accepted edit per message, by claimed time then ID.
    latest_edit: HashMap<RecordId, Record>,
    /// Every accepted edit per message.
    edits: HashMap<RecordId, Vec<RecordId>>,
}

impl Replaced {
    fn of(log: &Log, channel: ChannelId) -> Replaced {
        let graph = Graph::new(&log.channel, &log.stubs);
        let mut replaced = Replaced {
            deleted: HashSet::new(),
            latest_edit: HashMap::new(),
            edits: HashMap::new(),
        };
        for record in channel_records(log, channel) {
            let kind = record.kind();
            if !matches!(kind, Kind::MessageDelete | Kind::MessageEdit)
                || !accepted(&log.resolver, &record, &graph)
            {
                continue;
            }
            let Some(of) = target(&record) else { continue };
            if kind == Kind::MessageDelete {
                replaced.deleted.insert(of);
                continue;
            }
            replaced.edits.entry(of).or_default().push(record.id());
            let newer = replaced
                .latest_edit
                .get(&of)
                .is_none_or(|e| (e.ts(), e.id()) < (record.ts(), record.id()));
            if newer {
                replaced.latest_edit.insert(of, record);
            }
        }
        replaced
    }
}

/// The full records of `channel` to prune (B6-p): a message an accepted
/// delete or edit replaced, every edit of a deleted message, and every
/// edit but the latest of an edited one. Their bodies (ciphertext) go;
/// their stubs keep the IDs and signatures.
pub(crate) fn prunable(log: &Log, channel: ChannelId) -> Vec<RecordId> {
    let replaced = Replaced::of(log, channel);
    let mut out: Vec<RecordId> = Vec::new();
    for (message, edits) in &replaced.edits {
        out.push(*message);
        let keep = if replaced.deleted.contains(message) {
            None
        } else {
            replaced.latest_edit.get(message).map(Record::id)
        };
        out.extend(edits.iter().filter(|e| Some(**e) != keep));
    }
    out.extend(replaced.deleted.iter());
    out.retain(|id| log.channel.iter().any(|r| r.id() == *id));
    out.sort();
    out.dedup();
    out
}

/// Deps for a new record in `channel`: its records no other one depends on,
/// the latest [`MAX_DEPS`], sorted as `records` requires.
pub(crate) fn channel_deps(log: &Log, channel: ChannelId) -> Vec<RecordId> {
    let records = channel_records(log, channel);
    let referenced: HashSet<RecordId> =
        records.iter().flat_map(|r| r.deps().iter().copied()).collect();
    let heads: Vec<RecordId> =
        records.iter().map(Record::id).filter(|id| !referenced.contains(id)).collect();
    let mut deps = heads[heads.len().saturating_sub(MAX_DEPS)..].to_vec();
    deps.sort();
    deps
}

/// The next `seq` for `author` in `channel`.
pub(crate) fn channel_seq(log: &Log, channel: ChannelId, author: &PublicKey) -> u64 {
    channel_records(log, channel)
        .iter()
        .filter(|r| r.author() == *author)
        .map(|r| r.seq().saturating_add(1))
        .max()
        .unwrap_or(0)
}

/// Whether `authority` would accept `record` next to the records held: a
/// dry run, so a refused edit or delete is never stored or sent.
pub(crate) fn would_accept(log: &Log, record: &Record) -> bool {
    let mut records = log.channel.clone();
    records.push(record.clone());
    accepted(&log.resolver, record, &Graph::new(&records, &log.stubs))
}

/// [`channel_deps`] plus `target`, which an edit or delete must list.
pub(crate) fn deps_with(log: &Log, channel: ChannelId, target: RecordId) -> Vec<RecordId> {
    let mut deps: Vec<RecordId> =
        channel_deps(log, channel).into_iter().filter(|d| *d != target).collect();
    if deps.len() >= MAX_DEPS {
        deps.remove(0);
    }
    deps.push(target);
    deps.sort();
    deps
}
