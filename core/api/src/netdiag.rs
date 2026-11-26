//! NC-1 (b): the network part of the diagnostics file (`exportDiagnostics`).
//!
//! Testers attach the file to **public** issues, so it carries a fixed
//! vocabulary and counts only (QA's conditions on the board): never IPs,
//! ports, multiaddrs, host names, peer IDs, identity or server IDs, names,
//! links or per-event times.
//!
//! sync (dev-sync, NC-1 (a)) reports through [`crate::Network::net_counters`]
//! in its own words: each `(purpose, path, count)` and a reachability label.
//! Nothing it says is copied: each label is matched exactly against the
//! vocabulary below, and anything else is dropped (a count under an unknown
//! label is lost, never shown). The output always has every key, so the
//! file's shape never depends on the input.

use serde_json::{json, Map, Value};

/// What a connection was for.
pub const PURPOSES: [&str; 3] = ["join", "sync", "call"];
/// How a connection reached the peer.
pub const PATHS: [&str; 5] = ["direct-lan", "direct-holepunch", "member-relay", "our-relay", "none"];
/// This device's reachability verdict (RIA-R1).
pub const REACHABILITY: [&str; 5] = ["public", "port-mapped", "nat", "cgnat-likely", "unknown"];

/// What sync reports, in its own labels, before any check.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RawCounters {
    /// `(purpose, path, count)`; the same pair may repeat (summed).
    pub paths: Vec<(String, String, u64)>,
    pub reachability: String,
}

fn known<'a>(vocabulary: &[&'a str], label: &str) -> Option<&'a str> {
    vocabulary.iter().copied().find(|v| *v == label)
}

/// Totals as the file shows them (SL on #620): a bucket, never a count.
pub const TOTAL_BUCKETS: [&str; 5] = ["0", "1-5", "6-20", "21-100", ">100"];
/// Below this total, path shares are left out: they'd give counts away.
pub const SHARES_FROM: u64 = 6;

fn bucket(total: u64) -> &'static str {
    match total {
        0 => TOTAL_BUCKETS[0],
        1..=5 => TOTAL_BUCKETS[1],
        6..=20 => TOTAL_BUCKETS[2],
        21..=100 => TOTAL_BUCKETS[3],
        _ => TOTAL_BUCKETS[4],
    }
}

/// `part` of `total` in percent, rounded to the nearest 10.
fn share(part: u64, total: u64) -> u64 {
    // round(part / total * 10) tenths, in integers: (2·10·part + total) / (2·total).
    let tenths = (u128::from(part) * 20 + u128::from(total)) / (u128::from(total) * 2);
    (tenths.min(10) * 10) as u64
}

/// The `network` object of the diagnostics file, with no exact counts
/// (the manager's call on the SL's #620 note; R5 needs path proportions):
/// `{ "connections": { <purpose>: { "total": <bucket>, "shares"?: { <path>: <0..100 step 10> } } },
///    "reachability": <label> }`.
/// Every purpose is present; `shares` (every path) only from a total of
/// [`SHARES_FROM`].
pub fn network_json(raw: &RawCounters) -> Value {
    let mut connections = Map::new();
    for purpose in PURPOSES {
        let counts: Vec<u64> = PATHS
            .iter()
            .map(|path| {
                raw.paths
                    .iter()
                    .filter(|(p, q, _)| known(&PURPOSES, p) == Some(purpose) && known(&PATHS, q) == Some(*path))
                    .fold(0u64, |sum, (_, _, n)| sum.saturating_add(*n))
            })
            .collect();
        let total = counts.iter().fold(0u64, |sum, n| sum.saturating_add(*n));
        let mut entry = Map::new();
        entry.insert("total".to_owned(), json!(bucket(total)));
        if total >= SHARES_FROM {
            let shares: Map<String, Value> =
                PATHS.iter().zip(&counts).map(|(path, n)| ((*path).to_owned(), json!(share(*n, total)))).collect();
            entry.insert("shares".to_owned(), Value::Object(shares));
        }
        connections.insert(purpose.to_owned(), Value::Object(entry));
    }
    let reachability = known(&REACHABILITY, &raw.reachability).unwrap_or("unknown");
    json!({ "connections": connections, "reachability": reachability })
}

/// `storageBytes` as the file shows it: rounded to the nearest MiB, so it
/// can't fingerprint one install.
pub fn rounded_storage(bytes: u64) -> u64 {
    const MIB: u64 = 1024 * 1024;
    bytes.saturating_add(MIB / 2) / MIB * MIB
}

