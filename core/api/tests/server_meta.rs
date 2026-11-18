//! G-51: `setServerIcon` and `setServerDescription`, and what members see
//! (`ServerSummary.iconDataUrl`, `description`, `server.updated`).

mod common;

use api::*;
use base64::Engine;
use common::{Peer, World};
use serde_json::{json, Value};

fn sign_up(peer: &Peer, name: &str) -> Identity {
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    peer.core.update_profile(profile).unwrap()
}

fn call(peer: &Peer, command: &str, args: Value) -> Result<Value, String> {
    let line = json!({ "cmd": command, "args": args }).to_string();
    let answer: Value = serde_json::from_str(&peer.core.handle(&line)).unwrap();
    match answer.get("error") {
        Some(e) => Err(e["code"].as_str().map_or_else(|| e.to_string(), str::to_owned)),
        None => Ok(answer["ok"].clone()),
    }
}

/// A minimal still PNG (headers only: never decoded) as a data URL.
fn png(w: u32, h: u32) -> String {
    let chunk = |kind: &[u8; 4], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]);
        out
    };
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    b.extend(chunk(b"IHDR", &ihdr));
    b.extend(chunk(b"IDAT", &[0; 16]));
    b.extend(chunk(b"IEND", &[]));
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
}

fn summary(peer: &Peer, server: &str) -> ServerSummary {
    peer.core.list_servers().unwrap().into_iter().find(|s| s.id == server).unwrap()
}

#[test]
fn the_owner_sets_an_icon_and_a_description_and_members_see_them() {
    let world = World::new();
    let (owner, member) = (world.peer(), world.peer());
    sign_up(&owner, "Owner");
    sign_up(&member, "Member");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    member.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    owner.events.take();

    let text = "Welcome!\n\nBe kind.";
    let after = call(&owner, "setServerDescription", json!({ "serverId": server.id, "description": format!("  {text}  ") })).unwrap();
    assert_eq!(after["description"], text, "trimmed");
    let icon = png(64, 64);
    let after = owner.core.set_server_icon(&server.id, Some(&icon)).unwrap();
    assert_eq!(after.icon_data_url.as_deref(), Some(icon.as_str()));
    let updates = owner.events.take().into_iter().filter(|e| matches!(e, Event::ServerUpdated(_))).count();
    assert_eq!(updates, 2);

    member.events.take();
    member.core.sync_now().unwrap();
    let seen = summary(&member, &server.id);
    assert_eq!((seen.description.as_deref(), seen.icon_data_url.as_deref()), (Some(text), Some(icon.as_str())));
    assert!(member.events.take().iter().any(|e| matches!(e, Event::ServerUpdated(s) if s.description.as_deref() == Some(text))));

    // Clearing: the fields are absent again.
    *world.clock.0.lock().unwrap() += 10 * 60_000;
    call(&owner, "setServerIcon", json!({ "serverId": server.id, "dataUrl": null })).unwrap();
    let cleared = call(&owner, "setServerDescription", json!({ "serverId": server.id, "description": "" })).unwrap();
    assert!(cleared.get("iconDataUrl").is_none() && cleared.get("description").is_none(), "{cleared}");
    member.core.sync_now().unwrap();
    let seen = summary(&member, &server.id);
    assert_eq!((seen.icon_data_url, seen.description), (None, None));
}

#[test]
fn refusals_rate_limit_and_no_op() {
    let world = World::new();
    let (owner, member) = (world.peer(), world.peer());
    sign_up(&owner, "Owner");
    sign_up(&member, "Member");
    let server = owner.core.create_server("Team", AgeRestriction::None).unwrap();
    member.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    member.core.sync_now().unwrap();

    // Only the owner or an admin.
    assert_eq!(call(&member, "setServerDescription", json!({ "serverId": server.id, "description": "mine" })).unwrap_err(), "not-allowed");
    assert_eq!(member.core.set_server_icon(&server.id, Some(&png(8, 8))).unwrap_err().code, ErrorCode::NotAllowed);

    // Bad input.
    for bad in ["1\n2\n3\n4\n5\n6", "a\r\nb", "a \nb", "a\n\n\nb", "a\u{202E}b"] {
        assert_eq!(owner.core.set_server_description(&server.id, bad).unwrap_err().code, ErrorCode::BadRequest, "{bad:?}");
    }
    for bad in [png(129, 10), "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=".into(), png(8, 8).replace("image/png", "image/webp"), "data:image/png;base64,!!!".into()] {
        assert_eq!(owner.core.set_server_icon(&server.id, Some(&bad)).unwrap_err().code, ErrorCode::BadRequest);
    }
    assert_eq!(owner.core.set_server_icon("zz", None).unwrap_err().code, ErrorCode::NotFound);

    // One icon change per 10 minutes; the same icon again signs nothing.
    let first = png(16, 16);
    owner.core.set_server_icon(&server.id, Some(&first)).unwrap();
    owner.core.set_server_icon(&server.id, Some(&first)).unwrap();
    assert_eq!(owner.core.set_server_icon(&server.id, Some(&png(32, 32))).unwrap_err().code, ErrorCode::RateLimited);
    *world.clock.0.lock().unwrap() += 10 * 60_000;
    owner.core.set_server_icon(&server.id, Some(&png(32, 32))).unwrap();

    // Clearing is never limited (Tech Lead on #555): set, clear at once,
    // then setting again within 10 minutes still is.
    owner.core.set_server_icon(&server.id, None).unwrap();
    assert_eq!(summary(&owner, &server.id).icon_data_url, None);
    assert_eq!(owner.core.set_server_icon(&server.id, Some(&png(24, 24))).unwrap_err().code, ErrorCode::RateLimited);

    // The cap name is known to getUpdateNeeded; everyone here has it.
    assert!(owner.core.get_update_needed(&server.id, Some("server-meta-v1")).unwrap().is_empty());
}
