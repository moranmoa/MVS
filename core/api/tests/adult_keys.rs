//! B7-k: an 18+ channel's key goes to the adults among the members only.
//! An adult leaving that set (here: the channel turned 18+) is a removal:
//! the next moderator re-keys it, and a minor can't open what follows.

mod common;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use api::crypto::GroupKeysCipher;
use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::{ChannelId, Kind, PublicKey, Record, RecordId, Scope, ServerId};

/// The real cipher, recording who each rotation was for.
struct Recording {
    inner: GroupKeysCipher,
    rotations: Mutex<Vec<(ChannelId, BTreeSet<PublicKey>)>>,
}

impl Recording {
    fn new() -> Recording {
        Recording { inner: GroupKeysCipher::locked(), rotations: Mutex::default() }
    }
    fn inner(&self) -> &GroupKeysCipher {
        &self.inner
    }
    /// The readers of the latest rotation of `channel` this peer made.
    fn last_for(&self, channel: ChannelId) -> Option<BTreeSet<PublicKey>> {
        self.rotations.lock().unwrap().iter().rev().find(|(c, _)| *c == channel).map(|(_, m)| m.clone())
    }
}

impl GroupCipher for Recording {
    fn membership_changed(&self, s: ServerId, m: &BTreeSet<PublicKey>) -> CipherOutcome {
        self.inner().membership_changed(s, m)
    }
    fn encrypt(&self, s: ServerId, c: ChannelId, p: &[u8]) -> Result<Vec<u8>, CipherError> {
        self.inner().encrypt(s, c, p)
    }
    fn missing_readers(&self, s: ServerId, c: ChannelId) -> Vec<PublicKey> {
        self.inner().missing_readers(s, c)
    }
    fn decrypt(&self, s: ServerId, c: ChannelId, a: PublicKey, b: &[u8]) -> Result<Opened, CipherError> {
        self.inner().decrypt(s, c, a, b)
    }
    fn apply_rotation(&self, r: &Record) -> Result<Vec<RecordId>, CipherError> {
        self.inner().apply_rotation(r)
    }
    fn set_accepted(&self, s: ServerId, ids: &BTreeSet<RecordId>) {
        self.inner().set_accepted(s, ids)
    }
    fn set_channels(&self, s: ServerId, c: &BTreeSet<ChannelId>) {
        self.inner().set_channels(s, c)
    }
    fn set_adults(&self, s: ServerId, a: &BTreeSet<PublicKey>, c: &BTreeSet<ChannelId>) {
        self.inner().set_adults(s, a, c)
    }
    fn forget(&self, s: ServerId) {
        self.inner().forget(s)
    }
    fn unlock(&self, secret: Arc<groupkeys::MemberSecret>) {
        GroupCipher::unlock(self.inner(), secret)
    }
    fn lock(&self) {
        GroupCipher::lock(self.inner())
    }
    fn rotate(&self, s: ServerId, c: ChannelId, m: &BTreeSet<PublicKey>) -> Result<Vec<Vec<u8>>, CipherError> {
        self.rotations.lock().unwrap().push((c, m.clone()));
        self.inner().rotate(s, c, m)
    }
}

fn person(world: &World, name: &str, birth_date: &str) -> (Peer, Arc<Recording>, PublicKey) {
    let cipher = Arc::new(Recording::new());
    let peer = world.peer_with(Arc::new(MemoryStore::new()), None, cipher.clone());
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    let me = peer.core.update_profile(profile).unwrap();
    let key = PublicKey::from_bytes(hex::decode(&me.id).unwrap().try_into().unwrap());
    (peer, cipher, key)
}

fn ids(server: &ServerSummary, channel: &str) -> (ServerId, ChannelId) {
    let server = ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap());
    let channel = ChannelId::from_bytes(hex::decode(channel).unwrap().try_into().unwrap());
    (server, channel)
}

/// The newest message record in `channel` on the network.
fn latest_message(world: &World, server: ServerId, channel: ChannelId) -> Record {
    world
        .network
        .fetch(server)
        .into_iter()
        .filter(|r| r.kind() == Kind::Message && r.scope() == Scope::Channel(channel))
        .max_by_key(|r| r.ts())
        .expect("a message")
}

