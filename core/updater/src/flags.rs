//! Signed global flags (member relays slice 3b): `update-<channel>/flags.json`.
//!
//! A separate file, not a manifest field: `ManifestBody` is
//! `deny_unknown_fields`, so a new field would stop every installed app from
//! updating. Older apps never fetch this file.
//!
//! Same envelope and the same offline update key as the manifest, under its
//! own context (`mvs/update-flags/v1`), so a manifest signature can never be
//! replayed as flags or the other way round.
//!
//! Only installs that update in-app fetch this file. A Linux package, or an
//! app too old to know it, never gets the switch.
//!
//! ```json
//! { "signed": "{\"v\":1,\"issuedAt\":1800000000,\"memberRelayOff\":true}",
//!   "signatures": [ { "key": "<hex>", "sig": "<hex>" } ] }
//! ```

use serde::{Deserialize, Serialize};

use crate::manifest::{add_signature, valid_signers, SignatureEntry};
use crate::{Error, SigningKey, TrustRoot, MAX_CLOCK_SKEW_SECS};

/// Signing context: never the manifest's or the root's.
pub const FLAGS_SIGNING_CONTEXT: &[u8] = b"mvs/update-flags/v1\0";
/// The only flags format this code understands.
pub const FLAGS_FORMAT: u32 = 1;
/// A flags file is tiny; anything bigger is refused before parsing.
pub const MAX_FLAGS_BYTES: usize = 4 * 1024;

/// What the owner switches for every client.
///
/// Unlike the envelope, the body accepts unknown fields, so a flag added
/// later never makes older clients drop the file and stop following
/// `memberRelayOff` (the `ManifestBody` lesson). They are covered by the
/// signature, ignored, and never stored: a client keeps only `issuedAt` and
/// `memberRelayOff`.
///
/// Rules for later fields:
/// - Only a field that can only turn something **off** may be added under
///   `v: 1`. Older clients ignore it, which is the safe side.
/// - Any field that could **enable** something needs `v: 2` (older clients
///   then reject the whole file) and a security review.
/// - There is deliberately no expiry: an "off" that expired would silently
///   turn relays back on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagsBody {
    pub v: u32,
    /// Unix seconds. The newest wins; an older file never replaces a newer one.
    pub issued_at: u64,
    /// Turns member relays off for everyone (reason `global-off`).
    pub member_relay_off: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedFlags {
    pub signed: String,
    pub signatures: Vec<SignatureEntry>,
}

/// Flags whose signatures and format were checked. Only
/// [`SignedFlags::verify`] makes one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedFlags {
    body: FlagsBody,
}

impl VerifiedFlags {
    pub fn issued_at(&self) -> u64 {
        self.body.issued_at
    }
    pub fn member_relay_off(&self) -> bool {
        self.body.member_relay_off
    }

    /// A value this client verified earlier and kept in its state folder.
    /// Kept as plain values, not re-verified, so a later root rotation does
    /// not throw away the last switch the owner set.
    pub(crate) fn kept(issued_at: u64, member_relay_off: bool) -> Self {
        VerifiedFlags { body: FlagsBody { v: FLAGS_FORMAT, issued_at, member_relay_off } }
    }
}

impl SignedFlags {
    pub fn new(body: &FlagsBody) -> Result<Self, Error> {
        if body.v != FLAGS_FORMAT {
            return Err(Error::Malformed(format!("unsupported flags format {}", body.v)));
        }
        let signed = serde_json::to_string(body).map_err(|e| Error::Malformed(e.to_string()))?;
        Ok(SignedFlags { signed, signatures: Vec::new() })
    }

    pub fn sign(&mut self, key: &SigningKey) {
        add_signature(FLAGS_SIGNING_CONTEXT, &self.signed, &mut self.signatures, key);
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_FLAGS_BYTES {
            return Err(Error::Malformed(format!("flags larger than {MAX_FLAGS_BYTES} bytes")));
        }
        serde_json::from_slice(bytes).map_err(|e| Error::Malformed(e.to_string()))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("flags always serialise")
    }

    /// Signatures first (threshold of `root`, flags context), then the body.
    /// A body dated more than `MAX_CLOCK_SKEW_SECS` ahead of `now` is refused,
    /// so a future-dated file cannot pin a value forever.
    pub fn verify(&self, root: &TrustRoot, now: u64) -> Result<VerifiedFlags, Error> {
        let valid = valid_signers(FLAGS_SIGNING_CONTEXT, &self.signed, &self.signatures, root)?;
        if valid < root.threshold() {
            return Err(Error::InsufficientSignatures { valid, required: root.threshold() });
        }
        let body: FlagsBody = serde_json::from_str(&self.signed).map_err(|e| Error::Malformed(e.to_string()))?;
        if body.v != FLAGS_FORMAT {
            return Err(Error::Malformed(format!("unsupported flags format {}", body.v)));
        }
        if body.issued_at > now.saturating_add(MAX_CLOCK_SKEW_SECS) {
            return Err(Error::IssuedInFuture { issued_at: body.issued_at, now });
        }
        Ok(VerifiedFlags { body })
    }
}

