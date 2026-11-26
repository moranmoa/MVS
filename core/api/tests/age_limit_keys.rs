//! G-52 with the real cipher (Security Lead on #616): a raise to 18+ keys
//! every channel for the adult members only, so a minor who stays gets no
//! key and their stale posts don't count; a lowering keys forward only, so
//! a 17-year-old who joins after it reads nothing from the 18+ time, and an
//! 18+ channel stays closed to them.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use api::crypto::GroupKeysCipher;
use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{ChannelId, Kind, PublicKey, Record, RecordId, Scope, ServerId};

fn person(world: &World, name: &str, birth_date: &str) -> (Peer, Arc<GroupKeysCipher>, PublicKey) {
    let cipher = Arc::new(GroupKeysCipher::locked());
    let peer = world.peer_with(Arc::new(MemoryStore::new()), None, cipher.clone());
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    let id = peer.core.update_profile(profile).unwrap().id;
    (peer, cipher, PublicKey::from_bytes(hex::decode(id).unwrap().try_into().unwrap()))
}

const ADULT: &str = "1990-05-01";
/// 17 on the test clock (2026-11-03).
const MINOR: &str = "2009-06-01";

fn ids(server: &ServerSummary, channel: &str) -> (ServerId, ChannelId) {
    let server = ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap());
    let channel = ChannelId::from_bytes(hex::decode(channel).unwrap().try_into().unwrap());
    (server, channel)
}

/// The message record in `channel` whose author is `author`, newest first.
fn message_by(world: &World, server: ServerId, channel: ChannelId, author: PublicKey) -> Record {
    world
        .network
        .fetch(server)
        .into_iter()
        .filter(|r| r.kind() == Kind::Message && r.scope() == Scope::Channel(channel) && r.author() == author)
        .max_by_key(|r| r.ts())
        .expect("a message")
}

/// Everyone the newest `KeyRotation` of `channel` sealed its key for.
fn newest_readers(world: &World, server: ServerId, channel: ChannelId) -> BTreeSet<PublicKey> {
    let newest = world
        .network
        .fetch(server)
        .into_iter()
        .filter(|r| r.kind() == Kind::KeyRotation && r.scope() == Scope::Channel(channel))
        .max_by_key(|r| (r.ts(), r.seq()))
        .expect("a rotation");
    let rotation = groupkeys::Rotation::decode(server, newest.author(), newest.body()).expect("one part");
    rotation.recipients().copied().collect()
}

/// Feeds `cipher` every rotation of the server, as if it read them, so a
/// failed open means "no key", not "never saw it".
fn show_rotations(world: &World, cipher: &GroupKeysCipher, server: ServerId, channels: &[ChannelId]) {
    let all = world.network.fetch(server);
    cipher.set_channels(server, &channels.iter().copied().collect());
    let rotations: Vec<&Record> = all.iter().filter(|r| r.kind() == Kind::KeyRotation).collect();
    let accepted: BTreeSet<RecordId> = rotations.iter().map(|r| r.id()).collect();
    cipher.set_accepted(server, &accepted);
    for record in rotations {
        let _ = cipher.apply_rotation(record);
    }
}

fn bodies(peer: &Peer, channel: &str) -> Vec<String> {
    peer.core.get_messages(channel, 0, 50).unwrap().messages.into_iter().map(|m| m.body).collect()
}

#[test]
fn a_raise_keys_minors_out_and_a_lowering_keys_forward_only() {
    let world = World::new();
    let (owner, _, owner_key) = person(&world, "Owner", ADULT);
    let (adult, _, adult_key) = person(&world, "Adult", ADULT);
    let (minor, minor_cipher, minor_key) = person(&world, "Minor", MINOR);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let lounge = owner.core.create_channel(&server.id, "lounge", false).unwrap().id;
    let night = owner.core.create_channel(&server.id, "night", true).unwrap().id;
    let (server_key, lounge_key) = ids(&server, &lounge);
    let (_, night_key) = ids(&server, &night);
    for peer in [&adult, &minor] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    for peer in [&adult, &minor] {
        peer.core.sync_now().unwrap();
    }
    owner.core.send_message(&lounge, "before", None).unwrap();
    assert!(newest_readers(&world, server_key, lounge_key).contains(&minor_key));
    minor.core.sync_now().unwrap();
    assert_eq!(bodies(&minor, &lounge), ["before"]);

    // (1) The raise re-keys in the owner's call, for the adults only. The
    // minor's core is modified and never leaves: it gets no box, and the
    // owner's next message doesn't open for it.
    owner.core.set_age_restriction(&server.id, AgeRestriction::Eighteen).unwrap();
    assert_eq!(newest_readers(&world, server_key, lounge_key), BTreeSet::from([owner_key, adult_key]));
    owner.core.send_message(&lounge, "adults only", None).unwrap();
    owner.core.send_message(&night, "late, 18+ time", None).unwrap();
    let sent = message_by(&world, server_key, lounge_key, owner_key);

    // (3) The minor, not having read the raise, posts under the old key with
    // deps that don't reach it: the owner's core doesn't show it.
    minor.core.send_message(&lounge, "stale post", None).unwrap();
    assert!(world.network.fetch(server_key).iter().any(|r| r.kind() == Kind::Message && r.author() == minor_key));
    // Even holding every rotation, its cipher has no box for the new key.
    show_rotations(&world, &minor_cipher, server_key, &[lounge_key, night_key]);
    assert!(minor_cipher.decrypt(server_key, lounge_key, sent.author(), sent.body()).is_err());
    owner.core.sync_now().unwrap();
    assert_eq!(bodies(&owner, &lounge), ["before", "adults only"]);
    adult.core.sync_now().unwrap();
    assert_eq!(bodies(&adult, &lounge), ["before", "adults only"]);

    // (2) Lowered to 16+: a 17-year-old who joins now reads what is sent
    // after it, nothing from the 18+ time, and never the 18+ channel.
    // LM-2 (#619) re-seals members' recent messages for a joiner: never
    // one from before the lowering for a joiner who isn't an adult.
    owner.core.set_age_restriction(&server.id, AgeRestriction::Sixteen).unwrap();
    let (teen, teen_cipher, teen_key) = person(&world, "Teen", MINOR);
    teen.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    teen.core.sync_now().unwrap();
    owner.core.send_message(&lounge, "after lowering", None).unwrap();
    assert!(newest_readers(&world, server_key, lounge_key).contains(&teen_key));
    teen.core.sync_now().unwrap();
    let seen = bodies(&teen, &lounge);
    assert!(seen.iter().any(|b| b == "after lowering"), "{seen:?}");
    assert!(!seen.iter().any(|b| b == "adults only"), "{seen:?}");
    show_rotations(&world, &teen_cipher, server_key, &[lounge_key, night_key]);
    assert!(teen_cipher.decrypt(server_key, lounge_key, sent.author(), sent.body()).is_err());
    let late = message_by(&world, server_key, night_key, owner_key);
    assert!(teen_cipher.decrypt(server_key, night_key, late.author(), late.body()).is_err());
    assert!(!teen.core.list_channels(&server.id).unwrap().iter().any(|c| c.id == night));
}
