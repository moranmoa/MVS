//! G-30, message links: `locateMessage` (docs/design/g30-message-links.md
//! §4). One answer, `not-found`, for everything I can't see.

mod common;

use std::sync::Arc;

use api::crypto::GroupKeysCipher;
use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use serde_json::{json, Value};

/// A peer with a real group cipher, past the recovery check, named.
fn person(world: &World, name: &str, birth_date: &str) -> (Peer, Identity) {
    let peer = world.peer_with(Arc::new(MemoryStore::new()), None, Arc::new(GroupKeysCipher::locked()));
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    let me = peer.core.update_profile(profile).unwrap();
    (peer, me)
}

/// The raw answer line, so "the same error" means byte for byte.
fn locate(peer: &Peer, server: &str, channel: &str, message: &str) -> Value {
    let line = json!({ "cmd": "locateMessage", "args": { "serverId": server, "channelId": channel, "messageId": message } });
    serde_json::from_str(&peer.core.handle(&line.to_string())).unwrap()
}

fn index(answer: &Value) -> u64 {
    answer["ok"]["index"].as_u64().unwrap_or_else(|| panic!("not located: {answer}"))
}

#[test]
fn messages_are_located_in_get_messages_order_and_hidden_things_look_missing() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", "1990-05-01");
    let (member, _) = person(&world, "Member", "1990-05-01");
    let (minor, _) = person(&world, "Minor", "2009-06-01");
    let (stranger, _) = person(&world, "Stranger", "1990-05-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let other = owner.core.create_server("Other", AgeRestriction::None).unwrap();
    let general = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    let elsewhere = owner.core.list_channels(&other.id).unwrap().remove(0).id;
    let night = owner.core.create_channel(&server.id, "night", true).unwrap().id;
    for peer in [&member, &minor] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    let one = owner.core.send_message(&general, "one", None).unwrap().id;
    let two = owner.core.send_message(&general, "two", None).unwrap().id;
    let three = owner.core.send_message(&general, "three", None).unwrap().id;
    let late = owner.core.send_message(&night, "late", None).unwrap().id;
    let there = owner.core.send_message(&elsewhere, "there", None).unwrap().id;
    owner.core.delete_message(&two).unwrap();
    for peer in [&member, &minor] {
        peer.core.sync_now().unwrap();
    }

    // Located, in getMessages order; a deleted message keeps its place.
    assert_eq!(index(&locate(&owner, &server.id, &general, &one)), 0);
    assert_eq!(index(&locate(&owner, &server.id, &general, &two)), 1, "the tombstone");
    assert_eq!(index(&locate(&owner, &server.id, &general, &three)), 2);
    let page = member.core.get_messages(&general, 0, 10).unwrap();
    let at = index(&locate(&member, &server.id, &general, &three)) as usize;
    assert_eq!(page.messages[at].id, three, "the index getMessages uses");
    assert_eq!(page.messages[1].deleted, Some(true));
    assert_eq!(index(&locate(&member, &server.id, &night, &late)), 0);

    // Everything I can't see: exactly the same answer (Security Lead, R1).
    let missing = json!({ "error": { "code": "not-found" } });
    let random = hex::encode([7u8; 32]);
    let cases = [
        ("a hidden 18+ channel", locate(&minor, &server.id, &night, &late)),
        ("a random channel", locate(&minor, &server.id, &random, &late)),
        ("a random message", locate(&member, &server.id, &general, &random)),
        ("a random server", locate(&member, &random, &general, &three)),
        ("the message in another channel", locate(&member, &server.id, &night, &three)),
        ("the channel in another server", locate(&owner, &server.id, &elsewhere, &there)),
        ("a server I'm not in", locate(&stranger, &server.id, &general, &three)),
        ("a server I'm not in, held by its owner", locate(&member, &other.id, &elsewhere, &there)),
        ("a message still waiting to send", locate(&member, &server.id, &general, "pending-0011223344556677")),
    ];
    for (what, answer) in cases {
        assert_eq!(answer, missing, "{what}");
    }

    // Not an ID at all: bad-request.
    for (server_id, channel, message) in [("zz", general.as_str(), three.as_str()), (server.id.as_str(), "", three.as_str()), (server.id.as_str(), general.as_str(), "abc")] {
        assert_eq!(locate(&member, server_id, channel, message)["error"]["code"], "bad-request");
    }

    // A closed server (read-only, still listed) answers exactly as its
    // getMessages does: its keys are forgotten at the close, so what no
    // longer opens isn't there to find either.
    owner.core.close_server(&server.id).unwrap();
    member.core.sync_now().unwrap();
    assert!(member.core.list_servers().unwrap().iter().any(|s| s.id == server.id && s.closed));
    let page = member.core.get_messages(&general, 0, 10).unwrap();
    for (i, m) in page.messages.iter().enumerate() {
        assert_eq!(index(&locate(&member, &server.id, &general, &m.id)) as usize, i);
    }
    if !page.messages.iter().any(|m| m.id == one) {
        assert_eq!(locate(&member, &server.id, &general, &one), missing);
    }
}

#[test]
fn a_kicked_member_finds_nothing() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", "1990-05-01");
    let (member, me) = person(&world, "Member", "1990-05-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let general = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    member.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    let one = owner.core.send_message(&general, "one", None).unwrap().id;
    member.core.sync_now().unwrap();
    assert_eq!(index(&locate(&member, &server.id, &general, &one)), 0);
    owner.core.kick_member(&server.id, &me.id).unwrap();
    member.core.sync_now().unwrap();
    assert_eq!(locate(&member, &server.id, &general, &one), json!({ "error": { "code": "not-found" } }));
}
