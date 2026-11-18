//! G-48: reports to the owners between cores, over an in-process transport
//! that acks for the members who are "online".

mod common;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use records::PublicKey;

/// Boxes queue until `pump`; a box is acked only to an online recipient.
#[derive(Default)]
struct Hub {
    queue: Mutex<Vec<(PublicKey, PublicKey, Vec<u8>)>>,
    online: Mutex<BTreeSet<PublicKey>>,
}

struct Port {
    hub: Arc<Hub>,
    me: PublicKey,
}

impl ReportNet for Port {
    fn deliver(&self, to: PublicKey, blob: Vec<u8>) -> bool {
        assert!(blob.len() <= sync::MAX_REPORT_BLOB, "{}", blob.len());
        if !self.hub.online.lock().unwrap().contains(&to) {
            return false;
        }
        self.hub.queue.lock().unwrap().push((self.me, to, blob));
        true
    }
}

fn key_of(id: &str) -> PublicKey {
    PublicKey::from_bytes(hex::decode(id).unwrap().try_into().unwrap())
}

fn member(world: &World, hub: &Arc<Hub>, name: &str, birth_date: &str) -> (Peer, Identity) {
    let peer =
        world.peer_with(Arc::new(MemoryStore::new()), None, Arc::new(api::crypto::GroupKeysCipher::locked()));
    let created = peer
        .core
        .create_identity(NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: birth_date.into() })
        .unwrap();
    let positions = peer.core.get_recovery_challenge().unwrap().positions;
    let answers = positions.iter().map(|p| (*p, created.words[p - 1].clone())).collect();
    assert!(peer.core.check_recovery_words(answers).unwrap().ok);
    let me = peer
        .core
        .update_profile(ProfileInput { display_name: name.into(), bio: None, avatar_data_url: None, avatar_small: None, color: None })
        .unwrap();
    peer.core.set_report_net(Arc::new(Port { hub: hub.clone(), me: key_of(&me.id) }));
    hub.online.lock().unwrap().insert(key_of(&me.id));
    (peer, me)
}

/// Hands every acked box to its recipient's core; how many went.
fn pump(hub: &Hub, peers: &[(&Peer, &Identity)]) -> usize {
    let queued: Vec<_> = std::mem::take(&mut *hub.queue.lock().unwrap());
    for (from, to, blob) in &queued {
        if let Some((peer, _)) = peers.iter().find(|(_, id)| key_of(&id.id) == *to) {
            peer.core.report_received(Some(*from), blob);
        }
    }
    queued.len()
}

fn received(peer: &Peer) -> Vec<ReportSummary> {
    peer.events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::ReportReceived { report, .. } => Some(report),
            _ => None,
        })
        .collect()
}

struct Room {
    hub: Arc<Hub>,
    owner: Peer,
    owner_id: Identity,
    admin: Peer,
    admin_id: Identity,
    teen_admin: Peer,
    teen_admin_id: Identity,
    plain: Peer,
    plain_id: Identity,
    rude: Peer,
    rude_id: Identity,
    server: ServerSummary,
    channel: String,
}

impl Room {
    fn peers(&self) -> [(&Peer, &Identity); 5] {
        [
            (&self.owner, &self.owner_id),
            (&self.admin, &self.admin_id),
            (&self.teen_admin, &self.teen_admin_id),
            (&self.plain, &self.plain_id),
            (&self.rude, &self.rude_id),
        ]
    }

    fn sync_all(&self) {
        for _ in 0..2 {
            for (peer, _) in self.peers() {
                peer.core.sync_now().unwrap();
            }
        }
    }
}

/// The owner, two admins (one under 18 on the test clock), a plain member
/// and a rude one who posted something.
fn room() -> (World, Room, Message) {
    let world = World::new();
    let hub = Arc::new(Hub::default());
    let (owner, owner_id) = member(&world, &hub, "Owner", "1990-05-01");
    let (admin, admin_id) = member(&world, &hub, "Admin", "1990-05-01");
    // 17 on the test clock's 2026-11-03.
    let (teen_admin, teen_admin_id) = member(&world, &hub, "Teen", "2008-11-04");
    let (plain, plain_id) = member(&world, &hub, "Plain", "1990-05-01");
    let (rude, rude_id) = member(&world, &hub, "Rude", "1990-05-01");
    let server = owner.core.create_server("Reports", AgeRestriction::None).unwrap();
    for peer in [&admin, &teen_admin, &plain, &rude] {
        peer.core.join_server(&server.invite_link).unwrap();
    }
    owner.core.sync_now().unwrap();
    owner.core.grant_role(&server.id, &admin_id.id, Role::Admin).unwrap();
    owner.core.grant_role(&server.id, &teen_admin_id.id, Role::Admin).unwrap();
    let channel = owner.core.list_channels(&server.id).unwrap().remove(0).id;
    let room = Room {
        hub,
        owner,
        owner_id,
        admin,
        admin_id,
        teen_admin,
        teen_admin_id,
        plain,
        plain_id,
        rude,
        rude_id,
        server,
        channel,
    };
    room.sync_all();
    let message = room.rude.core.send_message(&room.channel, "you are all idiots", None).unwrap();
    room.sync_all();
    for (peer, _) in room.peers() {
        peer.events.take();
    }
    (world, room, message)
}

