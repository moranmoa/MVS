//! G-47, the block list: `listBlocked`, the idempotent `setBlocked`, the
//! `blockUser` toggle, and `blocks.changed`.

mod common;

use api::*;
use common::{Peer, World};
use serde_json::{json, Value};

fn adult() -> NewIdentityInput {
    NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() }
}

/// An identity past the recovery check, with a display name.
fn sign_up(peer: &Peer, name: &str) -> Identity {
    let created = peer.core.create_identity(adult()).unwrap();
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

/// The `blocks.changed` lists sent since the last look.
fn block_events(peer: &Peer) -> Vec<Vec<BlockedUser>> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::BlocksChanged { blocked } => Some(blocked),
            _ => None,
        })
        .collect()
}

#[test]
fn the_list_keeps_names_after_we_share_no_server() {
    let world = World::new();
    let (owner, member, stranger) = (world.peer(), world.peer(), world.peer());
    sign_up(&owner, "Owner");
    let bob = sign_up(&member, "Bob").id;
    let carol = sign_up(&stranger, "Carol").id;
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    member.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.events.take();

    assert_eq!(call(&owner, "listBlocked", json!({})).unwrap(), json!([]));
    call(&owner, "setBlocked", json!({ "userId": bob, "blocked": true })).unwrap();
    let want = vec![BlockedUser { user_id: bob.clone(), name: Some("Bob".into()) }];
    assert_eq!(block_events(&owner), [want.clone()]);
    assert_eq!(owner.core.list_blocked().unwrap(), want);

    // Idempotent: blocking again changes nothing and says nothing.
    call(&owner, "setBlocked", json!({ "userId": bob, "blocked": true })).unwrap();
    assert!(block_events(&owner).is_empty());

    // Someone I never shared a server with: listed, without a name.
    owner.core.set_blocked(&carol, true).unwrap();
    let list = owner.core.list_blocked().unwrap();
    assert_eq!(list.len(), 2);
    let no_name = list.iter().find(|b| b.user_id == carol).unwrap();
    assert_eq!(no_name.name, None);
    let wire = call(&owner, "listBlocked", json!({})).unwrap();
    let carol_wire = wire.as_array().unwrap().iter().find(|b| b["userId"] == json!(carol)).unwrap();
    assert_eq!(*carol_wire, json!({ "userId": carol }), "no name: the field is absent");

    // Bob blocks the owner, then is kicked: he's in no server now, and the
    // owner is still listed with the name kept when he blocked.
    let owner_id = owner.core.get_identity().unwrap().unwrap().id;
    member.core.set_blocked(&owner_id, true).unwrap();
    owner.core.kick_member(&server.id, &bob).unwrap();
    member.core.sync_now().unwrap();
    assert!(member.core.list_servers().unwrap().is_empty());
    let kept = BlockedUser { user_id: owner_id.clone(), name: Some("Owner".into()) };
    assert_eq!(member.core.list_blocked().unwrap(), [kept]);
    // The kept name and the blocked ID stay local: not in the diagnostics.
    let report = member.core.export_diagnostics().unwrap();
    assert!(!report.contains(&owner_id) && !report.contains("blocked-name"), "{report}");

    // Unblocking removes the owner and the kept name.
    member.events.take();
    call(&member, "setBlocked", json!({ "userId": owner_id, "blocked": false })).unwrap();
    assert_eq!(block_events(&member), [Vec::<BlockedUser>::new()]);
    call(&member, "setBlocked", json!({ "userId": owner_id, "blocked": false })).unwrap();
    assert!(block_events(&member).is_empty(), "already unblocked");
    member.core.set_blocked(&owner_id, true).unwrap();
    let again = member.core.list_blocked().unwrap();
    assert_eq!(again[0].name, None, "the old name went with the unblock");

    // The owner still has Bob's profile in the server's log: still named.
    let list = owner.core.list_blocked().unwrap();
    assert!(list.contains(&BlockedUser { user_id: bob.clone(), name: Some("Bob".into()) }));
}

#[test]
fn block_user_still_toggles_and_self_or_bad_ids_are_refused() {
    let world = World::new();
    let (me, other) = (world.peer(), world.peer());
    let my_id = sign_up(&me, "Me").id;
    let other_id = sign_up(&other, "Other").id;

    call(&me, "blockUser", json!({ "userId": other_id })).unwrap();
    assert_eq!(me.core.list_blocked().unwrap().len(), 1);
    assert_eq!(block_events(&me).len(), 1, "the toggle sends blocks.changed too");
    call(&me, "blockUser", json!({ "userId": other_id })).unwrap();
    assert!(me.core.list_blocked().unwrap().is_empty());

    assert_eq!(call(&me, "setBlocked", json!({ "userId": my_id, "blocked": true })).unwrap_err(), "bad-request");
    assert_eq!(call(&me, "blockUser", json!({ "userId": my_id })).unwrap_err(), "bad-request", "the toggle too");
    assert_eq!(call(&me, "setBlocked", json!({ "userId": "zz", "blocked": true })).unwrap_err(), "not-found");
    assert!(call(&me, "setBlocked", json!({ "userId": other_id })).is_err(), "blocked is required");
    assert!(me.core.list_blocked().unwrap().is_empty());
}