/// `exportedAtMs` as the file shows it: down to the minute.
pub fn rounded_time(ms: u64) -> u64 {
    ms / 60_000 * 60_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_labels_are_counted_and_every_key_is_present() {
        let raw = RawCounters {
            paths: vec![
                ("sync".into(), "direct-lan".into(), 3),
                ("sync".into(), "direct-lan".into(), 2),
                ("call".into(), "our-relay".into(), 1),
                ("join".into(), "member-relay".into(), u64::MAX),
                ("join".into(), "member-relay".into(), 9),
            ],
            reachability: "cgnat-likely".into(),
        };
        let v = network_json(&raw);
        // sync: 5 → a bucket, and too few for shares.
        assert_eq!(v["connections"]["sync"], json!({ "total": "1-5" }));
        assert_eq!(v["connections"]["call"], json!({ "total": "1-5" }));
        // join: saturates, >100, all of it member-relay.
        assert_eq!(v["connections"]["join"]["total"], ">100");
        assert_eq!(
            v["connections"]["join"]["shares"],
            json!({ "direct-lan": 0, "direct-holepunch": 0, "member-relay": 100, "our-relay": 0, "none": 0 })
        );
        assert_eq!(v["reachability"], "cgnat-likely");
        let empty = network_json(&RawCounters::default());
        assert_eq!(empty["reachability"], "unknown");
        for purpose in PURPOSES {
            assert_eq!(empty["connections"][purpose], json!({ "total": "0" }));
        }
        // Shares from 6 on, to the nearest 10%.
        let mixed = RawCounters {
            paths: vec![
                ("call".into(), "direct-lan".into(), 7),
                ("call".into(), "direct-holepunch".into(), 2),
                ("call".into(), "our-relay".into(), 1),
            ],
            reachability: "nat".into(),
        };
        let v = network_json(&mixed);
        assert_eq!(v["connections"]["call"]["total"], "6-20");
        assert_eq!(
            v["connections"]["call"]["shares"],
            json!({ "direct-lan": 70, "direct-holepunch": 20, "member-relay": 0, "our-relay": 10, "none": 0 })
        );
    }

    #[test]
    fn buckets_and_shares() {
        let buckets: Vec<&str> = [0, 1, 5, 6, 20, 21, 100, 101, u64::MAX].iter().map(|n| bucket(*n)).collect();
        assert_eq!(buckets, ["0", "1-5", "1-5", "6-20", "6-20", "21-100", "21-100", ">100", ">100"]);
        assert_eq!(share(1, 3), 30);
        assert_eq!(share(1, 6), 20);
        assert_eq!(share(5, 100), 10, "5% rounds up");
        assert_eq!(share(4, 100), 0);
        assert_eq!(share(u64::MAX, u64::MAX), 100);
        assert_eq!(share(0, 7), 0);
    }

    #[test]
    fn rounding() {
        assert_eq!(rounded_storage(0), 0);
        assert_eq!(rounded_storage(524_287), 0);
        assert_eq!(rounded_storage(524_288), 1_048_576);
        assert_eq!(rounded_storage(5 * 1_048_576 + 3), 5 * 1_048_576);
        assert_eq!(rounded_storage(u64::MAX), u64::MAX / 1_048_576 * 1_048_576);
        assert_eq!(rounded_time(1_764_115_199_999), 1_764_115_140_000);
        assert_eq!(rounded_time(59_999), 0);
    }

    /// A tiny deterministic generator (no rand dependency in tests).
    struct Gen(u64);
    impl Gen {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
            items[(self.next() % items.len() as u64) as usize]
        }
    }

    /// What a careless or hostile reporter might hand over.
    const HOSTILE: [&str; 24] = [
        "192.168.1.20",
        "10.0.0.1:4001",
        "fe80::1",
        "[2001:db8::7]:443",
        "/ip4/203.0.113.9/tcp/4001",
        "/ip6/::1/udp/4001/quic-v1",
        "/dns4/relay.example.org/tcp/443/wss/p2p/12D3KooWBVzkbuxE3TA4LU7zEeMBM87G4Ns1KQoPdAc4MR8R3GTc",
        "12D3KooWAHoEkEqnKzM5PXFygh2movVBCSX3k8tDsT2cneU68Gyt",
        "8c3f1a2b9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
        "relay.example.org",
        "mvs://join/0011/2233",
        "Direct-LAN",
        "direct-lan ",
        " direct-lan",
        "direct_lan",
        "direct-lan\0",
        "our-relay\u{202E}",
        "UNKNOWN",
        "public;nat",
        "cgnat",
        "",
        "שרת סודי",
        "<script>alert(1)</script>",
        "\"},\"x\":{\"",
    ];

    /// QA's condition: whatever sync reports, nothing outside the
    /// vocabulary, and no IP, multiaddr, 64-hex or peer ID, reaches the file.
    #[test]
    fn hostile_labels_never_reach_the_file() {
        let mut g = Gen(0x9E37_79B9_7F4A_7C15);
        let mut labels: Vec<&str> = HOSTILE.to_vec();
        labels.extend(PURPOSES);
        labels.extend(PATHS);
        labels.extend(REACHABILITY);
        let allowed: Vec<&str> = PURPOSES
            .iter()
            .chain(PATHS.iter())
            .chain(REACHABILITY.iter())
            .chain(TOTAL_BUCKETS.iter())
            .chain(["connections", "reachability", "total", "shares"].iter())
            .copied()
            .collect();
        for _ in 0..2_000 {
            let n = (g.next() % 12) as usize;
            let raw = RawCounters {
                paths: (0..n)
                    .map(|_| (g.pick(&labels).to_owned(), g.pick(&labels).to_owned(), g.next() % 1_000))
                    .collect(),
                reachability: g.pick(&labels).to_owned(),
            };
            let v = network_json(&raw);
            let text = v.to_string();
            // Every string in the output (keys and values) is from the vocabulary.
            let mut strings = Vec::new();
            collect_strings(&v, &mut strings);
            for s in &strings {
                assert!(allowed.contains(&s.as_str()), "{s:?} in {text}");
            }
            // And the grep checks QA runs on the file.
            assert!(!text.contains("12D3KooW") && !text.contains("/ip") && !text.contains("/dns"), "{text}");
            assert!(!text.contains("example") && !text.contains("mvs://"), "{text}");
            assert!(!has_ipv4(&text) && !has_hex_run(&text, 64), "{text}");
            // No exact counts: every number is a share, 0..=100 in steps of 10.
            let mut numbers = Vec::new();
            collect_numbers(&v, &mut numbers);
            assert!(numbers.iter().all(|n| *n <= 100 && n % 10 == 0), "{text}");
            // The shape: every purpose, a total bucket, shares (all paths) only from 6.
            assert_eq!(v["connections"].as_object().unwrap().len(), PURPOSES.len());
            for purpose in PURPOSES {
                let entry = &v["connections"][purpose];
                assert!(TOTAL_BUCKETS.contains(&entry["total"].as_str().unwrap()));
                match entry.get("shares") {
                    Some(shares) => {
                        assert!(!["0", "1-5"].contains(&entry["total"].as_str().unwrap()));
                        assert_eq!(shares.as_object().unwrap().len(), PATHS.len());
                    }
                    None => assert!(["0", "1-5"].contains(&entry["total"].as_str().unwrap())),
                }
            }
        }
    }

    fn collect_strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Object(map) => {
                for (k, v) in map {
                    out.push(k.clone());
                    collect_strings(v, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
            _ => {}
        }
    }

    fn collect_numbers(v: &Value, out: &mut Vec<u64>) {
        match v {
            Value::Number(n) => out.push(n.as_u64().expect("whole numbers only")),
            Value::Object(map) => map.values().for_each(|v| collect_numbers(v, out)),
            Value::Array(items) => items.iter().for_each(|v| collect_numbers(v, out)),
            _ => {}
        }
    }

    fn has_ipv4(text: &str) -> bool {
        let b = text.as_bytes();
        (0..b.len()).any(|i| {
            let mut j = i;
            let mut groups = 0;
            loop {
                let start = j;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    return false;
                }
                groups += 1;
                if groups == 4 {
                    return true;
                }
                if j < b.len() && b[j] == b'.' {
                    j += 1;
                } else {
                    return false;
                }
            }
        })
    }

    fn has_hex_run(text: &str, len: usize) -> bool {
        let mut run = 0;
        for c in text.chars() {
            run = if c.is_ascii_hexdigit() { run + 1 } else { 0 };
            if run >= len {
                return true;
            }
        }
        false
    }

    #[test]
    fn the_grep_helpers_catch_what_they_should() {
        assert!(has_ipv4("x 10.0.0.1 y") && !has_ipv4("1.2.3"));
        assert!(has_hex_run(HOSTILE[8], 64) && !has_hex_run("abc", 64));
    }
}