fn target_message(message: &Message) -> ReportTargetInput {
    ReportTargetInput::Message { message_id: message.id.clone() }
}

#[test]
fn staff_get_it_and_nobody_else_ever_sees_it() {
    let (_world, r, message) = room();
    let receipt = r
        .plain
        .core
        .report_content(&r.server.id, &target_message(&message), "harassment", Some("  again  "))
        .unwrap();
    assert_eq!(receipt.recipients, 3, "the owner and both admins");
    r.plain.core.report_tick();
    assert_eq!(pump(&r.hub, &r.peers()), 3);
    for (peer, _) in [(&r.owner, 0), (&r.admin, 1), (&r.teen_admin, 2)] {
        let got = received(peer);
        assert_eq!(got.len(), 1);
        let report = &got[0];
        assert_eq!(report.id, receipt.report_id);
        assert_eq!(report.reporter_id, r.plain_id.id);
        assert_eq!(report.reported_id, r.rude_id.id, "the message's author");
        assert_eq!(report.reason, "harassment");
        assert_eq!(report.text.as_deref(), Some("again"));
        assert!(report.evidence_valid && !report.evidence_withheld);
        assert_eq!(peer.core.list_reports(&r.server.id).unwrap(), got);
    }
    // The reported member and a plain member see nothing, and may not list.
    assert!(received(&r.rude).is_empty());
    for peer in [&r.rude, &r.plain] {
        assert_eq!(peer.core.list_reports(&r.server.id).unwrap_err().code, ErrorCode::NotAllowed);
    }
    // The evidence opens for staff, as plain text.
    let evidence = r.owner.core.get_report_evidence(&receipt.report_id).unwrap();
    assert_eq!(evidence.author_id, r.rude_id.id);
    assert_eq!(evidence.text.as_deref(), Some("you are all idiots"));
    // Delivered: nothing is sent again.
    r.plain.core.report_tick();
    assert_eq!(pump(&r.hub, &r.peers()), 0);
    let status: Vec<(u32, u32)> = r
        .plain
        .events
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Event::ReportStatus { delivered, pending, .. } => Some((delivered, pending)),
            _ => None,
        })
        .collect();
    assert_eq!(status, [(0, 3), (3, 0)]);
}

#[test]
fn a_reported_admin_never_gets_the_report_about_them() {
    let (_world, r, _) = room();
    let about_admin = ReportTargetInput::Member { user_id: r.admin_id.id.clone() };
    let receipt = r.plain.core.report_content(&r.server.id, &about_admin, "impersonation", None).unwrap();
    assert_eq!(receipt.recipients, 2);
    r.plain.core.report_tick();
    pump(&r.hub, &r.peers());
    assert!(received(&r.admin).is_empty());
    assert!(r.admin.core.list_reports(&r.server.id).unwrap().is_empty());
    assert_eq!(received(&r.owner).len(), 1);
    // The owner reported, by the only other staff: the admins get it.
    let about_owner = ReportTargetInput::Member { user_id: r.owner_id.id.clone() };
    assert_eq!(r.plain.core.report_content(&r.server.id, &about_owner, "hate", None).unwrap().recipients, 2);
}