#[test]
fn an_adult_channel_is_keyed_for_adults_only_and_re_keyed_when_it_turns_adult() {
    let world = World::new();
    let (owner, owner_cipher, owner_key) = person(&world, "Owner", "1990-05-01");
    let (adult, _, adult_key) = person(&world, "Adult", "1990-05-01");
    let (minor, minor_cipher, minor_key) = person(&world, "Minor", "2009-06-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let night = owner.core.create_channel(&server.id, "night", true).unwrap().id;
    let lounge = owner.core.create_channel(&server.id, "lounge", false).unwrap().id;
    for peer in [&adult, &minor] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    for peer in [&adult, &minor] {
        peer.core.sync_now().unwrap();
    }
    let (server_key, night_key) = ids(&server, &night);
    let (_, lounge_key) = ids(&server, &lounge);

    // The 18+ channel: keyed for the two adults; the plain one for all three.
    owner.core.send_message(&night, "late", None).unwrap();
    owner.core.send_message(&lounge, "hello all", None).unwrap();
    assert_eq!(owner_cipher.last_for(night_key), Some(BTreeSet::from([owner_key, adult_key])));
    assert_eq!(owner_cipher.last_for(lounge_key), Some(BTreeSet::from([owner_key, adult_key, minor_key])));
    adult.core.sync_now().unwrap();
    minor.core.sync_now().unwrap();
    let bodies = |peer: &Peer, channel: &str| -> Vec<String> {
        peer.core.get_messages(channel, 0, 10).unwrap().messages.into_iter().map(|m| m.body).collect()
    };
    assert_eq!(bodies(&adult, &night), ["late"]);
    assert_eq!(bodies(&minor, &lounge), ["hello all"]);
    // Even with the record in hand, the minor's cipher can't open it.
    let late = latest_message(&world, server_key, night_key);
    assert!(minor_cipher.decrypt(server_key, night_key, late.author(), late.body()).is_err());

    // The plain channel turns 18+: the minor was a reader and isn't now,
    // a removal. The owner's next round re-keys it for the adults.
    owner.events.take();
    owner.core.update_channel(&lounge, None, Some(true)).unwrap();
    owner.core.sync_now().unwrap();
    assert_eq!(owner_cipher.last_for(lounge_key), Some(BTreeSet::from([owner_key, adult_key])));
    owner.core.send_message(&lounge, "adults only now", None).unwrap();
    minor.core.sync_now().unwrap();
    let after = latest_message(&world, server_key, lounge_key);
    assert!(
        minor_cipher.decrypt(server_key, lounge_key, after.author(), after.body()).is_err(),
        "the minor still had the old key: it must not open what comes after"
    );
    adult.core.sync_now().unwrap();
    assert!(bodies(&adult, &lounge).iter().any(|b| b == "adults only now"));
    // And the minor no longer sees the channel at all (B7 §4).
    assert!(!minor.core.list_channels(&server.id).unwrap().iter().any(|c| c.id == lounge));
}

/// Security Lead nit on #544: the cipher's adults are fresh at every seal.
/// A channel turned 18+ and written to at once, with no sync between, is
/// re-keyed for the adults first: never sealed under the old head.
#[test]
fn turned_adult_and_sent_at_once_re_keys_first() {
    let world = World::new();
    let (owner, owner_cipher, owner_key) = person(&world, "Owner", "1990-05-01");
    let (adult, _, adult_key) = person(&world, "Adult", "1990-05-01");
    let (minor, minor_cipher, minor_key) = person(&world, "Minor", "2009-06-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let den = owner.core.create_channel(&server.id, "den", false).unwrap().id;
    for peer in [&adult, &minor] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    let (server_key, den_key) = ids(&server, &den);
    owner.core.send_message(&den, "for everyone", None).unwrap();
    assert_eq!(owner_cipher.last_for(den_key), Some(BTreeSet::from([owner_key, adult_key, minor_key])));
    minor.core.sync_now().unwrap();

    owner.core.update_channel(&den, None, Some(true)).unwrap();
    owner.core.send_message(&den, "adults now", None).unwrap();
    assert_eq!(owner_cipher.last_for(den_key), Some(BTreeSet::from([owner_key, adult_key])));
    minor.core.sync_now().unwrap();
    let sent = latest_message(&world, server_key, den_key);
    assert!(minor_cipher.decrypt(server_key, den_key, sent.author(), sent.body()).is_err());
}

/// Security Lead K2: an owner of a server with an 18+ channel learns, once,
/// that a member runs a version without `adult-keys-v1`.
#[test]
fn owners_are_told_once_when_a_member_lacks_adult_keys() {
    use records::SigningKey;
    let world = World::new();
    let (owner, _, _) = person(&world, "Owner", "1990-05-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    owner.core.create_channel(&server.id, "night", true).unwrap();
    owner.core.sync_now().unwrap();
    let (key, _) = ids(&server, &owner.core.list_channels(&server.id).unwrap()[0].id);
    let notices = |peer: &Peer| -> Vec<NoticeKind> {
        peer.events
            .take()
            .into_iter()
            .filter_map(|e| match e {
                Event::Notice { kind, .. } => Some(kind),
                _ => None,
            })
            .collect()
    };
    owner.events.take();

    // A member on an older version joins: its profile lacks the cap.
    let old = SigningKey::from_bytes(&[43; 32]);
    let invite = {
        let link = server.invite_link.trim_start_matches("mvs://join/");
        RecordId::from_bytes(hex::decode(link.split('/').nth(1).unwrap()).unwrap().try_into().unwrap())
    };
    let control = || -> Vec<RecordId> {
        world.network.fetch(key).iter().filter(|x| x.scope() == Scope::Control).map(|x| x.id()).collect()
    };
    let mut deps: BTreeSet<RecordId> = control().into_iter().collect();
    deps.insert(invite);
    let join = authority::sign_control(&old, key, 1, deps.into_iter().collect(), 1, &authority::Action::Join { invite })
        .unwrap();
    world.network.publish(&join);
    let profile = |caps: &str, seq| {
        let text = format!(r#"{{"mvs":"mvs/profile/v1","displayName":"Old","caps":[{caps}]}}"#);
        authority::sign_control(&old, key, seq, control(), 2, &authority::Action::Post { text }).unwrap()
    };
    world.network.publish(&profile(r#""server-lifecycle-v1","reactions-v1","channel-topic-v1""#, 2));
    owner.core.sync_now().unwrap();
    assert_eq!(notices(&owner), [NoticeKind::AdultKeysOutdated]);
    let old_id = hex::encode(old.verifying_key().to_bytes());
    assert_eq!(owner.core.get_update_needed(&server.id, Some("adult-keys-v1")).unwrap(), [old_id]);
    owner.core.sync_now().unwrap();
    assert!(notices(&owner).is_empty(), "once, not every round");

    // It updates: the list empties, and no notice.
    world
        .network
        .publish(&profile(r#""server-lifecycle-v1","reactions-v1","channel-topic-v1","adult-keys-v1""#, 3));
    owner.core.sync_now().unwrap();
    assert!(owner.core.get_update_needed(&server.id, Some("adult-keys-v1")).unwrap().is_empty());
    assert!(!notices(&owner).contains(&NoticeKind::AdultKeysOutdated));
}

/// LM-2 (TL and SL on #619): a re-seal follows the channel's readers now.
/// An adult and a minor join before the owner's messages reached them:
/// both get the plain channel's message re-sealed, but in the 18+ channel
/// only the adult does; the minor can't open that re-seal.
#[test]
fn a_minor_joiner_gets_no_re_seal_in_an_adult_channel() {
    let world = World::new();
    let (owner, _, _) = person(&world, "Owner", "1990-05-01");
    let (adult, _, _) = person(&world, "Adult", "1990-05-01");
    let (minor, minor_cipher, _) = person(&world, "Minor", "2009-06-01");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let night = owner.core.create_channel(&server.id, "night", true).unwrap().id;
    let lounge = owner.core.create_channel(&server.id, "lounge", false).unwrap().id;
    for peer in [&adult, &minor] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    // Written before the owner saw either Join.
    owner.core.send_message(&night, "late", None).unwrap();
    owner.core.send_message(&lounge, "hello all", None).unwrap();
    owner.core.sync_now().unwrap();
    let bodies = |peer: &Peer, channel: &str| -> Vec<String> {
        peer.core.sync_now().unwrap();
        peer.core.get_messages(channel, 0, 10).unwrap().messages.into_iter().map(|m| m.body).collect()
    };
    assert_eq!(bodies(&adult, &night), ["late"]);
    assert_eq!(bodies(&adult, &lounge), ["hello all"]);
    assert_eq!(bodies(&minor, &lounge), ["hello all"]);
    let (server_key, night_key) = ids(&server, &night);
    let reseals: Vec<Record> = world
        .network
        .fetch(server_key)
        .into_iter()
        .filter(|r| r.kind() == Kind::MessageEdit && r.scope() == Scope::Channel(night_key))
        .collect();
    assert!(!reseals.is_empty(), "no re-seal for the adult");
    for edit in reseals {
        let sealed = &edit.body()[32..];
        assert!(minor_cipher.decrypt(server_key, night_key, edit.author(), sealed).is_err(), "the minor opened an 18+ re-seal");
    }
}
