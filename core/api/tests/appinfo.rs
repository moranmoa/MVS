//! G-48: `getAppInfo.abuseAddress`, from the build (`mvs-core
//! --abuse-address`), read-only, absent when unset.

mod common;

use common::{Peer, World};
use serde_json::Value;

fn info(core: &api::Core) -> Value {
    let answer: Value = serde_json::from_str(&core.handle(r#"{"cmd":"getAppInfo","args":{}}"#)).unwrap();
    answer["ok"].clone()
}

#[test]
fn the_abuse_address_shows_only_when_the_build_has_a_valid_one() {
    let world = World::new();
    let Peer { mut core, .. } = world.peer();
    assert!(info(&core).get("abuseAddress").is_none(), "absent when unset");

    // Refused: the core runs on without one.
    for bad in ["javascript:alert(1)", "http://example.org", "<a@b.org>", ""] {
        assert!(core.set_abuse_address(bad).is_err(), "{bad:?}");
    }
    assert!(info(&core).get("abuseAddress").is_none());

    core.set_abuse_address(" abuse@example.org ").unwrap();
    assert_eq!(info(&core)["abuseAddress"], "abuse@example.org");
    core.set_abuse_address("https://example.org/abuse").unwrap();
    assert_eq!(info(&core)["abuseAddress"], "https://example.org/abuse");
    // No command sets it: it's the build's.
    let set: Value =
        serde_json::from_str(&core.handle(r#"{"cmd":"setAbuseAddress","args":{"address":"x@y.org"}}"#)).unwrap();
    assert!(set.get("error").is_some());
}
