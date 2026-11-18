//! Sign-in by device link, "approve on your other device"
//! (`device-link-slice.md`). This module holds the crypto and the wire
//! format. `service.rs` holds the state machine and the API.
//!
//! - One-time X25519 keys: `e_new` on the new device, `e_old` on the
//!   approving one.
//! - A 6-digit SAS, `derive_key("mvs/device-link-sas/v1", e_new_pub ‖
//!   e_old_pub)`, shown on both screens.
//! - The transfer key, `HKDF-SHA256(X25519(e_old, e_new_pub), info
//!   "mvs/device-link/v1" ‖ e_new_pub ‖ e_old_pub)`.
//! - The account goes as one XChaCha20-Poly1305 box under that key.
//! - The QR and the short code carry no secret. The SAS binds `e_new_pub`.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::ports::DeviceLinkAddr;

/// How long a link lives, from `startDeviceLink`.
pub const LINK_TTL_MS: u64 = 5 * 60_000;
/// SAS attempts per link on the approving device; then the link is dead.
pub const MAX_ATTEMPTS: u32 = 3;
/// The longest QR text, made or accepted (dev-ui #391: printable ASCII).
pub const MAX_QR: usize = 1024;
const QR_PREFIX: &str = "mvs-link:1:";
const SAS_CONTEXT: &str = "mvs/device-link-sas/v1";
const RV_CONTEXT: &str = "mvs/device-link-rv/v1";
const KEY_INFO: &[u8] = b"mvs/device-link/v1";
/// RFC 4648 base32 without padding: 10 characters, 50 bits.
const CODE_LEN: usize = 10;
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// A one-time key pair. The secret is wiped when it's dropped.
pub struct OneTimeKey {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl OneTimeKey {
    pub fn generate() -> OneTimeKey {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret).to_bytes();
        OneTimeKey { secret, public }
    }

    /// The transfer key with the other side's public key. `new_pub` and
    /// `old_pub` are in the spec's order, whichever side calls it. `None`
    /// for a low-order point, where the shared secret would be all zeros.
    pub fn transfer_key(&self, other: &[u8; 32], new_pub: &[u8; 32], old_pub: &[u8; 32]) -> Option<Zeroizing<[u8; 32]>> {
        let shared = self.secret.diffie_hellman(&PublicKey::from(*other));
        if !shared.was_contributory() {
            return None;
        }
        let mut info = KEY_INFO.to_vec();
        info.extend_from_slice(new_pub);
        info.extend_from_slice(old_pub);
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, shared.as_bytes()).expand(&info, key.as_mut()).ok()?;
        Some(key)
    }
}

/// The 6 digits both screens show.
pub fn sas(new_pub: &[u8; 32], old_pub: &[u8; 32]) -> String {
    let mut input = new_pub.to_vec();
    input.extend_from_slice(old_pub);
    let hash = blake3::derive_key(SAS_CONTEXT, &input);
    let n = u32::from_le_bytes(hash[..4].try_into().expect("4 bytes")) % 1_000_000;
    format!("{n:06}")
}

/// A fresh short code: 10 base32 characters, a rendezvous only.
pub fn new_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| BASE32[usize::from(b & 31)] as char).collect()
}

/// Where a code's link is published: `derive_key("mvs/device-link-rv/v1",
/// code)`, on the code as typed but uppercased, without spaces or dashes.
pub fn rendezvous(code: &str) -> Option<[u8; 32]> {
    let code = normalise_code(code)?;
    Some(blake3::derive_key(RV_CONTEXT, code.as_bytes()))
}

fn normalise_code(code: &str) -> Option<String> {
    let code: String = code.chars().filter(|c| !matches!(c, ' ' | '-')).collect::<String>().to_ascii_uppercase();
    (code.len() == CODE_LEN && code.bytes().all(|b| BASE32.contains(&b))).then_some(code)
}

/// The QR: `v1 ‖ e_new_pub ‖ peer ID ‖ circuit address`, as text. The
/// address part is `peer \n circuit` (the port's `DeviceLinkAddr`).
pub fn qr(new_pub: &[u8; 32], addr: &DeviceLinkAddr) -> String {
    let mut bytes = new_pub.to_vec();
    bytes.extend_from_slice(format!("{}\n{}", addr.peer, addr.circuit).as_bytes());
    format!("{QR_PREFIX}{}", bs58::encode(bytes).into_string())
}

/// What `beginDeviceApproval` was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// From a QR: the new device's key and its address.
    Qr { new_pub: [u8; 32], addr: DeviceLinkAddr },
    /// From a typed code: its rendezvous.
    Code { rendezvous: [u8; 32] },
}

impl Target {
    pub fn parse(qr_or_code: &str) -> Option<Target> {
        let text = qr_or_code.trim();
        if let Some(data) = text.strip_prefix(QR_PREFIX) {
            if text.len() > MAX_QR {
                return None;
            }
            let bytes = bs58::decode(data).into_vec().ok()?;
            let new_pub: [u8; 32] = bytes.get(..32)?.try_into().ok()?;
            let rest = std::str::from_utf8(&bytes[32..]).ok()?;
            let (peer, circuit) = rest.split_once('\n')?;
            if peer.is_empty() || circuit.is_empty() {
                return None;
            }
            let addr = DeviceLinkAddr { peer: peer.to_owned(), circuit: circuit.to_owned() };
            return Some(Target::Qr { new_pub, addr });
        }
        rendezvous(text).map(|rendezvous| Target::Code { rendezvous })
    }

