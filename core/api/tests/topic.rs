//! G-14: a channel's topic through the typed API and the dispatcher.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{Kind, ServerId, SigningKey};

fn born(birth_date: &str) -> NewIdentityInput {
    NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() }
}

fn member(world: &World, name: &str) -> (Peer, Identity) {
    member_born(world, name, "1990-05-01")
}

fn member_born(world: &World, name: &str, birth_date: &str) -> (Peer, Identity) {
    let peer = world.peer_with(
        Arc::new(MemoryStore::new()),
        None,
        Arc::new(api::crypto::GroupKeysCipher::locked()),
    );
    let created = peer.core.create_identity(born(birth_date)).unwrap();
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

fn signed(world: &World, server: &ServerSummary) -> usize {
    world.network.fetch(server_key(server)).iter().filter(|r| r.kind() == Kind::ChannelTopic).count()
}

fn topic_of(peer: &Peer, server: &ServerSummary, channel: &str) -> Option<String> {
    let channels = peer.core.list_channels(&server.id).unwrap();
    channels.into_iter().find(|c| c.id == channel).unwrap().topic
}

fn channel_updates(peer: &Peer) -> Vec<Channel> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::ChannelUpdated(c) => Some(c),
            _ => None,
        })
        .collect()
}

struct Room {
    world: World,
    owner: Peer,
    admin: Peer,
    plain: Peer,
    server: ServerSummary,
    channel: String,
}

/// The owner, an admin and a plain member, all synced.
fn room() -> Room {
    let world = World::new();
    let (owner, _) = member(&world, "Owner");
    let (admin, admin_id) = member(&world, "Admin");
    let (plain, _) = member(&world, "Plain");
    let server = owner.core.create_server("Topics", AgeRestriction::None).unwrap();
    admin.core.join_server(&server.invite_link).unwrap();
    plain.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.grant_role(&server.id, &admin_id.id, Role::Admin).unwrap();
    let channel = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    for peer in [&admin, &plain, &owner, &admin, &plain] {
        peer.core.sync_now().unwrap();
    }
    Room { world, owner, admin, plain, server, channel }
}

