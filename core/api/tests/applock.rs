//! G-78, the app lock: the core's commands through the line protocol (as
//! the shell's main process calls them), with the persistent counter.

mod common;

use std::sync::Arc;

use api::*;
use common::{Peer, World};
use identity::MemoryStore;
use serde_json::{json, Value};

fn adult() -> NewIdentityInput {
    NewIdentityInput { locale: Locale::He, country: "IL".into(), birth_date: "1990-05-01".into() }
}

/// A peer with its core DB on disk, so a restart keeps the counter.
fn peer_at(world: &World, secrets: &Arc<MemoryStore>, db: &std::path::Path) -> Peer {
    world.peer_with(secrets.clone(), Some(db.to_path_buf()), Arc::new(PendingGroupKeys))
}

fn call(peer: &Peer, command: &str, args: Value) -> Result<Value, String> {
    let line = json!({ "cmd": command, "args": args }).to_string();
    let answer: Value = serde_json::from_str(&peer.core.handle(&line)).unwrap();
    match answer.get("error") {
        Some(e) => Err(e["code"].as_str().map_or_else(|| e.to_string(), str::to_owned)),
        None => Ok(answer["ok"].clone()),
    }
}

fn advance(world: &World, ms: u64) {
    *world.clock.0.lock().unwrap() += ms;
}

fn result(v: &Result<Value, String>) -> &str {
    v.as_ref().unwrap()["result"].as_str().unwrap()
}

fn setup(world: &World, name: &str) -> (Peer, Arc<MemoryStore>, std::path::PathBuf, Vec<String>) {
    let dir = std::env::temp_dir().join(format!("mvs-api-applock-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("core.db");
    let secrets = Arc::new(MemoryStore::new());
    let peer = peer_at(world, &secrets, &db);
    let words = peer.core.create_identity(adult()).unwrap().words;
    (peer, secrets, db, words)
}

fn set(peer: &Peer, current: Option<&str>, passcode: &str) -> Result<Value, String> {
    let mut args = json!({ "passcode": passcode, "method": "passcode", "idleMinutes": 5, "lockOnSleep": true });
    if let Some(current) = current {
        args["current"] = json!(current);
    }
    call(peer, "setAppLock", args)
}

/// Off by default; set, verify, change and clear, with `current` required
/// once a lock exists. The answer never carries the verifier or the salt.
#[test]
fn set_verify_change_and_clear() {
    let world = World::new();
    let (peer, _, _, _) = setup(&world, "basic");
    let off = call(&peer, "getAppLock", json!({})).unwrap();
    assert_eq!(off, json!({ "enabled": false, "method": "passcode", "idleMinutes": 5, "lockOnSleep": true }));
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "ok", "no lock: nothing to check");

    assert_eq!(result(&set(&peer, None, "2468")), "ok");
    let on = call(&peer, "getAppLock", json!({})).unwrap();
    assert_eq!(on["enabled"], true);
    let text = on.to_string();
    assert!(!text.contains("salt") && !text.contains("hash"), "{text}");

    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "ok");
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "1357" }))), "wrong");

    // A change needs the current passcode.
    assert_eq!(set(&peer, None, "97531").unwrap_err(), "bad-request");
    assert_eq!(result(&set(&peer, Some("0000"), "97531")), "wrong");
    let changed = call(
        &peer,
        "setAppLock",
        json!({ "current": "2468", "passcode": "my long phrase", "method": "os", "idleMinutes": 15, "lockOnSleep": false }),
    );
    assert_eq!(result(&changed), "ok");
    let now = call(&peer, "getAppLock", json!({})).unwrap();
    assert_eq!((now["method"].as_str(), now["idleMinutes"].as_u64(), now["lockOnSleep"].as_bool()), (Some("os"), Some(15), Some(false)));
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "wrong");
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "my long phrase" }))), "ok");

    assert_eq!(result(&call(&peer, "clearAppLock", json!({ "current": "nope nope" }))), "wrong");
    assert_eq!(result(&call(&peer, "clearAppLock", json!({ "current": "my long phrase" }))), "ok");
    assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], false);
}

/// Bad new passcodes and settings are `bad-request`, and don't count.
#[test]
fn bad_settings_are_refused_without_counting() {
    let world = World::new();
    let (peer, _, _, _) = setup(&world, "bad");
    for passcode in ["246", "1234567890123", "abc12", "pass\nword"] {
        assert_eq!(set(&peer, None, passcode).unwrap_err(), "bad-request", "{passcode:?}");
    }
    let idle = json!({ "passcode": "2468", "method": "passcode", "idleMinutes": 0, "lockOnSleep": true });
    assert_eq!(call(&peer, "setAppLock", idle).unwrap_err(), "bad-request");
    let method = json!({ "passcode": "2468", "method": "face", "idleMinutes": 5, "lockOnSleep": true });
    assert_eq!(call(&peer, "setAppLock", method).unwrap_err(), "bad-request");
    let extra = json!({ "passcode": "2468", "extra": 1 });
    assert_eq!(call(&peer, "verifyAppLock", extra).unwrap_err(), "bad-request");
    assert!(call(&peer, "getAppLock", json!({})).unwrap().get("retryAfter").is_none());
}