    /// The same link, for counting attempts: the QR's key or the code's
    /// rendezvous.
    pub fn link_id(&self) -> [u8; 32] {
        match self {
            Target::Qr { new_pub, .. } => *new_pub,
            Target::Code { rendezvous } => *rendezvous,
        }
    }
}

/// What travels over the link, in the box.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    /// The 12 recovery words, space-separated.
    #[serde(with = "secret_string")]
    pub seed: Zeroizing<String>,
    pub profile: PayloadProfile,
    pub birth_date: String,
    pub birth_date_trusted: bool,
    pub country: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadProfile {
    pub display_name: String,
    #[serde(default)]
    pub avatar_small: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// The seed as a `Zeroizing<String>` in JSON: a plain string on the wire,
/// wiped from memory when the payload is dropped (Security Lead on #407).
/// Deserialising moves the parsed `String` into the wrapper (no copy).
pub(crate) mod secret_string {
    use serde::{Deserialize, Deserializer, Serializer};
    use zeroize::Zeroizing;

    pub fn serialize<S: Serializer>(value: &Zeroizing<String>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(value.as_str())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Zeroizing<String>, D::Error> {
        String::deserialize(d).map(Zeroizing::new)
    }
}

/// Seals `payload` under `key`: a random 24-byte nonce, then the box.
pub fn seal(key: &[u8; 32], payload: &Payload) -> Vec<u8> {
    let plain = Zeroizing::new(serde_json::to_vec(payload).expect("plain struct"));
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), plain.as_slice())
        .expect("in-memory encryption");
    let mut out = nonce.to_vec();
    out.extend(sealed);
    out
}

/// Opens what [`seal`] made. `None` if it was tampered with or the key is wrong.
pub fn open(key: &[u8; 32], sealed: &[u8]) -> Option<Payload> {
    if sealed.len() < 24 {
        return None;
    }
    let (nonce, body) = sealed.split_at(24);
    let plain = Zeroizing::new(XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), body).ok()?);
    serde_json::from_slice(&plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Payload {
        Payload {
            seed: Zeroizing::new("legal winner thank year wave sausage worth useful legal winner thank yellow".into()),
            profile: PayloadProfile { display_name: "Me".into(), avatar_small: None, color: Some("#123456".into()) },
            birth_date: "1990-05-01".into(),
            birth_date_trusted: true,
            country: "IL".into(),
        }
    }

    #[test]
    fn both_sides_get_the_same_key_and_digits() {
        let (new, old) = (OneTimeKey::generate(), OneTimeKey::generate());
        let k_new = new.transfer_key(&old.public, &new.public, &old.public).unwrap();
        let k_old = old.transfer_key(&new.public, &new.public, &old.public).unwrap();
        assert_eq!(*k_new, *k_old);
        let digits = sas(&new.public, &old.public);
        assert_eq!(digits.len(), 6);
        assert!(digits.bytes().all(|b| b.is_ascii_digit()));
        // A man in the middle has his own key: other digits (almost surely).
        let mitm = OneTimeKey::generate();
        assert_ne!(sas(&mitm.public, &old.public), digits);
        // A low-order point gives no key.
        assert!(old.transfer_key(&[0; 32], &[0; 32], &old.public).is_none());
    }

    /// Security Lead on #407: the received words are a `Zeroizing<String>`,
    /// so they are wiped when the payload drops (this fails to compile if
    /// the type ever goes back to a plain `String`).
    #[test]
    fn the_seed_is_wiped_on_drop() {
        fn seed(p: &Payload) -> &Zeroizing<String> {
            &p.seed
        }
        let p = payload();
        assert!(seed(&p).starts_with("legal"));
        let key = [3u8; 32];
        let back = open(&key, &seal(&key, &p)).unwrap();
        assert_eq!(back.seed.as_str(), p.seed.as_str(), "the same words over the wire");
    }

    #[test]
    fn the_box_opens_only_with_its_key_and_untouched() {
        let key = [7u8; 32];
        let sealed = seal(&key, &payload());
        let opened = open(&key, &sealed).unwrap();
        assert_eq!(opened.birth_date, "1990-05-01");
        assert!(opened.birth_date_trusted);
        assert!(open(&[8u8; 32], &sealed).is_none(), "wrong key");
        let mut bent = sealed.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert!(open(&key, &bent).is_none(), "tampered");
    }

    #[test]
    fn codes_qrs_and_messages_round_trip() {
        let code = new_code();
        assert_eq!(code.len(), 10);
        let spaced = format!("{}-{} ", &code[..5], code[5..].to_lowercase());
        assert_eq!(rendezvous(&spaced), rendezvous(&code));
        assert_eq!(Target::parse(&code), Some(Target::Code { rendezvous: rendezvous(&code).unwrap() }));
        assert!(Target::parse("ABC").is_none() && Target::parse("ABCDEFGHI1").is_none());
        let key = OneTimeKey::generate();
        let addr = DeviceLinkAddr { peer: "12D3KooW".into(), circuit: "/dns4/relay/tcp/4001/p2p/R/p2p-circuit/p2p/12D3KooW".into() };
        assert_eq!(Target::parse(&qr(&key.public, &addr)), Some(Target::Qr { new_pub: key.public, addr }));
        assert!(Target::parse("mvs-link:1:2NEpo7").is_none(), "too short");
    }
}
