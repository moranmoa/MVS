//! "Is typing…" (G-29, piece B; `g29-typing-design.md` with Amendment 1).
//!
//! Ephemeral: never stored, never in a log, the backup or the logs; only
//! over live member connections (sync's `/mvs/typing/1`, behind
//! [`TypingNet`]).
//!
//! - **Envelope:** `{ v: 1, from, server, channel, ts, nonce, on }`, signed by
//!   the identity under [`TYPING_PREFIX`], `deny_unknown_fields` on both
//!   layers, at most [`MAX_BLOB`] bytes.
//! - **Receiving** (fails closed, dropped quietly): it must verify, be
//!   version 1, be within [`CLOCK_WINDOW_MS`] of our clock, not be a replay,
//!   come from the identity its peer is bound to, and that identity must be
//!   able to read and post in that channel now, in one of my servers, in a
//!   channel I can see.
//! - **Sending** (`setTyping`): the first `true` goes out at once; repeats at
//!   most every [`REPEAT_MS`] while the UI keeps calling `true`. `off` goes
//!   once on `false` (send, clear) or [`OFF_AFTER_MS`] after the last `true`.
//!   Nothing goes out with the setting off.
//! - **State:** a typer is dropped [`DROP_AFTER_MS`] after their last `on`,
//!   at once on `off`, or when their message arrives.
//! - **Event:** `typing { channelId, userIds }`, at most one per channel per
//!   call or tick, at most [`MAX_SHOWN`] IDs.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use ed25519_dalek::{Signature, Signer, VerifyingKey};
use rand_core::{OsRng, RngCore};
use records::{ChannelId, PublicKey, ServerId, SigningKey};
use serde::{Deserialize, Serialize};

use crate::model;

/// What every typing envelope's signature covers, before its body.
pub const TYPING_PREFIX: &[u8] = b"mvs/typing/v1";
const VERSION: u8 = 1;
/// The largest blob sent or accepted (sync's `MAX_TYPING_BLOB`).
pub const MAX_BLOB: usize = 512;
/// How far an envelope's time may be from ours, either way.
pub const CLOCK_WINDOW_MS: u64 = 120_000;
/// Repeats of `on` while typing go out at most this often.
pub const REPEAT_MS: u64 = 3_000;
/// `off` goes out this long after the last `setTyping(true)`.
pub const OFF_AFTER_MS: u64 = 4_000;
/// A typer is dropped this long after their last `on` (the backstop).
pub const DROP_AFTER_MS: u64 = 6_000;
/// Most user IDs in one `typing` event.
pub const MAX_SHOWN: usize = 5;
/// Replay cache size; full means fail closed.
const MAX_NONCES: usize = 4096;
/// Channels with typers tracked, and typers per channel.
const MAX_CHANNELS: usize = 256;
const MAX_TYPERS: usize = 64;

/// Sync's typing transport, best effort.
pub trait TypingNet: Send + Sync {
    /// Sends one blob (at most [`MAX_BLOB`]) to that identity's peer.
    fn send(&self, to: PublicKey, blob: Vec<u8>);
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    v: u8,
    from: String,
    server: String,
    channel: String,
    ts: u64,
    nonce: String,
    on: bool,
}

/// On the wire: the body as sent, and the signature over
/// `TYPING_PREFIX ‖ body`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    body: String,
    sig: String,
}

/// A verified envelope.
#[derive(Debug, PartialEq, Eq)]
pub struct Opened {
    pub from: PublicKey,
    pub server: ServerId,
    pub channel: ChannelId,
    pub ts: u64,
    pub nonce: [u8; 16],
    pub on: bool,
}

/// My envelope for `channel` at `now`, with a fresh nonce.
pub fn seal(key: &SigningKey, server: ServerId, channel: ChannelId, on: bool, now: u64) -> Vec<u8> {
    let mut nonce = [0u8; 16];
    OsRng.fill_bytes(&mut nonce);
    let body = Body {
        v: VERSION,
        from: hex::encode(key.verifying_key().to_bytes()),
        server: hex::encode(server.as_bytes()),
        channel: hex::encode(channel.as_bytes()),
        ts: now,
        nonce: hex::encode(nonce),
        on,
    };
    let body = serde_json::to_string(&body).expect("a body serializes");
    let sig = key.sign(&[TYPING_PREFIX, body.as_bytes()].concat());
    serde_json::to_vec(&Envelope { body, sig: hex::encode(sig.to_bytes()) }).expect("serializes")
}