/// One counter for every path: the 5th wrong attempt in a row starts 30 s,
/// doubling; while it runs nothing is checked (not even the right passcode
/// or the words); a restart keeps it; the right answer afterwards resets it.
#[test]
fn one_persistent_counter_with_backoff() {
    let world = World::new();
    let (peer, secrets, db, words) = setup(&world, "counter");
    assert_eq!(result(&set(&peer, None, "2468")), "ok");
    // Four wrong ones across the paths, then the fifth starts the delay.
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "0000" }))), "wrong");
    assert_eq!(result(&set(&peer, Some("1111"), "13579")), "wrong");
    assert_eq!(result(&call(&peer, "clearAppLock", json!({ "current": "2222" }))), "wrong");
    let not_mine = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    assert_eq!(result(&call(&peer, "clearAppLockWithWords", json!({ "words": not_mine }))), "wrong");
    let fifth = call(&peer, "verifyAppLock", json!({ "passcode": "3333" })).unwrap();
    assert_eq!(fifth, json!({ "result": "wrong", "retryAfter": 30 }));

    // While it runs: rate-limited without checking, on every path.
    let right = call(&peer, "verifyAppLock", json!({ "passcode": "2468" })).unwrap();
    assert_eq!(right["result"], "rate-limited");
    assert!(right["retryAfter"].as_u64().unwrap() <= 30);
    assert_eq!(result(&call(&peer, "clearAppLockWithWords", json!({ "words": words.join(" ") }))), "rate-limited");
    assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], true, "the lock stays");

    // A restart keeps the delay.
    drop(peer);
    let peer = peer_at(&world, &secrets, &db);
    assert!(call(&peer, "getAppLock", json!({})).unwrap()["retryAfter"].as_u64().is_some());
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "rate-limited");

    // After 30 s, one more wrong one doubles it.
    advance(&world, 30_000);
    let sixth = call(&peer, "verifyAppLock", json!({ "passcode": "4444" })).unwrap();
    assert_eq!(sixth, json!({ "result": "wrong", "retryAfter": 60 }));
    advance(&world, 60_000);
    assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "ok");
    // Reset: four free attempts again.
    for _ in 0..4 {
        let wrong = call(&peer, "verifyAppLock", json!({ "passcode": "5555" })).unwrap();
        assert_eq!(wrong, json!({ "result": "wrong" }));
    }
}

/// "Forgot": my own 12 words clear the lock; nothing else is touched.
#[test]
fn my_words_clear_the_lock() {
    let world = World::new();
    let (peer, _, _, words) = setup(&world, "words");
    assert_eq!(result(&set(&peer, None, "2468")), "ok");
    let typed = format!("  {}  ", words.join("  ").to_uppercase());
    let cleared = call(&peer, "clearAppLockWithWords", json!({ "words": typed }));
    assert_eq!(result(&cleared), "ok");
    assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], false);
    assert!(peer.core.get_identity().unwrap().is_some(), "the identity stays");
    let long = "x".repeat(1025);
    assert_eq!(call(&peer, "clearAppLockWithWords", json!({ "words": long })).unwrap_err(), "bad-request");
}

/// Security Lead on #476: an app-lock record that doesn't parse (or has
/// another version) is still a lock. It reads as enabled; verify, set and
/// clear answer `wrong` (counted); only my 12 words clear it. Fail closed.
#[test]
fn an_unreadable_lock_record_stays_locked() {
    let world = World::new();
    let (peer, secrets, db, words) = setup(&world, "broken");
    assert_eq!(result(&set(&peer, None, "2468")), "ok");
    drop(peer);
    for bad in [&b"not json"[..], br#"{"v":2,"salt":"00","mKib":1,"t":1,"p":1,"hash":"00","method":"passcode","idleMinutes":5,"lockOnSleep":true}"#] {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("UPDATE kv SET value = ?1 WHERE key = 'app-lock'", [bad]).unwrap();
        drop(conn);
        let peer = peer_at(&world, &secrets, &db);
        assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], true, "never off");
        assert_eq!(result(&call(&peer, "verifyAppLock", json!({ "passcode": "2468" }))), "wrong");
        assert_eq!(result(&set(&peer, Some("2468"), "13579")), "wrong");
        assert_eq!(result(&call(&peer, "clearAppLock", json!({ "current": "2468" }))), "wrong");
        assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], true);
        // The words still clear it.
        assert_eq!(result(&call(&peer, "clearAppLockWithWords", json!({ "words": words.join(" ") }))), "ok");
        assert_eq!(call(&peer, "getAppLock", json!({})).unwrap()["enabled"], false);
        assert_eq!(result(&set(&peer, None, "2468")), "ok");
        drop(peer);
    }
}
