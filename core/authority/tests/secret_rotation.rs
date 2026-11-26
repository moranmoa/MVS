//! T17: server secret rotation parts (`SecretRotation = 25`), control
//! records a moderator or above signs. Every state test runs the reference
//! `resolve` and the incremental `Resolver` over many delivery orders and
//! requires them to agree.

mod common;
mod rng;

use authority::{resolve, Action, Record, RecordId, Resolver, Role, State};
use common::{actor, founded, rec, server};
use records::{Draft, Kind, Scope};
use rng::{SliceRandom, StdRng};

const ORDERS: u64 = 200;

fn all_orders(records: &[Record]) -> State {
    let expected = resolve(server(), records);
    let mut rng = StdRng::seed_from_u64(17);
    let mut arriving = records.to_vec();
    for round in 0..=ORDERS {
        if round > 0 {
            arriving.shuffle(&mut rng);
        }
        assert_eq!(resolve(server(), &arriving), expected, "resolve depends on order");
        let mut resolver = Resolver::new(server());
        for record in &arriving {
            resolver.insert(record.clone());
        }
        assert_eq!(resolver.state(), &expected, "incremental disagrees with resolve");
    }
    expected
}

fn part(
    author: u8,
    seq: u64,
    deps: Vec<RecordId>,
    rotation: u8,
    (part, parts): (u8, u8),
) -> Record {
    let rotation = RecordId::from_bytes([rotation; 32]);
    rec(
        author,
        seq,
        deps,
        Action::SecretRotation { rotation, part, parts, sealed: b"boxes".to_vec() },
    )
}

/// The owner (0) with an admin (1), a moderator (2) and a member (3).
fn staffed() -> (Vec<Record>, RecordId) {
    let (mut records, heads) = founded(&[1, 2, 3]);
    let admin = rec(0, 2, heads, Action::Grant { target: actor(1), role: Role::Admin });
    let moderator =
        rec(0, 3, vec![admin.id()], Action::Grant { target: actor(2), role: Role::Moderator });
    let head = moderator.id();
    records.extend([admin, moderator]);
    (records, head)
}

#[test]
fn moderators_and_above_rotate_and_parts_are_listed_in_linear_order() {
    let (mut records, head) = staffed();
    let by_owner = part(0, 10, vec![head], 1, (0, 1));
    let by_moderator = [part(2, 1, vec![head], 2, (0, 2)), part(2, 2, vec![head], 2, (1, 2))];
    let by_member = part(3, 1, vec![head], 3, (0, 1));
    records.extend([by_owner.clone(), by_member.clone()]);
    records.extend(by_moderator.iter().cloned());
    let state = all_orders(&records);
    assert!(!state.accepted.contains(&by_member.id()), "a member can't rotate");
    let mut accepted = state.secret_rotations.clone();
    assert_eq!(accepted.len(), 3);
    accepted.sort();
    let mut expected = vec![by_owner.id(), by_moderator[0].id(), by_moderator[1].id()];
    expected.sort();
    assert_eq!(accepted, expected);

    // A later rotation comes after the ones it depends on.
    let later = part(1, 1, state.secret_rotations.clone(), 4, (0, 1));
    records.push(later.clone());
    let state = all_orders(&records);
    assert_eq!(state.secret_rotations.last(), Some(&later.id()));
}

#[test]
fn a_concurrent_kick_or_revoke_voids_a_rotation() {
    let (mut records, head) = staffed();
    let concurrent = part(2, 1, vec![head], 1, (0, 1));
    let kicked = rec(0, 10, vec![head], Action::kick(actor(2)));
    let revoked = rec(0, 11, vec![head], Action::revoke(actor(1)));
    let by_admin = part(1, 1, vec![head], 2, (0, 1));
    records.extend([concurrent.clone(), kicked.clone(), revoked.clone(), by_admin.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&kicked.id()) && state.accepted.contains(&revoked.id()));
    assert!(state.secret_rotations.is_empty(), "both were concurrent with their author's removal");

    // After the kick, the owner rotates: that one counts.
    let after =
        part(0, 12, vec![kicked.id(), revoked.id(), concurrent.id(), by_admin.id()], 3, (0, 1));
    records.push(after.clone());
    assert_eq!(all_orders(&records).secret_rotations, [after.id()]);
}

#[test]
fn the_body_round_trips_and_a_bad_header_never_signs() {
    let action = Action::SecretRotation {
        rotation: RecordId::from_bytes([9; 32]),
        part: 2,
        parts: 3,
        sealed: b"sealed boxes".to_vec(),
    };
    let record = rec(0, 1, vec![common::genesis().id()], action.clone());
    assert_eq!(record.kind(), Kind::SecretRotation);
    assert_eq!(Action::from_record(&record), Some(action));
    let draft = |body: Vec<u8>| Draft {
        server: server(),
        scope: Scope::Control,
        seq: 9,
        deps: vec![],
        auth_deps: vec![],
        ts: 0,
        kind: Kind::SecretRotation,
        body,
    };
    // Header only, no boxes: parses (groupkeys judges the boxes).
    let bare = draft([vec![1; 32], vec![0, 1]].concat()).sign(&common::key(0)).unwrap();
    assert!(Action::from_record(&bare).is_some());
    // part >= parts, or a short header: records refuses to sign.
    assert!(draft([vec![1; 32], vec![1, 1]].concat()).sign(&common::key(0)).is_err());
    assert!(draft(vec![1; 33]).sign(&common::key(0)).is_err());
}
