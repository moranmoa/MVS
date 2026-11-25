//! The detector: a current member writing a record of a kind this version
//! doesn't know flags the server `updateNeeded` (one `server.updated`, in
//! memory only); anyone else's never does.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{body_hash, ChannelId, Kind, RecordId, Scope, ServerId, SigningKey};

fn sign_up(peer: &Peer, name: &str) {
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    peer.core.update_profile(profile).unwrap();
}

fn server_key(server: &ServerSummary) -> ServerId {
    ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap())
}

/// Joins `server` as `key` straight through the network (a member whose
/// core isn't part of the test).
fn join(world: &World, server: &ServerSummary, key: &SigningKey) {
    let invite = {
        let link = server.invite_link.trim_start_matches("mvs://join/");
        RecordId::from_bytes(hex::decode(link.split('/').nth(1).unwrap()).unwrap().try_into().unwrap())
    };
    let id = server_key(server);
    let mut deps: BTreeSet<RecordId> =
        world.network.fetch(id).iter().filter(|r| r.scope() == Scope::Control).map(|r| r.id()).collect();
    deps.insert(invite);
    let join =
        authority::sign_control(key, id, 1, deps.into_iter().collect(), 1, &authority::Action::Join { invite })
            .unwrap();
    world.network.publish(&join);
}

/// A record of kind `code` in `server` as a newer version would write it:
/// the v2 envelope, signed over the context, the envelope, the body's
/// length and its hash.
fn newer_record(key: &SigningKey, server: ServerId, scope: Scope, code: u16) -> Vec<u8> {
    let body = b"from the future";
    let mut envelope = vec![records::VERSION];
    envelope.extend_from_slice(server.as_bytes());
    match scope {
        Scope::Control => envelope.push(0),
        Scope::Channel(channel) => {
            envelope.push(1);
            envelope.extend_from_slice(channel.as_bytes());
        }
    }
    envelope.extend_from_slice(&key.verifying_key().to_bytes());
    envelope.extend_from_slice(&9u64.to_le_bytes()); // seq
    envelope.extend_from_slice(&0u16.to_le_bytes()); // no deps
    envelope.extend_from_slice(&0u16.to_le_bytes()); // no auth deps
    envelope.extend_from_slice(&1_700_000_000_000u64.to_le_bytes()); // ts
    envelope.extend_from_slice(&code.to_le_bytes());
    let mut message = b"mvs/record/v2\0".to_vec();
    message.extend_from_slice(&envelope);
    message.extend_from_slice(&(body.len() as u32).to_le_bytes());
    message.extend_from_slice(&body_hash(body));
    let sig = ed25519_dalek::Signer::sign(key, &message).to_bytes();
    let mut out = envelope;
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out.extend_from_slice(&sig);
    out
}

/// A kind code no version uses yet.
const NEWER: u16 = 0x7fff;

fn updated(peer: &Peer, server: &ServerSummary) -> Vec<bool> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::ServerUpdated(s) if s.id == server.id => Some(s.update_needed),
            _ => None,
        })
        .collect()
}

fn flagged(peer: &Peer, server: &ServerSummary) -> bool {
    peer.core.list_servers().unwrap().into_iter().find(|s| s.id == server.id).unwrap().update_needed
}

#[test]
fn a_member_on_a_newer_version_flags_the_server_once_until_a_restart() {
    let world = World::new();
    let secrets = Arc::new(MemoryStore::new());
    let dir = std::env::temp_dir().join(format!("mvs-api-unknown-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("core.db");
    let _ = std::fs::remove_file(&db);
    let owner = world.peer_with(secrets.clone(), Some(db.clone()), Arc::new(PendingGroupKeys));
    sign_up(&owner, "Owner");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let other = owner.core.create_server("Other", AgeRestriction::None).unwrap();
    let newer = SigningKey::from_bytes(&[61; 32]);
    join(&world, &server, &newer);
    owner.core.sync_now().unwrap();
    assert!(!flagged(&owner, &server));
    owner.events.take();

    // The record itself is refused, as before: nothing new is stored.
    let bytes = newer_record(&newer, server_key(&server), Scope::Control, NEWER);
    assert!(records::Record::decode(&bytes).is_err());
    let stored = world.network.fetch(server_key(&server)).len();
    world.network.offer_raw(&bytes);
    owner.core.sync_now().unwrap();
    assert_eq!(world.network.fetch(server_key(&server)).len(), stored);
    assert_eq!(updated(&owner, &server), [true]);
    assert!(flagged(&owner, &server));
    let json = serde_json::to_value(owner.core.list_servers().unwrap()).unwrap();
    assert!(json.as_array().unwrap().iter().any(|s| s["id"] == server.id.as_str() && s["updateNeeded"] == true));
    // Only that server.
    assert!(!flagged(&owner, &other));

    // Seen again, from a channel this time: no second event.
    let channel = Scope::Channel(ChannelId::from_bytes([4; 32]));
    world.network.offer_raw(&newer_record(&newer, server_key(&server), channel, NEWER - 1));
    owner.core.sync_now().unwrap();
    assert!(updated(&owner, &server).is_empty());
    assert!(flagged(&owner, &server));

    // Never cleared on a timer; a restart clears it.
    owner.core.sync_now().unwrap();
    assert!(flagged(&owner, &server));
    drop(owner);
    let owner = world.peer_with(secrets, Some(db), Arc::new(PendingGroupKeys));
    assert!(!flagged(&owner, &server));
}

#[test]
fn nobody_but_a_current_member_can_flag_a_server() {
    let world = World::new();
    let owner = world.peer();
    sign_up(&owner, "Owner");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    owner.core.sync_now().unwrap();
    owner.events.take();
    let id = server_key(&server);

    // A stranger's validly signed record of an unknown kind.
    let stranger = SigningKey::from_bytes(&[62; 32]);
    world.network.offer_raw(&newer_record(&stranger, id, Scope::Control, NEWER));
    // A member's, with a broken signature: peek_unknown drops it.
    let member = SigningKey::from_bytes(&[63; 32]);
    join(&world, &server, &member);
    let mut forged = newer_record(&member, id, Scope::Control, NEWER);
    *forged.last_mut().unwrap() ^= 1;
    world.network.offer_raw(&forged);
    // A member's record for a server I'm not in.
    let elsewhere = ServerId::from_bytes([77; 32]);
    world.network.offer_raw(&newer_record(&member, elsewhere, Scope::Control, NEWER));
    // A known kind is decoded like any record, never a sign of an update.
    world.network.offer_raw(&newer_record(&member, id, Scope::Control, Kind::Post.code()));
    owner.core.sync_now().unwrap();
    assert!(updated(&owner, &server).iter().all(|flag| !flag));
    assert!(!flagged(&owner, &server));
}
