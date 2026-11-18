//! G-14: a channel's topic, a control record the owner or an admin signs.
//! Every test runs the reference `resolve` and the incremental `Resolver`
//! over many delivery orders and requires them to agree.

mod common;

use authority::{
    channel_topic_ok, resolve, Action, ChannelId, Record, RecordId, Resolver, Role, State,
    MAX_CHANNEL_TOPIC,
};
use common::{actor, founded, key, rec, server};
mod rng;
use records::{Draft, Kind, Scope, MAX_CHANNEL_TOPIC_BYTES};
use rng::{SliceRandom, StdRng};

const ORDERS: u64 = 200;
const GENERAL: ChannelId = ChannelId::from_bytes([5; 32]);
const RANDOM: ChannelId = ChannelId::from_bytes([6; 32]);

fn all_orders(records: &[Record]) -> State {
    let expected = resolve(server(), records);
    let mut rng = StdRng::seed_from_u64(14);
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

fn create(seq: u64, deps: Vec<RecordId>, channel: ChannelId, name: &str) -> Record {
    rec(0, seq, deps, Action::ChannelCreate { channel, adult: false, name: name.into() })
}

fn topic(author: u8, seq: u64, deps: Vec<RecordId>, channel: ChannelId, text: &str) -> Record {
    rec(author, seq, deps, Action::ChannelTopic { channel, topic: text.into() })
}

/// The owner (0) with an admin (1), a moderator (2) and a member (3), and
/// two channels; returns the records and the head.
fn staffed() -> (Vec<Record>, RecordId) {
    let (mut records, heads) = founded(&[1, 2, 3]);
    let admin = rec(0, 2, heads, Action::Grant { target: actor(1), role: Role::Admin });
    let moderator =
        rec(0, 3, vec![admin.id()], Action::Grant { target: actor(2), role: Role::Moderator });
    let general = create(4, vec![moderator.id()], GENERAL, "general");
    let random = create(5, vec![general.id()], RANDOM, "random");
    let head = random.id();
    records.extend([admin, moderator, general, random]);
    (records, head)
}

#[test]
fn the_owner_or_an_admin_sets_a_topic_and_the_latest_counts() {
    let (mut records, head) = staffed();
    let by_owner = topic(0, 10, vec![head], GENERAL, "Welcome, read the rules");
    let by_admin = topic(1, 1, vec![head], RANDOM, "Anything goes");
    let by_moderator = topic(2, 1, vec![head], GENERAL, "moderator");
    let by_member = topic(3, 1, vec![head], RANDOM, "member");
    records.extend([by_owner.clone(), by_admin.clone(), by_moderator.clone(), by_member.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&by_owner.id()) && state.accepted.contains(&by_admin.id()));
    assert!(!state.accepted.contains(&by_moderator.id()), "moderators don't set topics");
    assert!(!state.accepted.contains(&by_member.id()), "members don't set topics");
    assert_eq!(state.topics[&GENERAL], "Welcome, read the rules");
    assert_eq!(state.topics[&RANDOM], "Anything goes");

    // Two concurrent topics: the later one in linear order counts.
    let one = topic(0, 11, vec![by_owner.id()], GENERAL, "one");
    let two = topic(1, 2, vec![by_owner.id()], GENERAL, "two");
    records.extend([one.clone(), two.clone()]);
    let state = all_orders(&records);
    let latest = if one.id() > two.id() { "one" } else { "two" };
    assert_eq!(state.topics[&GENERAL], latest);

    // An empty topic clears it.
    let cleared = topic(1, 3, vec![one.id(), two.id()], GENERAL, "");
    records.push(cleared.clone());
    let state = all_orders(&records);
    assert!(state.accepted.contains(&cleared.id()));
    assert!(!state.topics.contains_key(&GENERAL));
    assert_eq!(state.topics[&RANDOM], "Anything goes", "other channels keep theirs");
}

#[test]
fn only_live_channels_have_topics() {
    let (mut records, head) = staffed();
    let unknown = ChannelId::from_bytes([7; 32]);
    let nowhere = topic(0, 10, vec![head], unknown, "nowhere");
    let set = topic(0, 11, vec![head], RANDOM, "soon gone");
    let gone = rec(0, 12, vec![set.id()], Action::ChannelDelete { channel: RANDOM });
    let after = topic(1, 1, vec![gone.id()], RANDOM, "too late");
    records.extend([nowhere.clone(), set.clone(), gone, after.clone()]);
    let state = all_orders(&records);
    assert!(!state.accepted.contains(&nowhere.id()), "no topic for an unknown channel");
    assert!(state.accepted.contains(&set.id()));
    assert!(!state.accepted.contains(&after.id()), "no topic for a deleted channel");
    assert!(state.topics.is_empty(), "deleting a channel drops its topic");
}

/// A revoke (the only demotion) or a kick voids the author's concurrent
/// topics, as for every privileged record: no backdating.
#[test]
fn a_demotion_or_kick_voids_concurrent_topics() {
    let (mut records, head) = staffed();
    let concurrent = topic(1, 1, vec![head], GENERAL, "backdated");
    let demoted = rec(0, 10, vec![head], Action::revoke(actor(1)));
    let after = topic(1, 2, vec![demoted.id()], RANDOM, "as a member");
    records.extend([concurrent.clone(), demoted.clone(), after.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&demoted.id()));
    assert!(!state.accepted.contains(&concurrent.id()), "a demotion voids concurrent topics");
    assert!(!state.accepted.contains(&after.id()), "a member can't set one");
    assert!(state.topics.is_empty());

    // The admin re-granted: a topic signed after that counts again.
    let regrant = rec(0, 11, vec![after.id()], Action::Grant { target: actor(1), role: Role::Admin });
    let again = topic(1, 3, vec![regrant.id()], GENERAL, "back");
    records.extend([regrant, again.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&again.id()));
    assert_eq!(state.topics[&GENERAL], "back");

    // A kick voids the concurrent ones too.
    let racing = topic(1, 4, vec![again.id()], RANDOM, "racing the kick");
    let kick = rec(0, 12, vec![again.id()], Action::kick(actor(1)));
    records.extend([racing.clone(), kick.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&kick.id()));
    assert!(!state.accepted.contains(&racing.id()), "a kick voids concurrent topics");
    assert_eq!(state.topics[&GENERAL], "back", "topics the kick descends from stay");
    assert!(!state.topics.contains_key(&RANDOM));
}

#[test]
fn topics_are_one_short_line_of_plain_text() {
    assert!(channel_topic_ok("Welcome"));
    assert!(channel_topic_ok("ברוכים הבאים 😀"));
    assert!(channel_topic_ok(&"ש".repeat(MAX_CHANNEL_TOPIC)));
    assert!(!channel_topic_ok(&"ש".repeat(MAX_CHANNEL_TOPIC + 1)));
    // 256 four-byte code points is the byte cap exactly.
    let widest = "😀".repeat(MAX_CHANNEL_TOPIC);
    assert_eq!(widest.len(), MAX_CHANNEL_TOPIC_BYTES);
    assert!(channel_topic_ok(&widest));
    for bad in ["", " lead", "trail ", "two\nlines", "a\rb", "a\tb", "a\u{202E}b", "a\u{200B}b"] {
        assert!(!channel_topic_ok(bad), "{bad:?}");
    }
}

/// Bodies `Action::body` never produces: never accepted.
#[test]
fn hostile_topic_bodies_are_never_accepted() {
    let (mut records, head) = staffed();
    let id = RANDOM.as_bytes().to_vec();
    let bodies: Vec<Vec<u8>> = vec![
        vec![],
        id[..31].to_vec(),
        id.clone(),                                         // no history byte
        [id.clone(), vec![1], b"x".to_vec()].concat(),      // history set (D30)
        [id.clone(), vec![0], vec![0xff, 0xfe]].concat(),   // not UTF-8
        [id.clone(), vec![0], b" x".to_vec()].concat(),     // not trimmed
        [id.clone(), vec![0], b"a\nb".to_vec()].concat(),   // a line break
        [id.clone(), vec![0], "\u{202E}x".as_bytes().to_vec()].concat(),
        [id.clone(), vec![0], "a".repeat(MAX_CHANNEL_TOPIC + 1).into_bytes()].concat(),
    ];
    let mut refused = Vec::new();
    for (seq, body) in bodies.into_iter().enumerate() {
        let record = Draft {
            server: server(),
            scope: Scope::Control,
            seq: 20 + seq as u64,
            deps: vec![head],
            auth_deps: vec![],
            ts: 0,
            kind: Kind::ChannelTopic,
            body,
        }
        .sign(&key(0))
        .unwrap();
        assert_eq!(Action::from_record(&record), None);
        refused.push(record);
    }
    let good = topic(0, 40, vec![head], RANDOM, "ok");
    assert_eq!(good.body(), [id.as_slice(), &[0], b"ok"].concat());
    assert_eq!(
        Action::from_record(&good),
        Some(Action::ChannelTopic { channel: RANDOM, topic: "ok".into() })
    );
    let cleared = topic(0, 41, vec![head], RANDOM, "");
    assert_eq!(cleared.body().len(), 33);
    records.extend(refused);
    let state = all_orders(&records);
    assert!(state.topics.is_empty());
}
