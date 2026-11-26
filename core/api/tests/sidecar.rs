//! The sidecar's line protocol, driven in-process.

mod common;

use std::io::Cursor;
use std::sync::Arc;

use api::sidecar::{self, Lines, MAX_LINE};
use api::{Config, Core, FixedClock, LoopbackNetwork, PendingGroupKeys, Ports};
use identity::MemoryStore;
use serde_json::{json, Value};

/// Runs `input` through a fresh core; returns every output line.
fn run(input: &[u8]) -> Vec<Value> {
    run_counting(input).0
}

/// As [`run`], also with how many voice frames the fast path dropped.
fn run_counting(input: &[u8]) -> (Vec<Value>, u64) {
    let out = Lines::new(Vec::new());
    let core = Core::open(
        Config { db_path: None, app_version: "0.1.0-alpha".into() },
        Ports {
            secrets: Arc::new(MemoryStore::new()),
            network: Arc::new(LoopbackNetwork::new()),
            events: out.clone(),
            clock: Arc::new(FixedClock::new(common::NOW_MS)),
            cipher: Arc::new(PendingGroupKeys),
        },
    )
    .unwrap();
    let frames = core.voice_frames();
    sidecar::serve(&core, Cursor::new(input.to_vec()), &out).unwrap();
    drop(core);
    let bytes = Arc::try_unwrap(out).ok().expect("core dropped").into_inner();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.is_empty() || text.ends_with('\n'));
    let lines = text.lines().map(|line| serde_json::from_str(line).expect("each line is JSON")).collect();
    (lines, frames.dropped())
}

