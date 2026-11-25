//! T17: the server secret rotation's boxes (Security Lead S1). They reuse the
//! key rotation's parts and assembly, under strings of their own, so a box
//! never opens in the other domain.

mod common;

use common::{members, pk, rng, secret, CHANNEL, SERVER};
use groupkeys::{Error, Part, Rotation, WRAPS_PER_PART};
use records::RecordId;

fn assemble_secret(rotator: u8, bodies: &[Vec<u8>]) -> Result<Rotation, Error> {
    let parts = bodies
        .iter()
        .map(|b| Part::decode_secret(SERVER, pk(rotator), b))
        .collect::<Result<Vec<_>, _>>()?;
    Rotation::assemble(SERVER, parts)
}

#[test]
fn every_recipient_opens_the_same_secret_and_nobody_else_does() {
    let readers = members(&[1, 2, 3]);
    let (bodies, sent) =
        Rotation::create_secret(SERVER, pk(1), 0, None, &readers, &mut rng(1)).unwrap();
    assert_eq!(bodies.len(), 1);
    let rotation = assemble_secret(1, &bodies).unwrap();
    assert!(rotation.is_secret());
    for n in [1, 2, 3] {
        let got = rotation.unwrap_secret(&secret(n)).unwrap();
        assert_eq!(got.as_bytes(), sent.as_bytes());
    }
    assert_eq!(rotation.unwrap_secret(&secret(9)).unwrap_err(), Error::NoKey);
    // Never a channel key.
    assert!(matches!(rotation.unwrap_key(&secret(1)), Err(Error::WrongChannel)));
    // Never printed.
    assert_eq!(format!("{sent:?}"), "SyncSecret(..)");

    // The next one names it, and draws a new secret.
    let (next, again) = Rotation::create_secret(
        SERVER,
        pk(2),
        1,
        Some(rotation.id()),
        &members(&[1, 2]),
        &mut rng(2),
    )
    .unwrap();
    let next = assemble_secret(2, &next).unwrap();
    assert_eq!((next.epoch(), next.prev()), (1, Some(rotation.id())));
    assert_ne!(again.as_bytes(), sent.as_bytes());
    assert_eq!(next.unwrap_secret(&secret(3)).unwrap_err(), Error::NoKey, "removed");
}

/// S1: a channel `KeyRotation` box replayed as a `SecretRotation` one (and
/// the other way round) is refused.
#[test]
fn a_box_never_crosses_domains() {
    let readers = members(&[1, 2]);
    let (channel_bodies, _) =
        Rotation::create(SERVER, pk(1), CHANNEL, 0, None, &readers, &mut rng(3)).unwrap();
    let (secret_bodies, _) =
        Rotation::create_secret(SERVER, pk(1), 0, None, &readers, &mut rng(3)).unwrap();
    assert_eq!(
        Part::decode_secret(SERVER, pk(1), &channel_bodies[0]).unwrap_err(),
        Error::RotationIdMismatch
    );
    assert_eq!(
        Part::decode(SERVER, pk(1), &secret_bodies[0]).unwrap_err(),
        Error::RotationIdMismatch
    );
    // The same randomness gives different rotation IDs per domain.
    assert_ne!(channel_bodies[0][..32], secret_bodies[0][..32]);
    // The channel rotation, opened as a channel rotation, refuses the
    // secret call.
    let channel = Rotation::decode(SERVER, pk(1), &channel_bodies[0]).unwrap();
    assert!(!channel.is_secret());
    assert!(matches!(channel.unwrap_secret(&secret(1)), Err(Error::WrongChannel)));
}

/// SL on #592: parts are grouped as for key rotations: same rotator and
/// count, one per index, complete only.
#[test]
fn parts_assemble_only_complete_and_from_one_rotator() {
    let many: Vec<u8> = (1..=u8::try_from(WRAPS_PER_PART + 5).unwrap()).collect();
    let readers = members(&many);
    let (bodies, sent) =
        Rotation::create_secret(SERVER, pk(1), 0, None, &readers, &mut rng(4)).unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(assemble_secret(1, &bodies[..1]).unwrap_err(), Error::MissingParts);
    let twice = [bodies[0].clone(), bodies[0].clone()];
    assert!(assemble_secret(1, &twice).is_err());
    let reversed = [bodies[1].clone(), bodies[0].clone()];
    let rotation = assemble_secret(1, &reversed).unwrap();
    let last = *many.last().unwrap();
    assert_eq!(rotation.unwrap_secret(&secret(last)).unwrap().as_bytes(), sent.as_bytes());
    // A part claimed by someone else than its rotator doesn't decode.
    assert_eq!(
        Part::decode_secret(SERVER, pk(2), &bodies[0]).unwrap_err(),
        Error::RotationIdMismatch
    );
    // Nor in another server.
    let other = records::ServerId::from_bytes([1; 32]);
    assert_eq!(
        Part::decode_secret(other, pk(1), &bodies[0]).unwrap_err(),
        Error::RotationIdMismatch
    );
}

#[test]
fn epoch_and_prev_must_agree() {
    let readers = members(&[1]);
    let prev = RecordId::from_bytes([3; 32]);
    assert_eq!(
        Rotation::create_secret(SERVER, pk(1), 0, Some(prev), &readers, &mut rng(5)).unwrap_err(),
        Error::BadEpochLink
    );
    assert_eq!(
        Rotation::create_secret(SERVER, pk(1), 1, None, &readers, &mut rng(5)).unwrap_err(),
        Error::BadEpochLink
    );
}
