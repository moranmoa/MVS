//! G-77, correcting the birth date (B7 §2): preview, same, raise (30
//! days), lower (at once, with what it takes away), too young, cancel.

mod common;

use api::*;
use common::{Peer, World, NOW_MS};
use serde_json::{json, Value};

const DAY_MS: u64 = 86_400_000;

/// An identity born 1990-05-01 (36 on 2026-11-03), past the recovery check.
fn sign_up(peer: &Peer, name: &str) -> Identity {
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    peer.core
        .update_profile(ProfileInput {
            display_name: name.into(),
            bio: None,
            avatar_data_url: None,
            avatar_small: None,
            color: None,
        })
        .unwrap()
}

fn call(peer: &Peer, command: &str, args: Value) -> Result<Value, String> {
    let line = json!({ "cmd": command, "args": args }).to_string();
    let answer: Value = serde_json::from_str(&peer.core.handle(&line)).unwrap();
    match answer.get("error") {
        Some(e) => Err(e["code"].as_str().map_or_else(|| e.to_string(), str::to_owned)),
        None => Ok(answer["ok"].clone()),
    }
}

fn identity(peer: &Peer) -> Identity {
    peer.core.get_identity().unwrap().unwrap()
}

#[test]
fn same_raise_cancel_and_refusals() {
    let world = World::new();
    let me = world.peer();
    sign_up(&me, "Me");

    // The same date: nothing to wait for. A later date (younger, even the
    // same age today): a lowering, at once.
    let same = call(&me, "correctBirthDate", json!({ "date": "1990-05-01" })).unwrap();
    assert_eq!(same, json!({ "kind": "same", "loses": [] }));
    let later = call(&me, "correctBirthDate", json!({ "date": "1990-06-01" })).unwrap();
    assert_eq!(later, json!({ "kind": "lower", "loses": [] }));
    assert_eq!(identity(&me).birth_date, "1990-06-01");

    // Older: a raise, pending for 30 days; the date stays until then.
    let preview = call(&me, "previewBirthDateCorrection", json!({ "date": "1980-01-01" })).unwrap();
    let effective_at = NOW_MS + 30 * DAY_MS;
    assert_eq!(preview, json!({ "kind": "raise", "effectiveAt": effective_at, "loses": [] }));
    assert!(identity(&me).pending_birth_date.is_none(), "a preview changes nothing");
    me.events.take();
    me.core.correct_birth_date("1980-01-01").unwrap();
    assert!(me.events.take().iter().any(|e| matches!(e, Event::IdentityChanged(_))));
    let now = identity(&me);
    assert_eq!(now.birth_date, "1990-06-01");
    assert_eq!(now.pending_birth_date, Some(PendingBirthDate { date: "1980-01-01".into(), effective_at }));

    // The same raise again keeps its clock.
    *world.clock.0.lock().unwrap() += DAY_MS;
    let again = me.core.correct_birth_date("1980-01-01").unwrap();
    assert_eq!(again.effective_at, Some(effective_at));
    assert_eq!(identity(&me).pending_birth_date.unwrap().effective_at, effective_at);

    // A new correction replaces it; cancelling drops it.
    me.core.correct_birth_date("1985-01-01").unwrap();
    assert_eq!(identity(&me).pending_birth_date.unwrap().date, "1985-01-01");
    call(&me, "cancelBirthDateCorrection", json!({})).unwrap();
    assert!(identity(&me).pending_birth_date.is_none());
    assert_eq!(identity(&me).birth_date, "1990-06-01");
    call(&me, "cancelBirthDateCorrection", json!({})).unwrap();

    // Under 16: refused, nothing changed. A bad date: bad-request.
    let young = call(&me, "previewBirthDateCorrection", json!({ "date": "2015-01-01" })).unwrap();
    assert_eq!(young["kind"], "too-young");
    assert_eq!(call(&me, "correctBirthDate", json!({ "date": "2015-01-01" })).unwrap_err(), "too-young");
    for bad in ["2031-01-01", "1899-12-31", "1990-02-30", "1990-1-1", "soon"] {
        assert_eq!(call(&me, "correctBirthDate", json!({ "date": bad })).unwrap_err(), "bad-request", "{bad}");
    }
    assert_eq!(identity(&me).birth_date, "1990-06-01");
}

/// Tech Lead on #512: an earlier date that leaves my age the same today
/// still makes me older sooner. It's a raise and waits 30 days, at the 18
/// boundary as at any other.
#[test]
fn an_earlier_birthday_at_the_same_age_still_waits() {
    let world = World::new();
    let me = world.peer();
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "2009-01-01".into() };
    let created = me.core.create_identity(input).unwrap();
    let positions = me.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(me.core.check_recovery_words(answers).unwrap().ok);

    // 17 either way today (2026-11-03); 18 on 2026-11-19 with the new date.
    let preview = me.core.correct_birth_date("2008-11-19").unwrap();
    assert_eq!(preview.kind, AgeCorrectionKind::Raise);
    assert_eq!(preview.effective_at, Some(NOW_MS + 30 * DAY_MS));
    assert_eq!(identity(&me).birth_date, "2009-01-01", "not until the 30 days");
    // On the new 18th birthday, still 17: the wait isn't over.
    *world.clock.0.lock().unwrap() += 17 * DAY_MS;
    me.core.sync_now().unwrap();
    assert_eq!(identity(&me).birth_date, "2009-01-01");
}

