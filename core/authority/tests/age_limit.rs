//! G-52: the server's age limit (`ServerAgeLimit = 26`), set by the owner;
//! 18+ only from an adult owner (PO on #512). Every state test runs the
//! reference `resolve` and the incremental `Resolver` over many delivery
//! orders and requires them to agree.

mod common;
mod rng;

use authority::{resolve, Action, Record, RecordId, Resolver, Role, State};
use common::{actor, founded, rec, server};
use records::{Draft, Kind, Scope};
use rng::{SliceRandom, StdRng};

const ORDERS: u64 = 200;

fn all_orders(records: &[Record]) -> State {
    let expected = resolve(server(), records);
    let mut rng = StdRng::seed_from_u64(52);
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

fn limit(author: u8, seq: u64, deps: Vec<RecordId>, min: u8) -> Record {
    rec(author, seq, deps, Action::ServerAgeLimit { min })
}

fn claim(author: u8, seq: u64, deps: Vec<RecordId>, adult: bool) -> Record {
    rec(author, seq, deps, Action::AgeClaim { adult })
}

/// The owner (0) with an admin (1) and a member (2).
fn staffed() -> (Vec<Record>, RecordId) {
    let (mut records, heads) = founded(&[1, 2]);
    let admin = rec(0, 2, heads, Action::Grant { target: actor(1), role: Role::Admin });
    let head = admin.id();
    records.push(admin);
    (records, head)
}

#[test]
fn the_adult_owner_raises_and_lowers_and_the_latest_counts() {
    let (mut records, head) = staffed();
    let adult = claim(0, 10, vec![head], true);
    let sixteen = limit(0, 11, vec![adult.id()], 16);
    let by_admin = limit(1, 1, vec![adult.id()], 18);
    let by_member = limit(2, 1, vec![adult.id()], 0);
    records.extend([adult.clone(), sixteen.clone(), by_admin.clone(), by_member.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&sixteen.id()));
    assert!(!state.accepted.contains(&by_admin.id()) && !state.accepted.contains(&by_member.id()));
    assert_eq!((state.age_limit, state.age_raise), (Some(16), None));

    // Raise, lower, raise again: the raise is the second one.
    let raise = limit(0, 12, vec![sixteen.id(), by_admin.id(), by_member.id()], 18);
    let lower = limit(0, 13, vec![raise.id()], 0);
    let again = limit(0, 14, vec![lower.id()], 18);
    records.extend([raise.clone(), lower.clone()]);
    let state = all_orders(&records);
    assert_eq!((state.age_limit, state.age_raise), (Some(0), Some(raise.id())));
    // Setting 18 while it is 18 doesn't move the raise.
    let same = limit(0, 15, vec![again.id()], 18);
    records.extend([again.clone(), same.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&same.id()));
    assert_eq!((state.age_limit, state.age_raise), (Some(18), Some(again.id())));
}

#[test]
fn only_an_adult_owner_sets_18_at_the_record() {
    let (mut records, head) = staffed();
    // No claim yet: 18 doesn't count; 16 does.
    let early = limit(0, 10, vec![head], 18);
    let sixteen = limit(0, 11, vec![early.id()], 16);
    records.extend([early.clone(), sixteen.clone()]);
    let state = all_orders(&records);
    assert!(!state.accepted.contains(&early.id()) && state.accepted.contains(&sixteen.id()));
    assert_eq!(state.age_limit, Some(16));

    // A minor's claim: still refused. An adult claim after it: accepted.
    let minor = claim(0, 12, vec![sixteen.id()], false);
    let as_minor = limit(0, 13, vec![minor.id()], 18);
    let adult = claim(0, 14, vec![as_minor.id()], true);
    let as_adult = limit(0, 15, vec![adult.id()], 18);
    records.extend([minor, as_minor.clone(), adult.clone(), as_adult.clone()]);
    let state = all_orders(&records);
    assert!(!state.accepted.contains(&as_minor.id()));
    assert!(state.accepted.contains(&as_adult.id()));
    assert_eq!((state.age_limit, state.age_raise), (Some(18), Some(as_adult.id())));
}

/// A concurrent adult claim lands somewhere in linear order: the limit
/// counts exactly when the claim is placed before it. Both resolvers agree
/// (the incremental one re-resolves).
#[test]
fn a_concurrent_claim_decides_by_linear_order() {
    let (mut records, head) = staffed();
    let adult = claim(0, 10, vec![head], true);
    let raise = limit(0, 11, vec![head], 18);
    records.extend([adult.clone(), raise.clone()]);
    let state = all_orders(&records);
    // The lower ID goes first among concurrent records.
    assert_eq!(state.accepted.contains(&raise.id()), adult.id() < raise.id());
}

#[test]
fn malformed_bodies_do_not_parse() {
    let parses = |body: Vec<u8>| {
        let draft = Draft {
            server: server(),
            scope: Scope::Control,
            seq: 9,
            deps: vec![],
            auth_deps: vec![],
            ts: 0,
            kind: Kind::ServerAgeLimit,
            body,
        };
        Action::from_record(&draft.sign(&common::key(0)).unwrap())
    };
    for min in [0, 16, 18] {
        assert_eq!(parses(vec![min]), Some(Action::ServerAgeLimit { min }));
    }
    for bad in [vec![], vec![17], vec![21], vec![18, 0], vec![255]] {
        assert_eq!(parses(bad.clone()), None, "{bad:?}");
    }
}