/// G-81 (#509, SL 1, dev-identity 4–5): an exact `voiceFrame` takes the
/// fast path: never a reply (not even with an `id`), never blocking the
/// commands around it, whose replies keep their order. A frame with no
/// call open, or malformed, is dropped and counted; serving goes on. A
/// near miss (`VoiceFrame`, a trailing space) is an ordinary command, so
/// it gets the usual error.
#[test]
fn voice_frames_take_the_fast_path_and_keep_reply_order() {
    let frame = r#"{"cmd":"voiceFrame","args":{"callId":"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a","seq":1,"ts":960,"data":"AQID"}}"#;
    let mut input = String::new();
    for i in 0..20 {
        input.push_str(&format!("{{\"id\":{i},\"cmd\":\"getIdentity\"}}\n"));
        for _ in 0..5 {
            input.push_str(frame);
            input.push('\n');
        }
    }
    let malformed = [
        r#"{"cmd":"voiceFrame"}"#,
        r#"{"cmd":"voiceFrame","args":[1,2]}"#,
        r#"{"cmd":"voiceFrame","args":{"callId":"0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A","seq":1,"ts":0,"data":""}}"#,
        r#"{"cmd":"voiceFrame","args":{"callId":"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a","seq":1,"ts":0,"data":"not base64!"}}"#,
        r#"{"id":"x","cmd":"voiceFrame","args":{}}"#,
    ];
    for line in malformed {
        input.push_str(line);
        input.push('\n');
    }
    input.push_str(r#"{"id":"near1","cmd":"VoiceFrame","args":{}}"#);
    input.push('\n');
    input.push_str(r#"{"id":"near2","cmd":"voiceFrame ","args":{}}"#);
    input.push('\n');
    input.push_str(r#"{"id":"last","cmd":"getIdentity"}"#);
    input.push('\n');

    let (lines, dropped) = run_counting(input.as_bytes());
    let mut want: Vec<Value> = (0..20).map(|i| json!({ "type": "response", "id": i, "ok": null })).collect();
    want.push(bad_request(json!("near1")));
    want.push(bad_request(json!("near2")));
    want.push(json!({ "type": "response", "id": "last", "ok": null }));
    assert_eq!(lines, want);
    // No call is open here, so every frame, well-formed or not, is dropped.
    assert_eq!(dropped, 20 * 5 + malformed.len() as u64);
}

fn bad_request(id: Value) -> Value {
    json!({ "type": "response", "id": id, "error": { "code": "bad-request" } })
}

#[test]
fn responses_carry_the_id_and_events_come_first() {
    let input = concat!(
        r#"{"id":1,"cmd":"getIdentity"}"#,
        "\n",
        r#"{"id":"b","cmd":"createIdentity","args":{"input":{"locale":"he","country":"IL","birthDate":"1990-05-01"}}}"#,
        "\n",
        r#"{"id":3,"cmd":"listServers"}"#,
        "\n",
    );
    let lines = run(input.as_bytes());
    assert_eq!(lines[0], json!({ "type": "response", "id": 1, "ok": null }));
    // createIdentity: four progress events, then its response.
    for event in &lines[1..5] {
        assert_eq!(event["type"], "event");
        assert_eq!(event["event"], "identity.progress");
        assert!(event.get("id").is_none());
    }
    assert_eq!(lines[5]["type"], "response");
    assert_eq!(lines[5]["id"], "b");
    assert_eq!(lines[5]["ok"]["words"].as_array().unwrap().len(), 12);
    assert_eq!(lines[6], json!({ "type": "response", "id": 3, "ok": [] }));
    assert_eq!(lines.len(), 7);
}

#[test]
fn malformed_lines_get_an_error_and_serving_goes_on() {
    let input = concat!(
        "not json\n",
        "[1,2]\n",
        "{\"cmd\":\"getIdentity\"}\n",
        "{\"id\":7}\n",
        "{\"id\":{\"x\":1},\"cmd\":\"getIdentity\"}\n",
        "{\"id\":8,\"cmd\":\"noSuchCommand\"}\n",
        "\n",
        "   \r\n",
        "{\"id\":9,\"cmd\":\"getIdentity\"}\r\n",
        "{\"id\":10,\"cmd\":\"getIdentity\"}",
    );
    let lines = run(input.as_bytes());
    assert_eq!(
        lines,
        [
            bad_request(Value::Null),
            bad_request(Value::Null),
            bad_request(Value::Null),
            bad_request(json!(7)),
            bad_request(Value::Null),
            bad_request(json!(8)),
            json!({ "type": "response", "id": 9, "ok": null }),
            json!({ "type": "response", "id": 10, "ok": null }),
        ]
    );
}

#[test]
fn a_line_over_the_limit_is_refused_whole() {
    let mut input = Vec::new();
    // Over the limit, with something that looks like a request at the end,
    // which must not be answered on its own.
    input.extend_from_slice(br#"{"id":1,"cmd":"getIdentity","pad":""#);
    input.resize(input.len() + MAX_LINE, b'x');
    input.extend_from_slice(b"\"}{\"id\":2,\"cmd\":\"getIdentity\"}\n");
    // Exactly at the limit is fine.
    let mut fits = br#"{"id":3,"cmd":"getIdentity","pad":""#.to_vec();
    fits.resize(MAX_LINE - 2, b'y');
    fits.extend_from_slice(b"\"}\n");
    input.extend_from_slice(&fits);
    // A long line with no newline before the end.
    input.resize(input.len() + MAX_LINE + 1, b'z');

    let lines = run(&input);
    assert_eq!(
        lines,
        [
            bad_request(Value::Null),
            json!({ "type": "response", "id": 3, "ok": null }),
            bad_request(Value::Null),
        ]
    );
}

#[test]
fn empty_input_is_a_clean_exit() {
    assert!(run(b"").is_empty());
}

#[test]
fn the_binary_wants_a_data_dir() {
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_mvs-core"))
        .arg("--nope")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}

#[test]
fn the_binary_refuses_a_relay_without_a_peer_id() {
    let dir = std::env::temp_dir().join(format!("mvs-relay-arg-{}", std::process::id()));
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mvs-core"))
        .arg("--data-dir")
        .arg(&dir)
        .args(["--relay", "/dns4/relay.example/tcp/443"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("/p2p/"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Runs the binary on an empty stdin; returns its exit code and stderr.
fn run_binary(name: &str, rust_log: Option<&str>) -> (Option<i32>, String) {
    let dir = std::env::temp_dir().join(format!("mvs-{name}-{}", std::process::id()));
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_mvs-core"));
    cmd.arg("--data-dir").arg(&dir).stdin(std::process::Stdio::null());
    cmd.env_remove("RUST_LOG");
    if let Some(spec) = rust_log {
        cmd.env("RUST_LOG", spec);
    }
    let out = cmd.output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn the_binary_starts_with_rust_log_set() {
    let (code, stderr) = run_binary("rust-log", Some("debug"));
    assert_eq!(code, Some(0), "{stderr}");
    assert!(stderr.contains("logging on"), "{stderr}");
    assert!(stderr.contains("mvs-core: ready"), "{stderr}");
}

#[test]
fn the_binary_logs_nothing_without_rust_log() {
    let (code, stderr) = run_binary("no-rust-log", None);
    assert_eq!(code, Some(0), "{stderr}");
    assert!(!stderr.contains("logging on"), "{stderr}");
}

#[test]
fn a_bad_rust_log_is_ignored() {
    let (code, stderr) = run_binary("bad-rust-log", Some("api=nope=x"));
    assert_eq!(code, Some(0), "{stderr}");
    assert!(stderr.contains("isn't a valid filter"), "{stderr}");
}
