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