/// `None` unless it is at most [`MAX_BLOB`], verifies under
/// [`TYPING_PREFIX`], is version 1 and is within [`CLOCK_WINDOW_MS`].
pub fn open(blob: &[u8], now: u64) -> Option<Opened> {
    if blob.len() > MAX_BLOB {
        return None;
    }
    let envelope: Envelope = serde_json::from_slice(blob).ok()?;
    let sig: [u8; 64] = hex::decode(&envelope.sig).ok()?.try_into().ok()?;
    let body: Body = serde_json::from_str(&envelope.body).ok()?;
    let from = model::parse_hex32(&body.from)?;
    VerifyingKey::from_bytes(&from)
        .ok()?
        .verify_strict(&[TYPING_PREFIX, envelope.body.as_bytes()].concat(), &Signature::from_bytes(&sig))
        .ok()?;
    if body.v != VERSION || body.ts.abs_diff(now) > CLOCK_WINDOW_MS {
        return None;
    }
    let nonce: [u8; 16] = hex::decode(&body.nonce).ok()?.try_into().ok()?;
    Some(Opened {
        from: PublicKey::from_bytes(from),
        server: ServerId::from_bytes(model::parse_hex32(&body.server)?),
        channel: ChannelId::from_bytes(model::parse_hex32(&body.channel)?),
        ts: body.ts,
        nonce,
        on: body.on,
    })
}

/// What I last sent in one channel.
struct Mine {
    server: ServerId,
    /// When `on` last went out.
    sent: u64,
    /// The last `setTyping(true)`.
    asked: u64,
}

/// What to send, decided by [`Typing`]; the core sends it to the
/// channel's readers.
#[derive(Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub server: ServerId,
    pub channel: ChannelId,
    pub on: bool,
}

/// Typing state: who else is typing where, what I sent, the replay cache.
#[derive(Default)]
pub struct Typing {
    net: Option<Arc<dyn TypingNet>>,
    nonces: VecDeque<(u64, [u8; 16])>,
    seen: HashSet<[u8; 16]>,
    /// Others: channel → who → when their last `on` arrived (our clock).
    typers: HashMap<ChannelId, BTreeMap<PublicKey, u64>>,
    mine: HashMap<ChannelId, Mine>,
    /// Channels whose typers changed since the last [`Typing::changed`].
    dirty: BTreeSet<ChannelId>,
}

impl Typing {
    pub fn set_net(&mut self, net: Arc<dyn TypingNet>) {
        self.net = Some(net);
    }

    pub fn net(&self) -> Option<Arc<dyn TypingNet>> {
        self.net.clone()
    }

    /// `setTyping(true)` in `channel` at `now`: `on`, unless one went out
    /// less than [`REPEAT_MS`] ago.
    pub fn typing(&mut self, server: ServerId, channel: ChannelId, now: u64) -> Option<Outgoing> {
        let mine = self.mine.entry(channel).or_insert(Mine { server, sent: 0, asked: now });
        mine.asked = now;
        if mine.sent != 0 && now.saturating_sub(mine.sent) < REPEAT_MS {
            return None;
        }
        mine.sent = now.max(1);
        Some(Outgoing { server, channel, on: true })
    }

    /// `setTyping(false)`, a send, or the setting turned off: `off` once,
    /// if `on` went out.
    pub fn stopped(&mut self, channel: ChannelId) -> Option<Outgoing> {
        let mine = self.mine.remove(&channel)?;
        Some(Outgoing { server: mine.server, channel, on: false })
    }

    /// Every channel I'm typing in: `off` for each (the setting turned off).
    pub fn stop_all(&mut self) -> Vec<Outgoing> {
        let channels: Vec<ChannelId> = self.mine.keys().copied().collect();
        channels.into_iter().filter_map(|c| self.stopped(c)).collect()
    }