#[test]
fn the_owner_or_an_admin_sets_it_and_every_member_sees_it() {
    let r = room();
    r.owner.events.take();
    let json = r.owner.core.set_channel_topic(&r.channel, "  Welcome, read the rules  ").unwrap();
    assert_eq!(json.topic.as_deref(), Some("Welcome, read the rules"), "trimmed");
    let mine = channel_updates(&r.owner);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].topic.as_deref(), Some("Welcome, read the rules"));

    // Another member reads it by sync, with a channel.updated and nothing
    // unread: a topic is never unread, a mention or a notification.
    let unread_before = r.plain.core.list_channels(&r.server.id).unwrap()[0].unread_count;
    r.plain.events.take();
    r.plain.core.sync_now().unwrap();
    let events = r.plain.events.take();
    let updates: Vec<&Channel> = events
        .iter()
        .filter_map(|e| match e {
            Event::ChannelUpdated(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(updates.len(), 1, "{events:?}");
    assert_eq!(updates[0].topic.as_deref(), Some("Welcome, read the rules"));
    assert!(
        !events.iter().any(|e| matches!(e, Event::MessageAdded(_) | Event::ServerUpdated(_))),
        "{events:?}"
    );
    let channel = r.plain.core.list_channels(&r.server.id).unwrap().remove(0);
    assert_eq!(channel.unread_count, unread_before);
    assert_eq!(channel.mentions, 0);

    // An admin changes it; the same topic again signs nothing.
    r.admin.core.sync_now().unwrap();
    r.admin.core.set_channel_topic(&r.channel, "Anything goes").unwrap();
    let after = signed(&r.world, &r.server);
    r.admin.events.take();
    r.admin.core.set_channel_topic(&r.channel, "Anything goes").unwrap();
    assert_eq!(signed(&r.world, &r.server), after, "unchanged: nothing signed");
    assert!(channel_updates(&r.admin).is_empty());
    r.owner.core.sync_now().unwrap();
    assert_eq!(topic_of(&r.owner, &r.server, &r.channel).as_deref(), Some("Anything goes"));

    // An empty topic clears it, everywhere.
    r.owner.core.set_channel_topic(&r.channel, "   ").unwrap();
    for peer in [&r.owner, &r.admin, &r.plain] {
        peer.core.sync_now().unwrap();
        assert_eq!(topic_of(peer, &r.server, &r.channel), None);
    }
}

#[test]
fn members_wrong_text_and_dead_channels_are_refused_before_signing() {
    let r = room();
    let before = signed(&r.world, &r.server);
    let code = |peer: &Peer, channel: &str, topic: &str| {
        peer.core.set_channel_topic(channel, topic).unwrap_err().code
    };
    assert_eq!(code(&r.plain, &r.channel, "mine now"), ErrorCode::NotAllowed);
    for bad in ["two\nlines", "a\u{202E}b", "a\u{200B}b", &"ש".repeat(257)] {
        assert_eq!(code(&r.owner, &r.channel, bad), ErrorCode::BadRequest, "{bad:?}");
    }
    assert!(r.owner.core.set_channel_topic(&r.channel, &"ש".repeat(256)).is_ok());
    let unknown = hex::encode([7u8; 32]);
    assert_eq!(code(&r.owner, &unknown, "nowhere"), ErrorCode::NotFound);
    let other = r.owner.core.create_channel(&r.server.id, "other", false).unwrap();
    r.owner.core.delete_channel(&other.id).unwrap();
    assert_eq!(code(&r.owner, &other.id, "too late"), ErrorCode::NotFound);
    assert_eq!(signed(&r.world, &r.server), before + 1, "only the valid one was signed");
}

#[test]
fn the_gate_waits_for_every_member_to_read_topics() {
    let r = room();
    let key = server_key(&r.server);
    // A member on an older version (a fixed key) joins, with a profile post
    // that has the lifecycle and reactions caps but not topics.
    let old = SigningKey::from_bytes(&[43; 32]);
    let invite = {
        let link = r.server.invite_link.trim_start_matches("mvs://join/");
        let hex = link.split('/').nth(1).unwrap();
        records::RecordId::from_bytes(hex::decode(hex).unwrap().try_into().unwrap())
    };
    let control = || -> Vec<records::RecordId> {
        r.world
            .network
            .fetch(key)
            .iter()
            .filter(|x| x.scope() == records::Scope::Control)
            .map(|x| x.id())
            .collect()
    };
    let mut deps: BTreeSet<_> = control().into_iter().collect();
    deps.insert(invite);
    let join = authority::sign_control(
        &old,
        key,
        1,
        deps.into_iter().collect(),
        1,
        &authority::Action::Join { invite },
    )
    .unwrap();
    r.world.network.publish(&join);
    let profile = |caps: &str, seq| {
        let text = format!(r#"{{"mvs":"mvs/profile/v1","displayName":"Old","caps":[{caps}]}}"#);
        authority::sign_control(&old, key, seq, control(), 2, &authority::Action::Post { text })
            .unwrap()
    };
    r.world.network.publish(&profile(r#""server-lifecycle-v1","reactions-v1""#, 2));
    r.owner.core.sync_now().unwrap();
    let before = signed(&r.world, &r.server);
    assert_eq!(
        r.owner.core.set_channel_topic(&r.channel, "soon").unwrap_err().code,
        ErrorCode::UpdateNeeded
    );
    assert_eq!(signed(&r.world, &r.server), before, "nothing signed past the gate");
    let old_id = hex::encode(old.verifying_key().to_bytes());
    assert_eq!(
        r.owner.core.get_update_needed(&r.server.id, Some("channel-topic-v1")).unwrap(),
        [old_id]
    );
    assert!(r.owner.core.get_update_needed(&r.server.id, Some("reactions-v1")).unwrap().is_empty());
    assert_eq!(
        r.owner.core.get_update_needed(&r.server.id, Some("channel-topic-v2")).unwrap_err().code,
        ErrorCode::BadRequest,
        "only cap names it knows"
    );
    // Clearing a topic that isn't set signs nothing, so it isn't gated.
    assert_eq!(r.owner.core.set_channel_topic(&r.channel, "").unwrap().topic, None);
    // It updates: the gate opens.
    r.world
        .network
        .publish(&profile(r#""server-lifecycle-v1","reactions-v1","channel-topic-v1""#, 3));
    r.owner.core.sync_now().unwrap();
    r.owner.core.set_channel_topic(&r.channel, "soon").unwrap();
}

#[test]
fn set_channel_topic_through_the_dispatcher() {
    let r = room();
    let call = |cmd: &str, args: serde_json::Value| -> serde_json::Value {
        let request = serde_json::json!({ "cmd": cmd, "args": args }).to_string();
        serde_json::from_str(&r.owner.core.handle(&request)).unwrap()
    };
    let ok = call("setChannelTopic", serde_json::json!({ "channelId": r.channel, "topic": "Hi" }));
    assert_eq!(ok["ok"]["topic"], "Hi", "{ok}");
    assert_eq!(ok["ok"]["id"], r.channel.as_str());
    let bad = call("setChannelTopic", serde_json::json!({ "channelId": r.channel, "topic": "a\nb" }));
    assert_eq!(bad["error"]["code"], "bad-request", "{bad}");
    let missing = call("setChannelTopic", serde_json::json!({ "channelId": r.channel }));
    assert_eq!(missing["error"]["code"], "bad-request", "{missing}");
    let who =
        call("getUpdateNeeded", serde_json::json!({ "serverId": r.server.id, "cap": "channel-topic-v1" }));
    assert_eq!(who, serde_json::json!({ "ok": [] }));
    // Cleared: the field is absent, not null.
    let cleared = call("setChannelTopic", serde_json::json!({ "channelId": r.channel, "topic": "" }));
    assert!(cleared["ok"].get("topic").is_none(), "{cleared}");
}

/// The security lead's item 2: an 18+ channel's topic reaches only members
/// with an 18+ claim, through the one withholding point
/// (`ServerView::channels`): no `channel.updated` and no list entry for a
/// minor. Display-only: the record itself is plaintext to every member.
#[test]
fn an_adult_channels_topic_never_reaches_a_minor() {
    let world = World::new();
    let (owner, _) = member(&world, "Owner");
    // 17 on the test clock's 2026-11-03.
    let (teen, _) = member_born(&world, "Teen", "2008-11-04");
    let (grown, _) = member(&world, "Grown");
    let server = owner.core.create_server("Mixed", AgeRestriction::None).unwrap();
    teen.core.join_server(&server.invite_link).unwrap();
    grown.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    let late = owner.core.create_channel(&server.id, "late-night", true).unwrap();
    let general = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    for peer in [&teen, &grown, &owner, &teen, &grown] {
        peer.core.sync_now().unwrap();
    }
    owner.core.set_channel_topic(&late.id, "after hours").unwrap();
    owner.core.set_channel_topic(&general, "for everyone").unwrap();
    for peer in [&teen, &grown] {
        peer.events.take();
        peer.core.sync_now().unwrap();
    }
    let seen = |peer: &Peer| -> Vec<(String, Option<String>)> {
        channel_updates(peer).into_iter().map(|c| (c.id, c.topic)).collect()
    };
    assert_eq!(seen(&teen), [(general.clone(), Some("for everyone".into()))]);
    let grown_saw = seen(&grown);
    assert!(grown_saw.contains(&(late.id.clone(), Some("after hours".into()))), "{grown_saw:?}");
    assert!(teen.core.list_channels(&server.id).unwrap().iter().all(|c| c.id != late.id));
    assert_eq!(topic_of(&grown, &server, &late.id).as_deref(), Some("after hours"));
}
