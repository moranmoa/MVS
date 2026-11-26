//! The profile post's size: a profile that doesn't fit one post is refused
//! with `profile-too-large`, and nothing changes.

mod common;

use api::*;
use base64::Engine;
use common::{Peer, World};
use records::{Kind, PublicKey, ServerId};

fn sign_up(peer: &Peer, name: &str) -> Identity {
    let input = NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() };
    let created = peer.core.create_identity(input).unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let profile = ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None };
    peer.core.update_profile(profile).unwrap()
}

/// A still 48×48 WebP of exactly `len` bytes (headers only: never decoded).
fn webp_of(len: usize) -> String {
    let mut vp8 = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
    vp8.extend_from_slice(&48u16.to_le_bytes());
    vp8.extend_from_slice(&48u16.to_le_bytes());
    vp8.extend_from_slice(&[0; 8]);
    let mut body = b"WEBP".to_vec();
    let pad = len - 12 - (8 + vp8.len()) - 8;
    for (kind, data) in [(b"VP8 ", vp8), (b"XTRA", vec![7u8; pad])] {
        body.extend_from_slice(kind);
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(&data);
    }
    let mut b = b"RIFF".to_vec();
    b.extend_from_slice(&(body.len() as u32).to_le_bytes());
    b.extend(body);
    assert_eq!(b.len(), len);
    format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
}

fn profile_posts(world: &World, server: &str, who: &str) -> usize {
    let server = ServerId::from_bytes(hex::decode(server).unwrap().try_into().unwrap());
    let who = PublicKey::from_bytes(hex::decode(who).unwrap().try_into().unwrap());
    world.network.fetch(server).iter().filter(|r| r.kind() == Kind::Post && r.author() == who).count()
}

#[test]
fn a_profile_too_large_for_one_post_is_refused_and_nothing_changes() {
    let world = World::new();
    let peer = world.peer();
    let me = sign_up(&peer, "Me").id;
    let server = peer.core.create_server("Team", AgeRestriction::None).unwrap();
    let largest = webp_of(api::avatar::AVATAR_SMALL_MAX);
    let input = |name: String| ProfileInput {
        display_name: name,
        bio: None,
        avatar_data_url: None,
        avatar_small: Some(largest.clone()),
        color: Some("#ffffff".into()),
    };

    // 32 four-byte emoji beside the largest picture: fits, and is posted.
    let fits = "🙂".repeat(32);
    let before = profile_posts(&world, &server.id, &me);
    peer.core.update_profile(input(fits.clone())).unwrap();
    assert_eq!(profile_posts(&world, &server.id, &me), before + 1);

    // 128 of them (the name's limit) don't: refused, nothing posted or saved.
    let posts = profile_posts(&world, &server.id, &me);
    let err = peer.core.update_profile(input("🙂".repeat(128))).unwrap_err();
    assert_eq!(err.code, ErrorCode::ProfileTooLarge);
    let line = serde_json::json!({ "cmd": "updateProfile", "args": { "input": {
        "displayName": "🙂".repeat(128), "avatarSmall": largest, "color": "#ffffff" } } });
    let answer: serde_json::Value = serde_json::from_str(&peer.core.handle(&line.to_string())).unwrap();
    assert_eq!(answer["error"]["code"], "profile-too-large");
    peer.core.sync_now().unwrap();
    assert_eq!(profile_posts(&world, &server.id, &me), posts);
    let identity = peer.core.get_identity().unwrap().unwrap();
    assert_eq!(identity.display_name, fits);
    assert_eq!(identity.color.as_deref(), Some("#ffffff"));
}
