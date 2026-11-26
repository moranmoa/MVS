#![cfg(feature = "test-hooks")]
//! T17: a kick rotates the server's sync secret (PO on #557). The remaining
//! members move to the new one; the removed can't open it (S2); a rotation
//! voided by a concurrent kick never counts (Tech Lead on #592); and no
//! rotation is written before the release that turns writing on.

mod common;

use std::sync::Arc;

use api::crypto::GroupKeysCipher;
use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{Kind, PublicKey, Record, ServerId};

fn person(world: &World, name: &str) -> (Peer, Arc<GroupKeysCipher>, String) {
    let cipher = Arc::new(GroupKeysCipher::locked());
    let peer = world.peer_with(Arc::new(MemoryStore::new()), None, cipher.clone());
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    let id = peer.core.update_profile(profile).unwrap().id;
    (peer, cipher, id)
}

fn server_key(server: &ServerSummary) -> ServerId {
    ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap())
}

fn key(id: &str) -> PublicKey {
    PublicKey::from_bytes(hex::decode(id).unwrap().try_into().unwrap())
}

fn rotations(world: &World, server: &ServerSummary) -> Vec<Record> {
    world.network.fetch(server_key(server)).into_iter().filter(|r| r.kind() == Kind::SecretRotation).collect()
}

fn link(peer: &Peer, server: &ServerSummary) -> String {
    peer.core.list_servers().unwrap().into_iter().find(|s| s.id == server.id).unwrap().invite_link
}

/// The owner, Alice and Bob in one server, everyone synced.
fn team(world: &World) -> [(Peer, Arc<GroupKeysCipher>, String); 3] {
    let owner = person(world, "Owner");
    let alice = person(world, "Alice");
    let bob = person(world, "Bob");
    for (peer, _, _) in [&owner, &alice, &bob] {
        peer.core.enable_secret_rotation_writes();
    }
    [owner, alice, bob]
}

