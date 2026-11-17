# libp2p-dns (vendored, patched)

This is the source of **libp2p-dns 0.45.0** from crates.io (rust-libp2p,
MIT License, Copyright Parity Technologies and the rust-libp2p
contributors). Its `Cargo.toml` is changed so that it builds as
**0.44.0** against libp2p 0.56's `libp2p-core 0.43` and
`libp2p-identity 0.2`. `src/` is the 0.45.0 code, unchanged.
`core/Cargo.toml` uses it through `[patch.crates-io]`.

## Why

- libp2p-dns 0.44, which libp2p 0.56 uses, pins **hickory-resolver/proto
  0.25**. That version has advisories that peer-advertised DNS names could
  reach: name-compression CPU use, SVCB and zone parsing panics, and
  header-count memory amplification. The notes file `hickory-advisories.md`
  has the details.
- 0.45 moves to **hickory 0.26**, which has the fixes. Its source changes
  are only hickory's API.
- The upstream route is libp2p 0.57. Its `libp2p-identity 0.3` would
  duplicate every Ed25519/X25519 crate we depend on (ed25519-dalek 2/3,
  curve25519-dalek 4/5, x25519-dalek, signature). We don't ship duplicate
  crypto crates.

## Changes from the crates.io 0.45.0 package

- `version = "0.44.0"`;
- `libp2p-core = "0.43.1"`, `libp2p-identity = "0.2.12"`;
- the dev-dependencies removed, since its tests are not built here;
- `Cargo.lock` and `Cargo.toml.orig` dropped.

## Remove it

Remove this folder, and the `[patch.crates-io]` entry in `core/Cargo.toml`,
with the libp2p 0.57 upgrade. That upgrade moves our own crates to
ed25519-dalek 3 / curve25519-dalek 5 at the same time.