#[test]
fn a_raise_takes_effect_after_30_days() {
    let world = World::new();
    let me = world.peer();
    sign_up(&me, "Me");
    me.core.correct_birth_date("1980-01-01").unwrap();
    *world.clock.0.lock().unwrap() += 30 * DAY_MS - 1;
    me.core.sync_now().unwrap();
    assert_eq!(identity(&me).birth_date, "1990-05-01");
    *world.clock.0.lock().unwrap() += 1;
    me.events.take();
    me.core.sync_now().unwrap();
    let now = identity(&me);
    assert_eq!((now.birth_date.as_str(), now.pending_birth_date), ("1980-01-01", None));
    assert!(me.events.take().iter().any(|e| matches!(e, Event::IdentityChanged(_))));
}

#[test]
fn a_lowering_leaves_adult_servers_and_hides_adult_channels_at_once() {
    let world = World::new();
    let (owner, member) = (world.peer(), world.peer());
    sign_up(&owner, "Owner");
    let member_id = sign_up(&member, "Member").id;
    let adult_only = owner.core.create_server("Night club", AgeRestriction::Eighteen).unwrap();
    let open = owner.core.create_server("Open", AgeRestriction::None).unwrap();
    let night = owner.core.create_channel(&open.id, "night", true).unwrap();
    for server in [&adult_only, &open] {
        member.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    member.core.sync_now().unwrap();
    assert!(member.core.list_channels(&open.id).unwrap().iter().any(|c| c.id == night.id));

    // 17 now: the 18+ server goes whole, the 18+ channel elsewhere.
    let preview = member.core.preview_birth_date_correction("2009-06-01").unwrap();
    assert_eq!(preview.kind, AgeCorrectionKind::Lower);
    // In the order I joined them.
    assert_eq!(
        preview.loses,
        [
            AgeLoss { server_id: adult_only.id.clone(), name: "Night club".into(), channel: None },
            AgeLoss { server_id: open.id.clone(), name: "Open".into(), channel: Some("night".into()) },
        ]
    );

    member.events.take();
    member.core.correct_birth_date("2009-06-01").unwrap();
    let events = member.events.take();
    assert!(events.contains(&Event::ServerRemoved {
        server_id: adult_only.id.clone(),
        reason: Some(RemovedReason::Age),
        required: Some(AgeRestriction::Eighteen),
    }));
    assert!(events.contains(&Event::ChannelRemoved {
        server_id: open.id.clone(),
        channel_id: night.id.clone(),
        name: "night".into(),
        reason: Some(ChannelRemovedReason::Age),
    }));
    let wire = serde_json::to_value(events.iter().find(|e| matches!(e, Event::ServerRemoved { .. })).unwrap()).unwrap();
    assert_eq!(wire["payload"], json!({ "serverId": adult_only.id, "reason": "age", "required": "18+" }));
    let servers: Vec<String> = member.core.list_servers().unwrap().into_iter().map(|s| s.id).collect();
    assert_eq!(servers, [open.id.clone()]);
    assert!(!member.core.list_channels(&open.id).unwrap().iter().any(|c| c.id == night.id));
    assert_eq!(identity(&member).birth_date, "2009-06-01");

    // The owner sees the Leave in the 18+ server and keeps the member in the other.
    owner.core.sync_now().unwrap();
    assert!(!owner.core.list_members(&adult_only.id).unwrap().iter().any(|m| m.id == member_id));
    assert!(owner.core.list_members(&open.id).unwrap().iter().any(|m| m.id == member_id));

    // Back up again: a raise, pending; the server doesn't come back by itself.
    let raise = member.core.correct_birth_date("1990-05-01").unwrap();
    assert_eq!(raise.kind, AgeCorrectionKind::Raise);
    assert_eq!(member.core.list_servers().unwrap().len(), 1);
}

#[test]
fn an_owner_keeps_its_own_adult_server() {
    let world = World::new();
    let owner = world.peer();
    sign_up(&owner, "Owner");
    let mine = owner.core.create_server("Mine", AgeRestriction::Eighteen).unwrap();
    let preview = owner.core.preview_birth_date_correction("2009-06-01").unwrap();
    assert!(preview.loses.is_empty(), "{:?}", preview.loses);
    owner.core.correct_birth_date("2009-06-01").unwrap();
    assert_eq!(owner.core.list_servers().unwrap().len(), 1);
    assert_eq!(owner.core.list_servers().unwrap()[0].id, mine.id);
}
