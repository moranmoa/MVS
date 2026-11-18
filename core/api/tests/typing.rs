//! G-29: "is typing…" between cores, over an in-process transport.

mod common;

use std::sync::{Arc, Mutex};

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{ChannelId, PublicKey, ServerId, SigningKey};

/// Blobs queue until `pump`, as sync would carry them.
#[derive(Default)]
struct Hub {
    queue: Mutex<Vec<(PublicKey, PublicKey, Vec<u8>)>>,
}

struct Port {
    hub: Arc<Hub>,
    me: PublicKey,
}

impl TypingNet for Port {
    fn send(&self, to: PublicKey, blob: Vec<u8>) {
        assert!(blob.len() <= api::typing::MAX_BLOB, "{}", blob.len());
        self.hub.queue.lock().unwrap().push((self.me, to, blob));
    }
}

fn key_of(id: &str) -> PublicKey {
    PublicKey::from_bytes(hex::decode(id).unwrap().try_into().unwrap())
}

fn member(world: &World, hub: &Arc<Hub>, name: &str) -> (Peer, Identity) {
    let peer =
        world.peer_with(Arc::new(MemoryStore::new()), None, Arc::new(api::crypto::GroupKeysCipher::locked()));
    let created = peer
        .core
        .create_identity(NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() })
        .unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let me = peer
        .core
        .update_profile(ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None })
        .unwrap();
    peer.core.set_typing_net(Arc::new(Port { hub: hub.clone(), me: key_of(&me.id) }));
    (peer, me)
}

/// Delivers every queued blob to its peer; how many went.
fn pump(hub: &Hub, peers: &[(&Peer, &Identity)]) -> usize {
    let queued: Vec<_> = std::mem::take(&mut *hub.queue.lock().unwrap());
    for (from, to, blob) in &queued {
        if let Some((peer, _)) = peers.iter().find(|(_, id)| key_of(&id.id) == *to) {
            peer.core.typing_received(Some(*from), blob);
        }
    }
    queued.len()
}

fn typing(peer: &Peer) -> Vec<(String, Vec<String>)> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::Typing { channel_id, user_ids } => Some((channel_id, user_ids)),
            _ => None,
        })
        .collect()
}

fn advance(world: &World, ms: u64) {
    *world.clock.0.lock().unwrap() += ms;
}

struct Room {
    world: World,
    hub: Arc<Hub>,
    owner: Peer,
    owner_id: Identity,
    guest: Peer,
    guest_id: Identity,
    server: ServerSummary,
    channel: String,
}

fn room() -> Room {
    let world = World::new();
    let hub = Arc::new(Hub::default());
    let (owner, owner_id) = member(&world, &hub, "Owner");
    let (guest, guest_id) = member(&world, &hub, "Guest");
    let server = owner.core.create_server("Typing", AgeRestriction::None).unwrap();
    guest.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    guest.core.sync_now().unwrap();
    let channel = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    owner.events.take();
    guest.events.take();
    Room { world, hub, owner, owner_id, guest, guest_id, server, channel }
}

#[test]
fn on_at_once_repeats_every_3_s_off_after_4_s() {
    let r = room();
    let peers = [(&r.owner, &r.owner_id), (&r.guest, &r.guest_id)];
    r.guest.core.set_typing(&r.channel, true).unwrap();
    assert_eq!(pump(&r.hub, &peers), 1, "on at once, to the owner");
    assert_eq!(typing(&r.owner), [(r.channel.clone(), vec![r.guest_id.id.clone()])]);
    advance(&r.world, 1_000);
    r.guest.core.set_typing(&r.channel, true).unwrap();
    assert_eq!(pump(&r.hub, &peers), 0, "not within 3 s");
    advance(&r.world, 2_100);
    r.guest.core.set_typing(&r.channel, true).unwrap();
    assert_eq!(pump(&r.hub, &peers), 1, "a repeat after 3 s");
    assert!(typing(&r.owner).is_empty(), "still typing: no new event");
    // 4 s without a `true`: off once.
    advance(&r.world, 4_100);
    r.guest.core.typing_tick();
    assert_eq!(pump(&r.hub, &peers), 1);
    assert_eq!(typing(&r.owner), [(r.channel.clone(), vec![])]);
    r.guest.core.typing_tick();
    assert_eq!(pump(&r.hub, &peers), 0, "once");
}

