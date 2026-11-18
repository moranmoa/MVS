//! B7-k: `State.adult_edits` (the latest accepted edit that made a channel
//! 18+), and the query-only `Resolver::adult_at` and `Resolver::reaches`.
//! `adult_edits` is part of `State`, so the reference `resolve` and the
//! incremental `Resolver` must agree on it over many delivery orders.

mod common;
mod rng;

use std::collections::{BTreeSet, HashMap};

use authority::{resolve, Action, ChannelId, Record, RecordId, Resolver, State};
use common::{actor, founded, rec, server};
use rng::{SliceRandom, StdRng};

const ORDERS: u64 = 200;
const NIGHT: ChannelId = ChannelId::from_bytes([7; 32]);

fn all_orders(records: &[Record]) -> State {
    let expected = resolve(server(), records);
    let mut rng = StdRng::seed_from_u64(44);
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

fn resolver(records: &[Record]) -> Resolver {
    let mut resolver = Resolver::new(server());
    for record in records {
        resolver.insert(record.clone());
    }
    resolver
}

fn edit(seq: u64, deps: Vec<RecordId>, adult: bool) -> Record {
    rec(0, seq, deps, Action::ChannelEdit { channel: NIGHT, adult, name: "night".into() })
}

#[test]
fn the_latest_adult_edit_is_kept_through_toggles_and_dropped_on_delete() {
    let (mut records, heads) = founded(&[1]);
    let create = rec(0, 2, heads, Action::ChannelCreate { channel: NIGHT, adult: false, name: "night".into() });
    let on = edit(3, vec![create.id()], true);
    let off = edit(4, vec![on.id()], false);
    records.extend([create.clone(), on.clone(), off.clone()]);
    let state = all_orders(&records);
    assert_eq!(state.adult_edits.get(&NIGHT), Some(&on.id()), "turned plain: the entry stays");
    assert!(!state.channels[&NIGHT].adult);

    let again = edit(5, vec![off.id()], true);
    records.push(again.clone());
    let state = all_orders(&records);
    assert_eq!(state.adult_edits.get(&NIGHT), Some(&again.id()), "off → on: the latest edit");

    let delete = rec(0, 6, vec![again.id()], Action::ChannelDelete { channel: NIGHT });
    records.push(delete);
    let state = all_orders(&records);
    assert!(state.adult_edits.is_empty());

    // Created 18+: the create itself is the edit.
    let (mut records, heads) = founded(&[]);
    let adult_create = rec(0, 2, heads, Action::ChannelCreate { channel: NIGHT, adult: true, name: "night".into() });
    records.push(adult_create.clone());
    assert_eq!(all_orders(&records).adult_edits.get(&NIGHT), Some(&adult_create.id()));
}

#[test]
fn adult_at_is_the_latest_accepted_claim_before_the_position() {
    let (mut records, heads) = founded(&[1]);
    let yes = rec(1, 1, heads.clone(), Action::AgeClaim { adult: true });
    let no = rec(1, 2, vec![yes.id()], Action::AgeClaim { adult: false });
    let later = rec(0, 2, vec![no.id()], Action::Invite { expires_ms: 0, max_uses: 0 });
    records.extend([yes.clone(), no.clone(), later.clone()]);
    let r = resolver(&records);
    assert_eq!(r.adult_at(actor(1), &heads), Ok(false), "before any claim");
    assert_eq!(r.adult_at(actor(1), &[yes.id()]), Ok(true));
    assert_eq!(r.adult_at(actor(1), &[no.id()]), Ok(false));
    assert_eq!(r.adult_at(actor(1), &[later.id()]), Ok(false));
    assert_eq!(r.adult_at(actor(0), &[yes.id()]), Ok(false), "someone else's claim");
    let unknown = RecordId::from_bytes([9; 32]);
    assert_eq!(r.adult_at(actor(1), &[unknown]), Err(vec![unknown]));
}

/// The query against the reference: for each prefix of a linear history,
/// `adult_at` with that prefix's last record as the dep matches whether the
/// actor's latest accepted claim (in the final state) within the prefix says
/// adult.
#[test]
fn adult_at_matches_the_reference_over_random_histories() {
    let mut rng = StdRng::seed_from_u64(45);
    for _ in 0..50 {
        let (mut records, heads) = founded(&[1, 2]);
        let mut head = heads;
        let mut seq: HashMap<u8, u64> = HashMap::from([(0, 2), (1, 1), (2, 1)]);
        for _ in 0..12 {
            let author = *[1u8, 2].choose(&mut rng).unwrap();
            let adult = *[true, false].choose(&mut rng).unwrap();
            let s = seq.get_mut(&author).unwrap();
            let claim = rec(author, *s, head.clone(), Action::AgeClaim { adult });
            *s += 1;
            head = vec![claim.id()];
            records.push(claim);
        }
        let state = resolve(server(), &records);
        let r = resolver(&records);
        for i in 3..records.len() {
            let dep = records[i].id();
            for who in [1u8, 2] {
                let expected = records[..=i]
                    .iter()
                    .rev()
                    .find(|x| {
                        x.author() == actor(who)
                            && state.accepted.contains(&x.id())
                            && matches!(Action::from_record(x), Some(Action::AgeClaim { .. }))
                    })
                    .is_some_and(|x| matches!(Action::from_record(x), Some(Action::AgeClaim { adult: true })));
                assert_eq!(r.adult_at(actor(who), &[dep]), Ok(expected), "after record {i}, actor {who}");
            }
        }
    }
}

/// `reaches` against a full walk of the deps, over random control DAGs.
#[test]
fn reaches_matches_a_full_ancestry_walk() {
    let mut rng = StdRng::seed_from_u64(46);
    for _ in 0..30 {
        let (mut records, heads) = founded(&[1, 2, 3]);
        let mut pool: Vec<RecordId> = heads;
        for seq in 2..20 {
            let a = pool[rng.gen_range(0..pool.len())];
            let b = pool[rng.gen_range(0..pool.len())];
            let deps: Vec<RecordId> = BTreeSet::from([a, b]).into_iter().collect();
            let post = rec(0, seq, deps, Action::Post { text: format!("p{seq}") });
            pool.push(post.id());
            records.push(post);
        }
        let deps: HashMap<RecordId, Vec<RecordId>> = records.iter().map(|r| (r.id(), r.deps().to_vec())).collect();
        let walk = |a: RecordId, of: RecordId| {
            let mut stack = vec![of];
            let mut seen = BTreeSet::new();
            while let Some(x) = stack.pop() {
                if x == a {
                    return true;
                }
                if seen.insert(x) {
                    stack.extend(deps.get(&x).cloned().unwrap_or_default());
                }
            }
            false
        };
        let r = resolver(&records);
        for a in &records {
            for b in &records {
                assert_eq!(r.reaches(a.id(), &[b.id()]), walk(a.id(), b.id()));
            }
        }
    }
}