#[test]
fn a_kick_rotates_the_secret_for_the_members_who_stay() {
    let world = World::new();
    let [(owner, _, _), (alice, _, _), (bob, bob_cipher, bob_id)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    for peer in [&owner, &alice, &bob] {
        peer.core.sync_now().unwrap();
    }
    let before = link(&owner, &server);
    assert!(rotations(&world, &server).is_empty());

    owner.core.kick_member(&server.id, &bob_id).unwrap();
    let parts = rotations(&world, &server);
    assert_eq!(parts.len(), 1, "one part for three members");
    let after = link(&owner, &server);
    assert_ne!(after, before, "the invite link carries the new secret");

    // Alice moves to it on her next round; Bob can't open it.
    alice.core.sync_now().unwrap();
    assert_eq!(link(&alice, &server), after);
    let opened = bob_cipher.open_secret(server_key(&server), &parts).unwrap();
    assert!(opened.secret.is_none());
    assert!(!opened.recipients.contains(&key(&bob_id)));

    // Nothing more to rotate: another round writes nothing.
    owner.core.sync_now().unwrap();
    alice.core.sync_now().unwrap();
    assert_eq!(rotations(&world, &server).len(), 1);
}

#[test]
fn nothing_is_written_until_the_release_turns_it_on() {
    let world = World::new();
    let (owner, _, _) = person(&world, "Owner");
    let (bob, _, bob_id) = person(&world, "Bob");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.kick_member(&server.id, &bob_id).unwrap();
    owner.core.sync_now().unwrap();
    assert!(rotations(&world, &server).is_empty());
}

/// Tech Lead on #592: a rotation voided by a concurrent kick of its author
/// never counts; the owner's own rotation replaces it.
#[test]
fn a_rotation_voided_by_a_concurrent_kick_never_counts() {
    let world = World::new();
    let [(owner, _, _), (alice, alice_cipher, alice_id), (bob, _, bob_id)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.grant_role(&server.id, &alice_id, Role::Moderator).unwrap();
    alice.core.sync_now().unwrap();
    bob.core.sync_now().unwrap();

    // Alice kicks Bob and rotates; the owner, not synced yet, kicks Alice.
    alice.core.kick_member(&server.id, &bob_id).unwrap();
    let alices: Vec<Record> = rotations(&world, &server);
    assert_eq!(alices.len(), 1);
    assert_eq!(alices[0].author(), key(&alice_id));
    owner.core.kick_member(&server.id, &alice_id).unwrap();
    owner.core.sync_now().unwrap();

    // Alice's rotation is voided; the owner's counts, and Alice can't open it.
    let all = world.network.fetch(server_key(&server));
    let state = authority::resolve(server_key(&server), &all);
    assert!(!state.accepted.contains(&alices[0].id()));
    let owners: Vec<Record> = rotations(&world, &server).into_iter().filter(|r| r.author() != key(&alice_id)).collect();
    assert_eq!(owners.len(), 1);
    assert!(state.secret_rotations.contains(&owners[0].id()));
    let opened = alice_cipher.open_secret(server_key(&server), &owners).unwrap();
    assert!(opened.secret.is_none() && !opened.recipients.contains(&key(&alice_id)));
    // Bob's kick was voided with it, so Bob stays and moves to the owner's.
    bob.core.sync_now().unwrap();
    assert_eq!(link(&bob, &server), link(&owner, &server));
}

/// Tech Lead and Security Lead on #609: a moderator who signs a part under
/// the owner's rotation ID can't spoil it: parts group by (author,
/// rotation), so the owner's rotation stays current.
#[test]
fn a_part_replaying_the_owners_rotation_id_spoils_nothing() {
    let world = World::new();
    let [(owner, _, _), (alice, _, _), (bob, _, bob_id)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let id = server_key(&server);
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    // A moderator on a modified client.
    let mallory = records::SigningKey::from_bytes(&[66; 32]);
    let invite = {
        let link = server.invite_link.trim_start_matches("mvs://join/");
        records::RecordId::from_bytes(hex::decode(link.split('/').nth(1).unwrap()).unwrap().try_into().unwrap())
    };
    let control = |world: &World| -> Vec<records::RecordId> {
        let all = world.network.fetch(id);
        let state = authority::resolve(id, &all);
        let referenced: std::collections::BTreeSet<_> =
            all.iter().filter(|r| state.accepted.contains(&r.id())).flat_map(|r| r.deps().to_vec()).collect();
        let mut heads: Vec<_> =
            all.iter().filter(|r| state.accepted.contains(&r.id()) && !referenced.contains(&r.id())).map(Record::id).collect();
        heads.sort();
        heads
    };
    let mut deps = control(&world);
    deps.push(invite);
    deps.sort();
    deps.dedup();
    let join = authority::sign_control(&mallory, id, 1, deps, 1, &authority::Action::Join { invite }).unwrap();
    world.network.publish(&join);
    owner.core.sync_now().unwrap();
    let mallory_id = hex::encode(mallory.verifying_key().to_bytes());
    owner.core.grant_role(&server.id, &mallory_id, Role::Moderator).unwrap();
    alice.core.sync_now().unwrap();

    owner.core.kick_member(&server.id, &bob_id).unwrap();
    let owners = rotations(&world, &server);
    assert_eq!(owners.len(), 1);
    let Some(authority::Action::SecretRotation { rotation, .. }) = authority::Action::from_record(&owners[0]) else {
        panic!("a rotation part")
    };
    let forged = authority::Action::SecretRotation { rotation, part: 0, parts: 1, sealed: vec![7; 200] };
    let forged = authority::sign_control(&mallory, id, 2, control(&world), 2, &forged).unwrap();
    world.network.publish(&forged);
    let state = authority::resolve(id, &world.network.fetch(id));
    assert!(state.secret_rotations.contains(&forged.id()), "authority keeps the boxes opaque");

    let link_before = link(&owner, &server);
    owner.core.sync_now().unwrap();
    alice.core.sync_now().unwrap();
    assert_eq!(link(&owner, &server), link_before, "the owner's rotation stays current");
    assert_eq!(link(&alice, &server), link_before);
    let by_owner = rotations(&world, &server).into_iter().filter(|r| r.author() == owners[0].author()).count();
    assert_eq!(by_owner, 1, "nothing to re-rotate");
}

/// Tech Lead on #609: a join through an invite made after the rotation
/// rotates nothing (its link carries the new secret); one through an
/// older invite does (S2 `Add`).
#[test]
fn only_a_join_through_an_older_invite_rotates() {
    let world = World::new();
    let [(owner, _, _), (alice, _, _), (bob, _, bob_id)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.kick_member(&server.id, &bob_id).unwrap();
    assert_eq!(rotations(&world, &server).len(), 1);

    // Carol joins through an invite made after the rotation: no rotation.
    let fresh = owner.core.create_invite(&server.id, None, None).unwrap();
    let (carol, _, _) = person(&world, "Carol");
    carol.core.join_server(&fresh.link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.sync_now().unwrap();
    assert_eq!(rotations(&world, &server).len(), 1);
    carol.core.sync_now().unwrap();
    assert_eq!(link(&carol, &server), link(&owner, &server));

    // Dave joins through the server's first invite, made before it: the
    // owner rotates to include him.
    let (dave, _, _) = person(&world, "Dave");
    dave.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    assert_eq!(rotations(&world, &server).len(), 2);
    dave.core.sync_now().unwrap();
    assert_eq!(link(&dave, &server), link(&owner, &server));
}

/// T17 S5 and S3/S4 (step 2c): after a rotation, the old short links stop,
/// the owner and admins are told to re-share, a plain member isn't, and
/// sync gets the replaced secret to read the old frozen prefix with.
#[test]
fn a_rotation_reissues_invites_and_hands_sync_the_old_secret() {
    let world = World::new();
    let [(owner, _, _), (alice, _, _), (bob, _, bob_id)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    for peer in [&owner, &alice, &bob] {
        peer.core.sync_now().unwrap();
    }
    let short = owner.core.create_invite(&server.id, None, None).unwrap().short_link;
    let handle = match api::invite_link::parse(&short).unwrap() {
        api::invite_link::InviteLink::V1 { key, .. } => api::crypto::invite::handle(&key),
        _ => panic!("a short link"),
    };
    assert!(!world.network.fetch_invite(handle).is_empty(), "served before");
    let old_link = link(&owner, &server);
    assert!(world.network.previous_secrets(server_key(&server)).is_empty());

    owner.events.take();
    alice.events.take();
    owner.core.kick_member(&server.id, &bob_id).unwrap();
    assert!(world.network.fetch_invite(handle).is_empty(), "the old short link stopped");
    let told = |peer: &Peer| peer.events.take().iter().any(|e| matches!(e, Event::Notice { kind: NoticeKind::InvitesReissued, .. }));
    assert!(told(&owner), "the owner re-shares");
    // The old full link carried the old secret: sync keeps it to read with.
    let old_secret: [u8; 32] = hex::decode(old_link.rsplit('/').next().unwrap()).unwrap().try_into().unwrap();
    assert_eq!(world.network.previous_secrets(server_key(&server)), [old_secret]);
    alice.core.sync_now().unwrap();
    assert!(!told(&alice), "a plain member isn't asked to");
}

/// SL Q1 on #609: with the owner away, an admin rotates for a leave once
/// it is a day old (plus its own jitter of up to 6 h), not before.
#[test]
fn an_admin_rotates_for_a_leave_after_a_day() {
    let world = World::new();
    let [(owner, _, _), (alice, _, alice_id), (bob, _, _)] = team(&world);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    alice.core.join_server(&server.invite_link).unwrap();
    bob.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.grant_role(&server.id, &alice_id, Role::Admin).unwrap();
    // A first rotation, so the leave is measured against it.
    let (carol, _, carol_id) = person(&world, "Carol");
    carol.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.kick_member(&server.id, &carol_id).unwrap();
    assert_eq!(rotations(&world, &server).len(), 1);
    alice.core.sync_now().unwrap();
    bob.core.sync_now().unwrap();

    // The owner goes away; Bob leaves.
    bob.core.leave_server(&server.id).unwrap();
    alice.core.sync_now().unwrap();
    assert_eq!(rotations(&world, &server).len(), 1, "not at once");
    *world.clock.0.lock().unwrap() += api::ADMIN_LEAVE_ROTATE_MS - 60_000;
    alice.core.sync_now().unwrap();
    assert_eq!(rotations(&world, &server).len(), 1, "not before a day");
    *world.clock.0.lock().unwrap() += 60_000 + api::ADMIN_LEAVE_JITTER_MS;
    alice.core.sync_now().unwrap();
    let all = rotations(&world, &server);
    assert_eq!(all.len(), 2);
    assert_eq!(hex::encode(all.iter().max_by_key(|r| r.ts()).unwrap().author().as_bytes()), alice_id);
}