    /// Not seen within twice the clock window: remembers it. Full of live
    /// nonces: false (fail closed).
    pub fn fresh(&mut self, nonce: [u8; 16], now: u64) -> bool {
        while let Some((at, old)) = self.nonces.front().copied() {
            if now.saturating_sub(at) <= 2 * CLOCK_WINDOW_MS {
                break;
            }
            self.nonces.pop_front();
            self.seen.remove(&old);
        }
        if self.nonces.len() >= MAX_NONCES || !self.seen.insert(nonce) {
            return false;
        }
        self.nonces.push_back((now, nonce));
        true
    }

    /// A verified, allowed `on` or `off` from `from` in `channel`.
    pub fn heard(&mut self, from: PublicKey, channel: ChannelId, on: bool, now: u64) {
        if on {
            if !self.typers.contains_key(&channel) && self.typers.len() >= MAX_CHANNELS {
                return;
            }
            let typers = self.typers.entry(channel).or_default();
            if !typers.contains_key(&from) && typers.len() >= MAX_TYPERS {
                return;
            }
            if typers.insert(from, now).is_none() {
                self.dirty.insert(channel);
            }
        } else {
            self.gone(from, channel);
        }
    }

    /// `from` stopped typing in `channel` (`off`, or their message came).
    pub fn gone(&mut self, from: PublicKey, channel: ChannelId) {
        let Some(typers) = self.typers.get_mut(&channel) else { return };
        if typers.remove(&from).is_some() {
            self.dirty.insert(channel);
        }
        if typers.is_empty() {
            self.typers.remove(&channel);
        }
    }

    /// Timers at `now`: typers past [`DROP_AFTER_MS`] go; my channels past
    /// [`OFF_AFTER_MS`] without a `true` get their `off`.
    pub fn tick(&mut self, now: u64) -> Vec<Outgoing> {
        for (channel, typers) in &mut self.typers {
            let before = typers.len();
            typers.retain(|_, at| now.saturating_sub(*at) < DROP_AFTER_MS);
            if typers.len() != before {
                self.dirty.insert(*channel);
            }
        }
        self.typers.retain(|_, typers| !typers.is_empty());
        let idle: Vec<ChannelId> = self
            .mine
            .iter()
            .filter(|(_, mine)| now.saturating_sub(mine.asked) >= OFF_AFTER_MS)
            .map(|(channel, _)| *channel)
            .collect();
        idle.into_iter().filter_map(|c| self.stopped(c)).collect()
    }

