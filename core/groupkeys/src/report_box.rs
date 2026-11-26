//! G-48: a box sealed to one member, for a report to a server's staff.
//!
//! The same primitives as rotation wraps, with no new crate: the recipient's
//! X25519 key derived from their Ed25519 identity ([`x25519_public`]), one
//! fresh ephemeral X25519 key per box, BLAKE3 `derive_key`, and
//! XChaCha20-Poly1305 with a random nonce. The shared secret of a
//! small-order point (all zero) is refused both ways.
//!
//! ```text
//! ver        u8         BOX_VERSION
//! ephemeral  [u8; 32]   X25519 public key
//! nonce      [u8; 24]
//! sealed     plaintext + 16-byte tag
//! ```
//!
//! Associated data: `"mvs/report-box/v1" ‖ ephemeral ‖ recipient ‖ server`
//! (the security lead's R3), so a box opens only for its recipient and its
//! server. The key is `derive_key(BOX_KDF, shared ‖ ephemeral ‖ recipient ‖
//! server)`.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand_core::{CryptoRng, RngCore};
use records::{PublicKey, ServerId};
use zeroize::Zeroizing;

use crate::{diffie_hellman, x25519_public, Error, MemberSecret, NONCE_LEN, TAG_LEN};

/// Format version of a box.
pub const BOX_VERSION: u8 = 1;
/// Bytes a box adds to its plaintext.
pub const BOX_OVERHEAD: usize = 1 + 32 + NONCE_LEN + TAG_LEN;

// Domain separation strings. Never reuse one for another purpose.
const BOX_AD: &[u8] = b"mvs/report-box/v1";
const BOX_KDF: &str = "mvs/report-box v1 2026-11 key";

fn box_ad(ephemeral: &MontgomeryPoint, recipient: &PublicKey, server: ServerId) -> Vec<u8> {
    [BOX_AD, ephemeral.as_bytes(), recipient.as_bytes(), server.as_bytes()].concat()
}

fn box_cipher(
    shared: &[u8; 32],
    ephemeral: &MontgomeryPoint,
    recipient: &PublicKey,
    server: ServerId,
) -> XChaCha20Poly1305 {
    let mut material = Zeroizing::new(Vec::with_capacity(4 * 32));
    material.extend_from_slice(shared);
    material.extend_from_slice(ephemeral.as_bytes());
    material.extend_from_slice(recipient.as_bytes());
    material.extend_from_slice(server.as_bytes());
    let key = Zeroizing::new(blake3::derive_key(BOX_KDF, &material));
    XChaCha20Poly1305::new(key.as_ref().into())
}