#[test]
fn the_outbox_waits_for_an_offline_admin_and_rechecks_the_role() {
    let (_world, r, message) = room();
    let admin_key = key_of(&r.admin_id.id);
    let teen_key = key_of(&r.teen_admin_id.id);
    r.hub.online.lock().unwrap().remove(&admin_key);
    r.hub.online.lock().unwrap().remove(&teen_key);
    r.plain.core.report_content(&r.server.id, &target_message(&message), "spam", None).unwrap();
    r.plain.core.report_tick();
    assert_eq!(pump(&r.hub, &r.peers()), 1, "only the owner is online");
    // The admin comes online: delivered now.
    r.hub.online.lock().unwrap().insert(admin_key);
    r.plain.core.report_tick();
    assert_eq!(pump(&r.hub, &r.peers()), 1);
    assert_eq!(received(&r.admin).len(), 1);
    // The teen admin is demoted before coming online: their row is dropped.
    r.owner.core.revoke_role(&r.server.id, &r.teen_admin_id.id).unwrap();
    r.sync_all();
    r.hub.online.lock().unwrap().insert(teen_key);
    r.plain.core.report_tick();
    assert_eq!(pump(&r.hub, &r.peers()), 0, "no longer staff: never sent");
    assert!(received(&r.teen_admin).is_empty());
}

#[test]
fn losing_staff_deletes_the_reports_held() {
    let (_world, r, message) = room();
    r.plain.core.report_content(&r.server.id, &target_message(&message), "spam", None).unwrap();
    r.plain.core.report_tick();
    pump(&r.hub, &r.peers());
    assert_eq!(r.admin.core.list_reports(&r.server.id).unwrap().len(), 1);
    r.owner.core.revoke_role(&r.server.id, &r.admin_id.id).unwrap();
    r.sync_all();
    assert_eq!(r.admin.core.list_reports(&r.server.id).unwrap_err().code, ErrorCode::NotAllowed);
    // Granted again: what it held is gone for good.
    r.owner.core.grant_role(&r.server.id, &r.admin_id.id, Role::Admin).unwrap();
    r.sync_all();
    assert!(r.admin.core.list_reports(&r.server.id).unwrap().is_empty());
}

#[test]
fn sensitive_evidence_is_behind_a_click_and_never_for_minors() {
    let (_world, r, message) = room();
    let receipt = r.plain.core.report_content(&r.server.id, &target_message(&message), "minor", None).unwrap();
    r.plain.core.report_tick();
    pump(&r.hub, &r.peers());
    let owner_view = received(&r.owner);
    assert!(!owner_view[0].evidence_withheld);
    let teen_view = received(&r.teen_admin);
    assert!(teen_view[0].evidence_withheld, "an admin under 18");
    // No event or list carries evidence; the adult gets it on a click.
    let json = serde_json::to_value(&owner_view[0]).unwrap();
    assert!(!json.to_string().contains("idiots"), "{json}");
    assert!(r.owner.core.get_report_evidence(&receipt.report_id).unwrap().text.is_some());
    assert_eq!(
        r.teen_admin.core.get_report_evidence(&receipt.report_id).unwrap_err().code,
        ErrorCode::NotAllowed
    );
}

#[test]
fn caps_and_refusals_sign_nothing() {
    let (_world, r, message) = room();
    let code = |peer: &Peer, target: &ReportTargetInput, reason: &str, text: Option<&str>| {
        peer.core.report_content(&r.server.id, target, reason, text).unwrap_err().code
    };
    let me = ReportTargetInput::Member { user_id: r.plain_id.id.clone() };
    let mine_msg = r.plain.core.send_message(&r.channel, "mine", None).unwrap();
    assert_eq!(code(&r.plain, &me, "spam", None), ErrorCode::NotAllowed);
    assert_eq!(code(&r.plain, &target_message(&mine_msg), "spam", None), ErrorCode::NotAllowed);
    assert_eq!(code(&r.plain, &target_message(&message), "rude", None), ErrorCode::BadRequest);
    assert_eq!(code(&r.plain, &target_message(&message), "other", Some("a\nb")), ErrorCode::BadRequest);
    let stranger = ReportTargetInput::Member { user_id: hex::encode([9u8; 32]) };
    assert_eq!(code(&r.plain, &stranger, "spam", None), ErrorCode::NotFound);
    let nowhere = ReportTargetInput::Message { message_id: hex::encode([8u8; 32]) };
    assert_eq!(code(&r.plain, &nowhere, "spam", None), ErrorCode::NotFound);
    assert!(r.hub.queue.lock().unwrap().is_empty());
    // One report per target; then 5 an hour.
    r.plain.core.report_content(&r.server.id, &target_message(&message), "spam", None).unwrap();
    assert_eq!(code(&r.plain, &target_message(&message), "hate", None), ErrorCode::AlreadyReported);
    let others = [&r.owner_id, &r.admin_id, &r.teen_admin_id, &r.rude_id];
    for id in others {
        let target = ReportTargetInput::Member { user_id: id.id.clone() };
        r.plain.core.report_content(&r.server.id, &target, "spam", None).unwrap();
    }
    let another = r.rude.core.send_message(&r.channel, "more", None).unwrap();
    r.sync_all();
    assert_eq!(code(&r.plain, &target_message(&another), "spam", None), ErrorCode::RateLimited);
}