/// Keeps the newest of `kept` and a freshly fetched file. An older or equal
/// `issuedAt` never replaces what is kept; anything that does not verify is
/// ignored (the last verified value stays).
pub fn newest_flags(kept: Option<VerifiedFlags>, fetched: Option<&[u8]>, root: &TrustRoot, now: u64) -> Option<VerifiedFlags> {
    let fresh = fetched.and_then(|b| SignedFlags::from_json(b).ok()).and_then(|f| f.verify(root, now).ok());
    match (kept, fresh) {
        (Some(k), Some(f)) if f.issued_at() > k.issued_at() => Some(f),
        (Some(k), _) => Some(k),
        (None, f) => f,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::tests::{body, key, signed_by, NOW};
    use crate::SignedManifest;

    fn flags(issued_at: u64, off: bool, k: &SigningKey) -> SignedFlags {
        let mut f = SignedFlags::new(&FlagsBody { v: 1, issued_at, member_relay_off: off }).unwrap();
        f.sign(k);
        f
    }

    #[test]
    fn signed_flags_verify_with_the_update_key() {
        let k = key();
        let root = TrustRoot::single(k.verifying_key()).unwrap();
        let v = flags(NOW, true, &k).verify(&root, NOW).unwrap();
        assert!(v.member_relay_off());
        let other = key();
        assert!(matches!(flags(NOW, true, &other).verify(&root, NOW), Err(Error::InsufficientSignatures { .. })));
    }

    #[test]
    fn signatures_do_not_cross_between_flags_and_manifest() {
        let k = key();
        let root = TrustRoot::single(k.verifying_key()).unwrap();
        // A manifest signature presented as flags...
        let m = signed_by(&body("1.0.0"), &[&k]);
        let as_flags = SignedFlags { signed: m.signed.clone(), signatures: m.signatures.clone() };
        assert!(matches!(as_flags.verify(&root, NOW), Err(Error::InsufficientSignatures { .. })));
        // ...and a flags signature presented as a manifest.
        let f = flags(NOW, true, &k);
        let as_manifest = SignedManifest { signed: f.signed.clone(), signatures: f.signatures.clone() };
        assert!(matches!(as_manifest.verify(&root, NOW), Err(Error::InsufficientSignatures { .. })));
        // Same body, re-signed under the manifest context: still not flags.
        let mut sigs = Vec::new();
        add_signature(crate::SIGNING_CONTEXT, &f.signed, &mut sigs, &k);
        let wrong_context = SignedFlags { signed: f.signed.clone(), signatures: sigs };
        assert!(matches!(wrong_context.verify(&root, NOW), Err(Error::InsufficientSignatures { .. })));
    }

    #[test]
    fn newest_issued_at_wins_and_missing_or_bad_keeps_the_last() {
        let k = key();
        let root = TrustRoot::single(k.verifying_key()).unwrap();
        let on = flags(NOW, true, &k).to_json().into_bytes();
        let older_off = flags(NOW - 10, false, &k).to_json().into_bytes();
        let same_off = flags(NOW, false, &k).to_json().into_bytes();
        let newer_off = flags(NOW + 10, false, &k).to_json().into_bytes();

        let kept = newest_flags(None, Some(&on), &root, NOW);
        assert!(kept.unwrap().member_relay_off());
        assert_eq!(newest_flags(kept, Some(&older_off), &root, NOW), kept, "older ignored");
        assert_eq!(newest_flags(kept, Some(&same_off), &root, NOW), kept, "equal ignored");
        assert_eq!(newest_flags(kept, None, &root, NOW), kept, "missing keeps the last");
        assert_eq!(newest_flags(kept, Some(b"{garbage"), &root, NOW), kept, "invalid keeps the last");
        let forged = flags(NOW + 99, false, &key()).to_json().into_bytes();
        assert_eq!(newest_flags(kept, Some(&forged), &root, NOW), kept, "forged keeps the last");
        assert!(!newest_flags(kept, Some(&newer_off), &root, NOW).unwrap().member_relay_off());
        // Nothing ever verified: no value (callers read that as false).
        assert_eq!(newest_flags(None, None, &root, NOW), None);
    }

    #[test]
    fn a_v1_client_verifies_and_ignores_a_flag_it_does_not_know() {
        let k = key();
        let root = TrustRoot::single(k.verifying_key()).unwrap();
        // A later v1 file with an extra (off-only) flag, signed as a whole.
        let mut later = SignedFlags {
            signed: r#"{"v":1,"issuedAt":1800000000,"memberRelayOff":true,"voiceRelayOff":true}"#.into(),
            signatures: vec![],
        };
        later.sign(&k);
        let v = later.verify(&root, NOW).unwrap();
        assert!(v.member_relay_off());
        assert_eq!(v.issued_at(), 1_800_000_000);
        // The extra field is covered by the signature: changing it breaks it.
        let tampered = SignedFlags { signed: later.signed.replace("voiceRelayOff\":true", "voiceRelayOff\":false"), ..later.clone() };
        assert!(matches!(tampered.verify(&root, NOW), Err(Error::InsufficientSignatures { .. })));
        // And it is never kept: only issuedAt and memberRelayOff are.
        let kept = newest_flags(None, Some(later.to_json().as_bytes()), &root, NOW).unwrap();
        assert_eq!(kept, VerifiedFlags::kept(1_800_000_000, true));
    }

    #[test]
    fn far_future_flags_unknown_fields_and_other_formats_are_refused() {
        let k = key();
        let root = TrustRoot::single(k.verifying_key()).unwrap();
        let future = flags(NOW + MAX_CLOCK_SKEW_SECS + 1, true, &k);
        assert!(matches!(future.verify(&root, NOW), Err(Error::IssuedInFuture { .. })));
        // An unknown field in the envelope is still refused.
        let f = flags(NOW, true, &k);
        let mut envelope: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        envelope["extra"] = serde_json::json!(1);
        assert!(SignedFlags::from_json(envelope.to_string().as_bytes()).is_err());
        let mut v2 = SignedFlags { signed: r#"{"v":2,"issuedAt":1,"memberRelayOff":true}"#.into(), signatures: vec![] };
        v2.sign(&k);
        assert!(matches!(v2.verify(&root, NOW), Err(Error::Malformed(_))));
        assert!(SignedFlags::from_json(&vec![b' '; MAX_FLAGS_BYTES + 1]).is_err());
    }
}