#[test]
fn receivers_drop_a_typer_after_6_s_or_on_their_message() {
    let r = room();
    let peers = [(&r.owner, &r.owner_id), (&r.guest, &r.guest_id)];
    r.guest.core.set_typing(&r.channel, true).unwrap();
    pump(&r.hub, &peers);
    typing(&r.owner);
    // Off never arrives (lost): the owner drops it 6 s later.
    advance(&r.world, 5_000);
    r.owner.core.typing_tick();
    assert!(typing(&r.owner).is_empty());
    advance(&r.world, 1_100);
    r.owner.core.typing_tick();
    assert_eq!(typing(&r.owner), [(r.channel.clone(), vec![])]);
    // Typing, then the message: the send says off, and its arrival drops
    // the typer even without it.
    r.guest.core.set_typing(&r.channel, true).unwrap();
    pump(&r.hub, &peers);
    typing(&r.owner);
    r.hub.queue.lock().unwrap().clear();
    r.guest.core.send_message(&r.channel, "hi", None).unwrap();
    assert_eq!(r.hub.queue.lock().unwrap().len(), 1, "off on send");
    r.hub.queue.lock().unwrap().clear();
    r.owner.core.sync_now().unwrap();
    assert!(typing(&r.owner).contains(&(r.channel.clone(), vec![])));
}

#[test]
fn the_setting_off_sends_nothing_but_still_shows_others() {
    let r = room();
    let peers = [(&r.owner, &r.owner_id), (&r.guest, &r.guest_id)];
    assert!(r.guest.core.get_settings().unwrap().typing_indicator, "default on");
    r.guest.core.set_typing(&r.channel, true).unwrap();
    pump(&r.hub, &peers);
    typing(&r.owner);
    r.guest.core.set_typing_indicator(false).unwrap();
    assert_eq!(pump(&r.hub, &peers), 1, "turning it off sends off where I was typing");
    assert_eq!(typing(&r.owner), [(r.channel.clone(), vec![])]);
    assert!(!r.guest.core.get_settings().unwrap().typing_indicator);
    advance(&r.world, 5_000);
    r.guest.core.set_typing(&r.channel, true).unwrap();
    assert_eq!(pump(&r.hub, &peers), 0, "nothing sent");
    r.owner.core.set_typing(&r.channel, true).unwrap();
    pump(&r.hub, &peers);
    assert_eq!(typing(&r.guest), [(r.channel.clone(), vec![r.owner_id.id.clone()])], "others still shown");
}

#[test]
fn forged_replayed_or_foreign_signals_are_dropped() {
    let r = room();
    let peers = [(&r.owner, &r.owner_id), (&r.guest, &r.guest_id)];
    r.guest.core.set_typing(&r.channel, true).unwrap();
    let (from, _, blob) = r.hub.queue.lock().unwrap()[0].clone();
    // Bound to another identity than the signer's: dropped.
    r.owner.core.typing_received(Some(key_of(&r.owner_id.id)), &blob);
    r.owner.core.typing_received(None, &blob);
    assert!(typing(&r.owner).is_empty());
    // Delivered once; the replay adds nothing.
    pump(&r.hub, &peers);
    assert_eq!(typing(&r.owner).len(), 1);
    r.owner.core.typing_received(Some(from), &blob);
    r.owner.core.typing_tick();
    assert!(typing(&r.owner).is_empty());
    // A stranger, signing correctly: not a member.
    let stranger = SigningKey::from_bytes(&[9; 32]);
    let server = ServerId::from_bytes(hex::decode(&r.server.id).unwrap().try_into().unwrap());
    let channel = ChannelId::from_bytes(hex::decode(&r.channel).unwrap().try_into().unwrap());
    let now = *r.world.clock.0.lock().unwrap();
    let forged = api::typing::seal(&stranger, server, channel, true, now);
    r.owner.core.typing_received(Some(PublicKey::from_bytes(stranger.verifying_key().to_bytes())), &forged);
    // Another server's ID: not one of mine.
    let elsewhere = api::typing::seal(&stranger, ServerId::from_bytes([5; 32]), channel, true, now);
    r.owner.core.typing_received(Some(PublicKey::from_bytes(stranger.verifying_key().to_bytes())), &elsewhere);
    assert!(typing(&r.owner).is_empty());
    // A channel I can't see: not-found; and unknown IDs.
    assert_eq!(r.guest.core.set_typing(&"ab".repeat(32), true).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn through_the_dispatcher() {
    let r = room();
    let call = |cmd: &str, args: serde_json::Value| -> serde_json::Value {
        serde_json::from_str(&r.guest.core.handle(&serde_json::json!({ "cmd": cmd, "args": args }).to_string())).unwrap()
    };
    assert_eq!(call("setTyping", serde_json::json!({ "channelId": r.channel, "on": true })), serde_json::json!({ "ok": null }));
    assert_eq!(call("getSettings", serde_json::json!({})), serde_json::json!({ "ok": { "typingIndicator": true } }));
    assert_eq!(call("setTypingIndicator", serde_json::json!({ "on": false })), serde_json::json!({ "ok": null }));
    assert_eq!(call("getSettings", serde_json::json!({})), serde_json::json!({ "ok": { "typingIndicator": false } }));
    let event = serde_json::to_value(Event::Typing { channel_id: "c".into(), user_ids: vec!["u".into()] }).unwrap();
    assert_eq!(event, serde_json::json!({ "event": "typing", "payload": { "channelId": "c", "userIds": ["u"] } }));
}