#[test]
fn no_recipient_when_only_the_reported_owner_is_staff() {
    let world = World::new();
    let hub = Arc::new(Hub::default());
    let (owner, owner_id) = member(&world, &hub, "Owner", "1990-05-01");
    let (plain, _) = member(&world, &hub, "Plain", "1990-05-01");
    let server = owner.core.create_server("Solo", AgeRestriction::None).unwrap();
    plain.core.join_server(&server.invite_link).unwrap();
    owner.core.sync_now().unwrap();
    plain.core.sync_now().unwrap();
    let about_owner = ReportTargetInput::Member { user_id: owner_id.id.clone() };
    assert_eq!(
        plain.core.report_content(&server.id, &about_owner, "hate", None).unwrap_err().code,
        ErrorCode::NoRecipient
    );
}

#[test]
fn forged_replayed_or_misbound_boxes_are_dropped() {
    let (_world, r, message) = room();
    r.plain.core.report_content(&r.server.id, &target_message(&message), "spam", None).unwrap();
    r.plain.core.report_tick();
    let queued: Vec<_> = std::mem::take(&mut *r.hub.queue.lock().unwrap());
    let (from, _, blob) = queued.iter().find(|(_, to, _)| *to == key_of(&r.owner_id.id)).unwrap().clone();
    // From a peer bound to someone else: dropped.
    r.owner.core.report_received(Some(key_of(&r.rude_id.id)), &blob);
    assert!(received(&r.owner).is_empty());
    // Tampered: dropped.
    let mut bad = blob.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    r.owner.core.report_received(Some(from), &bad);
    assert!(received(&r.owner).is_empty());
    // Sealed to someone else: dropped.
    let (_, _, for_admin) = queued.iter().find(|(_, to, _)| *to == key_of(&r.admin_id.id)).unwrap().clone();
    r.owner.core.report_received(Some(from), &for_admin);
    assert!(received(&r.owner).is_empty());
    // The real one once; its replay is dropped.
    r.owner.core.report_received(Some(from), &blob);
    r.owner.core.report_received(Some(from), &blob);
    assert_eq!(received(&r.owner).len(), 1);
    assert_eq!(r.owner.core.list_reports(&r.server.id).unwrap().len(), 1);
}

#[test]
fn through_the_dispatcher() {
    let (_world, r, message) = room();
    let call = |peer: &Peer, cmd: &str, args: serde_json::Value| -> serde_json::Value {
        let request = serde_json::json!({ "cmd": cmd, "args": args }).to_string();
        serde_json::from_str(&peer.core.handle(&request)).unwrap()
    };
    let ok = call(
        &r.plain,
        "reportContent",
        serde_json::json!({
            "serverId": r.server.id,
            "target": { "kind": "message", "messageId": message.id },
            "reason": "spam",
        }),
    );
    let id = ok["ok"]["reportId"].as_str().unwrap().to_owned();
    assert_eq!(ok["ok"]["recipients"], 3);
    r.plain.core.report_tick();
    pump(&r.hub, &r.peers());
    let list = call(&r.owner, "listReports", serde_json::json!({ "serverId": r.server.id }));
    let report = &list["ok"][0];
    assert_eq!(report["id"], id.as_str());
    assert_eq!(report["target"]["kind"], "message");
    assert_eq!(report["target"]["messageId"], message.id.as_str());
    assert!(report.get("text").is_none());
    let evidence = call(&r.owner, "getReportEvidence", serde_json::json!({ "reportId": id }));
    assert_eq!(evidence["ok"]["text"], "you are all idiots");
    let dismissed = call(&r.owner, "dismissReport", serde_json::json!({ "reportId": id }));
    assert_eq!(dismissed, serde_json::json!({ "ok": null }));
    assert!(r.owner.core.list_reports(&r.server.id).unwrap()[0].dismissed);
    let bad = call(
        &r.plain,
        "reportContent",
        serde_json::json!({ "serverId": r.server.id, "target": { "kind": "member", "userId": r.rude_id.id }, "reason": "nope" }),
    );
    assert_eq!(bad["error"]["code"], "bad-request");
    let again = call(
        &r.plain,
        "reportContent",
        serde_json::json!({ "serverId": r.server.id, "target": { "kind": "message", "messageId": message.id }, "reason": "spam" }),
    );
    assert_eq!(again["error"]["code"], "already-reported");
}
