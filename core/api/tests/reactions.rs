//! G-26: emoji reactions through the typed API, with the real cipher.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{Kind, ServerId, SigningKey};

fn adult() -> NewIdentityInput {
    NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() }
}

fn member(world: &World, name: &str) -> (Peer, Identity) {
    let peer = world.peer_with(
        Arc::new(MemoryStore::new()),
        None,
        Arc::new(api::crypto::GroupKeysCipher::locked()),
    );
    let created = peer.core.create_identity(adult()).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers: std::collections::BTreeMap<usize, String> =
        positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let me = peer
        .core
        .update_profile(ProfileInput {
            display_name: name.into(),
            bio: None,
            avatar_data_url: None,
            avatar_small: None,
            color: None,
        })
        .unwrap();
    (peer, me)
}

fn server_key(server: &ServerSummary) -> ServerId {
    ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap())
}

fn reactions(peer: &Peer, channel: &str, index: usize) -> Vec<(String, u32, bool)> {
    let got = peer.core.get_messages(channel, 0, 50).unwrap().messages;
    got[index]
        .reactions
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|r| (r.emoji, r.count, r.mine))
        .collect()
}

fn signed(world: &World, server: &ServerSummary) -> usize {
    world.network.fetch(server_key(server)).iter().filter(|r| r.kind() == Kind::Reaction).count()
}

fn updated(peer: &Peer) -> Vec<Message> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::MessageUpdated(m) => Some(m),
            _ => None,
        })
        .collect()
}

struct Room {
    world: World,
    owner: Peer,
    guest: Peer,
    third: Peer,
    guest_id: Identity,
    server: ServerSummary,
    channel: String,
    message: Message,
}

fn room() -> Room {
    let world = World::new();
    let (owner, _) = member(&world, "Owner");
    let (guest, guest_id) = member(&world, "Guest");
    let (third, _) = member(&world, "Third");
    let server = owner.core.create_server("Reactions", AgeRestriction::None).unwrap();
    guest.core.join_server(&server.invite_link).unwrap();
    third.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    let channel = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    let message = owner.core.send_message(&channel, "react to me", None).unwrap();
    for peer in [&guest, &third, &owner, &guest, &third] {
        peer.core.sync_now().unwrap();
    }
    Room { world, owner, guest, third, guest_id, server, channel, message }
}

#[test]
fn every_core_folds_the_same_counts() {
    let r = room();
    r.guest.events.take();
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
    let mine = updated(&r.guest);
    assert_eq!(mine.len(), 1, "one message.updated for the reactor");
    let chips = mine[0].reactions.as_ref().unwrap();
    assert_eq!((chips[0].emoji.as_str(), chips[0].count, chips[0].mine), ("👍", 1, true));
    // A trailing VS16 is the same chip; ❤️ is stored as ❤.
    r.third.core.react(&r.message.id, "👍\u{FE0F}", true).unwrap();
    r.third.core.react(&r.message.id, "❤️", true).unwrap();
    r.owner.events.take();
    r.owner.core.react(&r.message.id, "🎉", true).unwrap();
    for peer in [&r.owner, &r.guest, &r.third, &r.owner, &r.guest, &r.third] {
        peer.core.sync_now().unwrap();
    }
    let owner_view = reactions(&r.owner, &r.channel, 0);
    assert_eq!(
        owner_view,
        [("👍".into(), 2, false), ("❤".into(), 1, false), ("🎉".into(), 1, true)],
        "first-appearance order"
    );
    let strip = |v: Vec<(String, u32, bool)>| v.into_iter().map(|(e, c, _)| (e, c)).collect::<Vec<_>>();
    assert_eq!(strip(reactions(&r.guest, &r.channel, 0)), strip(owner_view.clone()));
    assert_eq!(strip(reactions(&r.third, &r.channel, 0)), strip(owner_view));
    // Reactions are never unread: the guest's count is still the message
    // alone.
    let channels = r.guest.core.list_channels(&r.server.id).unwrap();
    assert_eq!(channels[0].unread_count, Some(1));
}