    /// The channels whose typers changed since the last call, each with
    /// who types there now (at most [`MAX_SHOWN`], by key), and forgets
    /// them.
    pub fn changed(&mut self) -> Vec<(ChannelId, Vec<PublicKey>)> {
        std::mem::take(&mut self.dirty)
            .into_iter()
            .map(|channel| {
                let who = self
                    .typers
                    .get(&channel)
                    .map(|t| t.keys().take(MAX_SHOWN).copied().collect())
                    .unwrap_or_default();
                (channel, who)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn ids() -> (ServerId, ChannelId) {
        (ServerId::from_bytes([1; 32]), ChannelId::from_bytes([2; 32]))
    }

    #[test]
    fn an_envelope_verifies_only_as_sent() {
        let (server, channel) = ids();
        let blob = seal(&key(7), server, channel, true, NOW);
        assert!(blob.len() <= MAX_BLOB, "{}", blob.len());
        let opened = open(&blob, NOW).unwrap();
        assert_eq!((opened.from, opened.server, opened.channel, opened.on), (PublicKey::from_bytes(key(7).verifying_key().to_bytes()), server, channel, true));
        // Outside the clock window.
        assert!(open(&blob, NOW + CLOCK_WINDOW_MS + 1).is_none());
        assert!(open(&blob, NOW - CLOCK_WINDOW_MS - 1).is_none());
        // Tampered body, an unknown field, a voice signature, a big blob.
        let text = String::from_utf8(blob.clone()).unwrap();
        assert!(open(text.replace("true", "false").as_bytes(), NOW).is_none());
        let envelope: serde_json::Value = serde_json::from_slice(&blob).unwrap();
        let mut extra = envelope.clone();
        extra["x"] = 1.into();
        assert!(open(&serde_json::to_vec(&extra).unwrap(), NOW).is_none());
        let body = envelope["body"].as_str().unwrap();
        let with_field = body.replacen('{', r#"{"x":1,"#, 1);
        let sig = key(7).sign(&[TYPING_PREFIX, with_field.as_bytes()].concat());
        let forged = serde_json::json!({ "body": with_field, "sig": hex::encode(sig.to_bytes()) });
        assert!(open(&serde_json::to_vec(&forged).unwrap(), NOW).is_none(), "deny_unknown_fields");
        let voice = key(7).sign(&[crate::voice::SIGNAL_PREFIX, body.as_bytes()].concat());
        let cross = serde_json::json!({ "body": body, "sig": hex::encode(voice.to_bytes()) });
        assert!(open(&serde_json::to_vec(&cross).unwrap(), NOW).is_none(), "another context");
        assert!(open(&vec![b' '; MAX_BLOB + 1], NOW).is_none());
    }

    #[test]
    fn on_at_once_then_at_most_every_3_s_and_off_after_4_s() {
        let (server, channel) = ids();
        let mut t = Typing::default();
        assert_eq!(t.typing(server, channel, NOW), Some(Outgoing { server, channel, on: true }));
        assert_eq!(t.typing(server, channel, NOW + 1_000), None);
        assert_eq!(t.typing(server, channel, NOW + 2_999), None);
        assert!(t.typing(server, channel, NOW + 3_000).is_some());
        // Still typing at +3.5 s: no off yet at +7 s (4 s after the last true at +3.5).
        t.typing(server, channel, NOW + 3_500);
        assert!(t.tick(NOW + 7_000).is_empty());
        assert_eq!(t.tick(NOW + 7_500), [Outgoing { server, channel, on: false }]);
        assert!(t.tick(NOW + 9_000).is_empty(), "once");
        // A send or a clear: off at once, once.
        t.typing(server, channel, NOW + 10_000);
        assert_eq!(t.stopped(channel), Some(Outgoing { server, channel, on: false }));
        assert_eq!(t.stopped(channel), None);
    }

    #[test]
    fn typers_drop_after_6_s_on_off_or_their_message() {
        let (_, channel) = ids();
        let (a, b) = (PublicKey::from_bytes([10; 32]), PublicKey::from_bytes([11; 32]));
        let mut t = Typing::default();
        t.heard(a, channel, true, NOW);
        t.heard(b, channel, true, NOW + 1_000);
        assert_eq!(t.changed(), [(channel, vec![a, b])]);
        t.heard(a, channel, true, NOW + 2_000);
        assert!(t.changed().is_empty(), "still typing: no event");
        t.tick(NOW + 7_000 - 1);
        assert!(t.changed().is_empty());
        t.tick(NOW + 7_000);
        assert_eq!(t.changed(), [(channel, vec![a])], "b dropped 6 s after its on");
        t.gone(a, channel);
        assert_eq!(t.changed(), [(channel, vec![])]);
        t.heard(b, channel, true, NOW);
        t.heard(b, channel, false, NOW);
        assert_eq!(t.changed(), [(channel, vec![])], "coalesced: one event");
    }

    #[test]
    fn at_most_five_ids_and_bounded_state() {
        let (_, channel) = ids();
        let mut t = Typing::default();
        for n in 0..100u8 {
            t.heard(PublicKey::from_bytes([n; 32]), channel, true, NOW);
        }
        let changed = t.changed();
        assert_eq!(changed[0].1.len(), MAX_SHOWN);
        assert_eq!(t.typers[&channel].len(), MAX_TYPERS);
    }

    #[test]
    fn replays_are_dropped() {
        let mut t = Typing::default();
        assert!(t.fresh([1; 16], NOW));
        assert!(!t.fresh([1; 16], NOW + 1));
        assert!(t.fresh([1; 16], NOW + 2 * CLOCK_WINDOW_MS + 1), "forgotten after the window");
    }
}
