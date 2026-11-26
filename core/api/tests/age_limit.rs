//! G-52: `setAgeRestriction` and `countAgeAffected`
//! (`docs/design/server-age-limit.md`, #590): the owner changes a server's
//! age limit; a raise to 18+ sends its minors away and marks who isn't an
//! adult for the owner and admins; a lowering lets 16- and 17-year-olds in.

mod common;

use api::*;
use common::{Peer, World};
use serde_json::{json, Value};

fn person(world: &World, name: &str, birth_date: &str) -> (Peer, String) {
    let peer = world.peer();
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    let id = peer.core.update_profile(profile).unwrap().id;
    (peer, id)
}

const ADULT: &str = "1990-05-01";
/// 17 on the test clock (2026-11-03).
const MINOR: &str = "2009-06-01";

fn call(peer: &Peer, command: &str, args: Value) -> Result<Value, String> {
    let line = json!({ "cmd": command, "args": args }).to_string();
    let answer: Value = serde_json::from_str(&peer.core.handle(&line)).unwrap();
    match answer.get("error") {
        Some(e) => Err(e["code"].as_str().map_or_else(|| e.to_string(), str::to_owned)),
        None => Ok(answer["ok"].clone()),
    }
}

fn limit_records(world: &World, server: &ServerSummary) -> usize {
    let id = records::ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap());
    world.network.fetch(id).iter().filter(|r| r.kind() == records::Kind::ServerAgeLimit).count()
}

#[test]
fn a_raise_to_18_sends_minors_away_and_marks_who_is_not_adult() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", ADULT);
    let (adult, _) = person(&world, "Adult", ADULT);
    let (minor, minor_id) = person(&world, "Minor", MINOR);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    adult.core.join_server(&server.invite_link).unwrap();
    minor.core.join_server(&server.invite_link).unwrap();
    for peer in [&owner, &adult, &minor] {
        peer.core.sync_now().unwrap();
    }
    let count = |limit: &str| call(&owner, "countAgeAffected", json!({ "serverId": server.id, "ageRestriction": limit }));
    assert_eq!(count("18+").unwrap(), json!({ "count": 1 }));
    assert_eq!(count("16+").unwrap(), json!({ "count": 0 }));
    // No one is marked while the server isn't 18+.
    assert!(owner.core.list_members(&server.id).unwrap().iter().all(|m| m.not_adult.is_none()));

    let summary = owner.core.set_age_restriction(&server.id, AgeRestriction::Eighteen).unwrap();
    assert_eq!(summary.age_restriction, AgeRestriction::Eighteen);
    assert_eq!(limit_records(&world, &server), 1);
    // The owner sees the minor as not adult until they leave.
    let marked: Vec<String> = owner
        .core
        .list_members(&server.id)
        .unwrap()
        .into_iter()
        .filter(|m| m.not_adult == Some(true))
        .map(|m| m.id)
        .collect();
    assert_eq!(marked.as_slice(), std::slice::from_ref(&minor_id));

    // The minor's core reads the raise and leaves (B7's age notice).
    minor.events.take();
    minor.core.sync_now().unwrap();
    let removed = minor.events.take().into_iter().find_map(|e| match e {
        Event::ServerRemoved { server_id, reason, required } if server_id == server.id => Some((reason, required)),
        _ => None,
    });
    assert_eq!(removed, Some((Some(RemovedReason::Age), Some(AgeRestriction::Eighteen))));
    assert!(minor.core.list_servers().unwrap().is_empty());
    owner.core.sync_now().unwrap();
    assert!(owner.core.list_members(&server.id).unwrap().iter().all(|m| m.id != minor_id));

    // The adult stays and sees the new limit.
    adult.core.sync_now().unwrap();
    let seen = adult.core.list_servers().unwrap().into_iter().find(|s| s.id == server.id).unwrap();
    assert_eq!(seen.age_restriction, AgeRestriction::Eighteen);
    // Members never see the marking; only the owner and admins do.
    assert!(adult.core.list_members(&server.id).unwrap().iter().all(|m| m.not_adult.is_none()));
}