#[test]
fn a_removal_wins_and_nothing_is_signed_twice() {
    let r = room();
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
    let after_add = signed(&r.world, &r.server);
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
    assert_eq!(signed(&r.world, &r.server), after_add, "already on: nothing signed");
    r.guest.core.react(&r.message.id, "👍", false).unwrap();
    r.owner.core.sync_now().unwrap();
    assert!(reactions(&r.owner, &r.channel, 0).is_empty());
    let msg = r.owner.core.get_messages(&r.channel, 0, 5).unwrap().messages.remove(0);
    assert_eq!(msg.reactions, None, "absent when there are none");
    r.guest.core.react(&r.message.id, "👍", false).unwrap();
    assert_eq!(signed(&r.world, &r.server), after_add + 1, "already off: nothing signed");
}

#[test]
fn bad_input_is_refused_before_anything_is_signed() {
    let r = room();
    let core = &r.guest.core;
    for bad in ["", "a", "👍 ", "\u{202E}👍", "🏴\u{E0067}\u{E0062}\u{E007F}", "\u{200D}👍"] {
        assert_eq!(core.react(&r.message.id, bad, true).unwrap_err().code, ErrorCode::BadRequest);
    }
    assert_eq!(core.react(&"ab".repeat(32), "👍", true).unwrap_err().code, ErrorCode::NotFound);
    let emoji: Vec<String> = ('\u{1F600}'..='\u{1F60A}').map(String::from).collect();
    for e in &emoji[..10] {
        core.react(&r.message.id, e, true).unwrap();
    }
    let ten = signed(&r.world, &r.server);
    assert_eq!(core.react(&r.message.id, &emoji[10], true).unwrap_err().code, ErrorCode::BadRequest);
    assert_eq!(signed(&r.world, &r.server), ten, "the 11th is refused, unsigned");
    // A removal frees a place.
    core.react(&r.message.id, &emoji[0], false).unwrap();
    core.react(&r.message.id, &emoji[10], true).unwrap();
    // A deleted message takes none, and shows none.
    r.owner.core.delete_message(&r.message.id).unwrap();
    r.guest.core.sync_now().unwrap();
    assert_eq!(core.react(&r.message.id, "👍", true).unwrap_err().code, ErrorCode::NotFound);
    assert!(reactions(&r.guest, &r.channel, 0).is_empty());
}

#[test]
fn thirty_a_minute_per_author_then_rate_limited() {
    let r = room();
    let core = &r.third.core;
    for i in 0..30 {
        core.react(&r.message.id, "👍", i % 2 == 0).unwrap();
    }
    // Off after 30 toggles: a 31st that would sign (on) is refused.
    assert_eq!(core.react(&r.message.id, "👍", true).unwrap_err().code, ErrorCode::RateLimited);
    assert_eq!(signed(&r.world, &r.server), 30);
    // Others aren't limited by it; and a minute later it may again.
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
    *r.world.clock.0.lock().unwrap() += 60_000;
    core.react(&r.message.id, "👍", true).unwrap();
    assert_eq!(signed(&r.world, &r.server), 32);
    r.owner.core.sync_now().unwrap();
    assert_eq!(reactions(&r.owner, &r.channel, 0), [("👍".into(), 2, false)]);
}

#[test]
fn a_kicked_member_reacts_no_more_and_keeps_what_messages_keep() {
    let r = room();
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
    r.third.core.react(&r.message.id, "👍", true).unwrap();
    for peer in [&r.owner, &r.third] {
        peer.core.sync_now().unwrap();
    }
    r.owner.core.kick_member(&r.server.id, &r.guest_id.id).unwrap();
    for peer in [&r.guest, &r.third, &r.owner] {
        peer.core.sync_now().unwrap();
    }
    let before = signed(&r.world, &r.server);
    assert!(r.guest.core.react(&r.message.id, "🎉", true).is_err(), "kicked: nothing more");
    assert_eq!(signed(&r.world, &r.server), before);
    // Authority judges a reaction like a message (authority/tests/channel.rs,
    // `reactions_are_judged_like_messages`): what the kick's cut saw stays.
    assert_eq!(reactions(&r.owner, &r.channel, 0), [("👍".into(), 2, false)]);
}