/// Seals `plaintext` so that only `recipient` opens it, and only as a box of
/// `server`.
pub fn seal_box(
    server: ServerId,
    recipient: &PublicKey,
    plaintext: &[u8],
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<Vec<u8>, Error> {
    let point = x25519_public(recipient)?;
    let mut ephemeral_secret = Zeroizing::new([0; 32]);
    rng.fill_bytes(ephemeral_secret.as_mut());
    let ephemeral = MontgomeryPoint::mul_base_clamped(*ephemeral_secret);
    let shared = diffie_hellman(point, &ephemeral_secret).ok_or(Error::BadMemberKey(*recipient))?;
    let mut nonce = [0; NONCE_LEN];
    rng.fill_bytes(&mut nonce);
    let ad = box_ad(&ephemeral, recipient, server);
    let sealed = box_cipher(&shared, &ephemeral, recipient, server)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &ad })
        .expect("XChaCha20-Poly1305 encryption of a bounded box can't fail");
    let mut out = Vec::with_capacity(BOX_OVERHEAD + plaintext.len());
    out.push(BOX_VERSION);
    out.extend_from_slice(ephemeral.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

impl MemberSecret {
    /// Opens a box [`seal_box`] made for this member in `server`.
    pub fn open_box(&self, server: ServerId, sealed: &[u8]) -> Result<Vec<u8>, Error> {
        let (&version, rest) = sealed.split_first().ok_or(Error::Truncated)?;
        if version != BOX_VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        let (ephemeral, rest) = rest.split_first_chunk::<32>().ok_or(Error::Truncated)?;
        let (nonce, ciphertext) = rest.split_first_chunk::<NONCE_LEN>().ok_or(Error::Truncated)?;
        if ciphertext.len() < TAG_LEN {
            return Err(Error::Truncated);
        }
        let ephemeral = MontgomeryPoint(*ephemeral);
        let shared = diffie_hellman(ephemeral, &self.secret).ok_or(Error::BadEphemeralKey)?;
        let ad = box_ad(&ephemeral, &self.public, server);
        box_cipher(&shared, &ephemeral, &self.public, server)
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: &ad })
            .map_err(|_| Error::UnwrapFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand_chacha::rand_core::SeedableRng as _;

    struct Rng(rand_chacha::ChaCha20Rng);
    impl rand_core::RngCore for Rng {
        fn next_u32(&mut self) -> u32 {
            rand_chacha::rand_core::RngCore::next_u32(&mut self.0)
        }
        fn next_u64(&mut self) -> u64 {
            rand_chacha::rand_core::RngCore::next_u64(&mut self.0)
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            rand_chacha::rand_core::RngCore::fill_bytes(&mut self.0, dest)
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }
    impl rand_core::CryptoRng for Rng {}

    fn rng() -> Rng {
        Rng(rand_chacha::ChaCha20Rng::seed_from_u64(48))
    }

    fn member(seed: u8) -> (SigningKey, MemberSecret, PublicKey) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let secret = MemberSecret::new(&key);
        let public = secret.public();
        (key, secret, public)
    }

    const SERVER: ServerId = ServerId::from_bytes([3; 32]);

    #[test]
    fn a_box_opens_only_for_its_recipient_and_server() {
        let (_, alice, alice_key) = member(1);
        let (_, bob, _) = member(2);
        let sealed = seal_box(SERVER, &alice_key, b"a report", &mut rng()).unwrap();
        assert_eq!(sealed.len(), BOX_OVERHEAD + 8);
        assert_eq!(alice.open_box(SERVER, &sealed).unwrap(), b"a report");
        assert_eq!(bob.open_box(SERVER, &sealed), Err(Error::UnwrapFailed), "not for bob");
        let other = ServerId::from_bytes([4; 32]);
        assert_eq!(alice.open_box(other, &sealed), Err(Error::UnwrapFailed), "another server");
    }

    #[test]
    fn tampering_or_truncation_is_refused() {
        let (_, alice, alice_key) = member(1);
        let sealed = seal_box(SERVER, &alice_key, b"a report", &mut rng()).unwrap();
        for i in 0..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert!(alice.open_box(SERVER, &bad).is_err(), "byte {i}");
        }
        for len in 0..BOX_OVERHEAD {
            assert!(alice.open_box(SERVER, &sealed[..len]).is_err(), "len {len}");
        }
        // A small-order ephemeral key (the all-zero point) gives an all-zero
        // shared secret: refused before any decryption.
        let mut zero = sealed.clone();
        zero[1..33].fill(0);
        assert_eq!(alice.open_box(SERVER, &zero), Err(Error::BadEphemeralKey));
    }

    #[test]
    fn boxes_of_one_length_have_one_size_and_never_repeat() {
        let (_, _, alice_key) = member(1);
        let (_, _, bob_key) = member(2);
        let mut rng = rng();
        let a = seal_box(SERVER, &alice_key, &[0; 100], &mut rng).unwrap();
        let b = seal_box(SERVER, &bob_key, &[1; 100], &mut rng).unwrap();
        let c = seal_box(SERVER, &alice_key, &[0; 100], &mut rng).unwrap();
        assert_eq!(a.len(), b.len());
        assert_ne!(a, c, "a fresh ephemeral key and nonce every time");
    }
}