#[test]
fn only_an_adult_owner_changes_it_and_the_same_value_signs_nothing() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", ADULT);
    let (admin, admin_id) = person(&world, "Admin", ADULT);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    admin.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.core.grant_role(&server.id, &admin_id, Role::Admin).unwrap();
    admin.core.sync_now().unwrap();

    let set = |peer: &Peer, limit: &str| call(peer, "setAgeRestriction", json!({ "serverId": server.id, "ageRestriction": limit }));
    assert_eq!(set(&admin, "16+").unwrap_err(), "not-allowed");
    assert_eq!(set(&owner, "17+").unwrap_err(), "bad-request");
    assert_eq!(set(&owner, "none").unwrap()["ageRestriction"], "none");
    assert_eq!(limit_records(&world, &server), 0, "the current value signs nothing");
    // The admin may count; a plain member may not.
    assert!(call(&admin, "countAgeAffected", json!({ "serverId": server.id, "ageRestriction": "18+" })).is_ok());

    // A minor owner can't make their server 18+.
    let (young, _) = person(&world, "Young", MINOR);
    let theirs = young.core.create_server("Mine", AgeRestriction::Sixteen).unwrap();
    assert_eq!(
        call(&young, "setAgeRestriction", json!({ "serverId": theirs.id, "ageRestriction": "18+" })).unwrap_err(),
        "too-young"
    );
    assert_eq!(limit_records(&world, &theirs), 0);
    assert_eq!(set(&owner, "16+").unwrap()["ageRestriction"], "16+");
    assert_eq!(limit_records(&world, &server), 1);
}

/// A member whose core can't read kind 26 (no `lv:1` in its profile) holds
/// the change back: it would ignore the limit and keep keying minors.
#[test]
fn an_older_member_holds_it_back() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", ADULT);
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    let old = records::SigningKey::from_bytes(&[71; 32]);
    let id = records::ServerId::from_bytes(hex::decode(&server.id).unwrap().try_into().unwrap());
    let invite = {
        let link = server.invite_link.trim_start_matches("mvs://join/");
        records::RecordId::from_bytes(hex::decode(link.split('/').nth(1).unwrap()).unwrap().try_into().unwrap())
    };
    let mut deps: std::collections::BTreeSet<records::RecordId> = world
        .network
        .fetch(id)
        .iter()
        .filter(|r| r.scope() == records::Scope::Control)
        .map(|r| r.id())
        .collect();
    deps.insert(invite);
    let deps: Vec<records::RecordId> = deps.into_iter().collect();
    let join = authority::sign_control(&old, id, 1, deps, 1, &authority::Action::Join { invite }).unwrap();
    world.network.publish(&join);
    owner.core.sync_now().unwrap();
    assert_eq!(owner.core.set_age_restriction(&server.id, AgeRestriction::Sixteen).unwrap_err().code, ErrorCode::UpdateNeeded);
    assert_eq!(limit_records(&world, &server), 0);
}

/// Lowering from 18+ lets a 17-year-old join (B7-k keeps 18+ channels 18+).
#[test]
fn a_lowering_lets_16_and_17_year_olds_in() {
    let world = World::new();
    let (owner, _) = person(&world, "Owner", ADULT);
    let (minor, _) = person(&world, "Minor", MINOR);
    let server = owner.core.create_server("Night", AgeRestriction::Eighteen).unwrap();
    minor.core.join_server(&server.invite_link).unwrap();
    assert!(minor.core.list_servers().unwrap().is_empty(), "an 18+ server refuses a minor");

    owner.core.set_age_restriction(&server.id, AgeRestriction::Sixteen).unwrap();
    minor.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    minor.core.sync_now().unwrap();
    let joined = minor.core.list_servers().unwrap().into_iter().find(|s| s.id == server.id).unwrap();
    assert_eq!(joined.age_restriction, AgeRestriction::Sixteen);
}