#[test]
fn the_gate_waits_for_every_member_to_read_reactions() {
    let r = room();
    let key = server_key(&r.server);
    // A member on an older version (a fixed key) joins, with a profile
    // post that has only the lifecycle cap.
    let old = SigningKey::from_bytes(&[42; 32]);
    let invite = {
        let link = r.server.invite_link.trim_start_matches("mvs://join/");
        let hex = link.split('/').nth(1).unwrap();
        records::RecordId::from_bytes(hex::decode(hex).unwrap().try_into().unwrap())
    };
    let mut deps: BTreeSet<_> = r.world.network.fetch(key).iter().filter(|x| x.scope() == records::Scope::Control).map(|x| x.id()).collect();
    deps.insert(invite);
    let join = authority::sign_control(&old, key, 1, deps.into_iter().collect(), 1, &authority::Action::Join { invite }).unwrap();
    r.world.network.publish(&join);
    let profile = |caps: &str, seq| {
        let text = format!(r#"{{"mvs":"mvs/profile/v1","displayName":"Old","caps":[{caps}]}}"#);
        let heads = r.world.network.fetch(key).iter().filter(|x| x.scope() == records::Scope::Control).map(|x| x.id()).collect();
        authority::sign_control(&old, key, seq, heads, 2, &authority::Action::Post { text }).unwrap()
    };
    r.world.network.publish(&profile(r#""server-lifecycle-v1""#, 2));
    r.guest.core.sync_now().unwrap();
    let before = signed(&r.world, &r.server);
    assert_eq!(r.guest.core.react(&r.message.id, "👍", true).unwrap_err().code, ErrorCode::UpdateNeeded);
    assert_eq!(signed(&r.world, &r.server), before, "nothing signed past the gate");
    let old_id = hex::encode(old.verifying_key().to_bytes());
    assert_eq!(r.guest.core.get_update_needed(&r.server.id, Some("reactions-v1")).unwrap(), [old_id]);
    assert!(r.guest.core.get_update_needed(&r.server.id, None).unwrap().is_empty(), "lifecycle is open");
    assert_eq!(
        r.guest.core.get_update_needed(&r.server.id, Some("server-lifecycle-v2")).unwrap_err().code,
        ErrorCode::BadRequest,
        "only cap names it knows"
    );
    // It updates: the gate opens.
    r.world.network.publish(&profile(r#""server-lifecycle-v1","reactions-v1""#, 3));
    r.guest.core.sync_now().unwrap();
    r.guest.core.react(&r.message.id, "👍", true).unwrap();
}

#[test]
fn react_through_the_dispatcher() {
    let r = room();
    let call = |cmd: &str, args: serde_json::Value| -> serde_json::Value {
        let request = serde_json::json!({ "cmd": cmd, "args": args }).to_string();
        serde_json::from_str(&r.guest.core.handle(&request)).unwrap()
    };
    let ok = call("react", serde_json::json!({ "messageId": r.message.id, "emoji": "👍", "on": true }));
    assert_eq!(ok, serde_json::json!({ "ok": null }));
    let bad = call("react", serde_json::json!({ "messageId": r.message.id, "emoji": "x", "on": true }));
    assert_eq!(bad["error"]["code"], "bad-request", "{bad}");
    let who = call("getUpdateNeeded", serde_json::json!({ "serverId": r.server.id, "cap": "reactions-v1" }));
    assert_eq!(who, serde_json::json!({ "ok": [] }));
    let probe = call("getUpdateNeeded", serde_json::json!({ "serverId": r.server.id, "cap": "x" }));
    assert_eq!(probe["error"]["code"], "bad-request", "{probe}");
    let message = r.guest.core.get_messages(&r.channel, 0, 1).unwrap().messages.remove(0);
    let json = serde_json::to_value(&message).unwrap();
    assert_eq!(json["reactions"], serde_json::json!([{ "emoji": "👍", "count": 1, "mine": true }]));
}
