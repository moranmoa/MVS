# libp2p-gossipsub (vendored, with a security fix)

This is the crates.io **libp2p-gossipsub 0.49.5** package (rust-libp2p,
MIT License, Copyright Parity Technologies and the rust-libp2p contributors),
with **one** upstream change applied: `upstream-9c64782-prune-unknown-topics.patch`.
`core/Cargo.toml` uses it through `[patch.crates-io]`, version unchanged
(0.49.5).

## Why

RUSTSEC-2026-0534 (GHSA-vrx6-jcp8-vm7m): a PRUNE control message records a
backoff for every topic it names, including topics we never joined. Any
peer with a gossipsub stream can make our memory grow without bound for up
to an hour per entry, even after it disconnects, and peer scoring doesn't
penalise it.

The fix (upstream commit 9c64782) ignores PRUNE entries for topics that
are not in our mesh. It's 9 lines in `src/behaviour.rs`.

Upstream only ships it in **0.50.1**, which needs libp2p 0.57 and
libp2p-core 0.44. That upgrade brings `libp2p-identity 0.3`, which would
duplicate every Ed25519/X25519 crate we use (see
`../libp2p-dns/README.md`).

## Changes from the crates.io 0.49.5 package

- `src/behaviour.rs`: the patch above, applied as is (offset -154 lines);
- `Cargo.lock` and `Cargo.toml.orig` not vendored;
- `README.md`, `LICENSE` and the `.patch` file added by us.

Every other file, `Cargo.toml` included, is byte-identical.
`.github/scripts/check-vendored-libp2p-gossipsub.sh`, which runs in CI,
proves it:
- it downloads the crate and checks its sha256 against the crates.io index;
- it applies the patch;
- it compares every file and the file set.

## Remove it

Remove this folder and its `[patch.crates-io]` line with the libp2p 0.57
upgrade, together with `../libp2p-dns`.

Until then, cargo-deny can't see this path crate's advisories.
`.github/scripts/check-vendored-advisories.py` (CI, advisories job) checks
RustSec for `libp2p-gossipsub` 0.49.5 instead, with RUSTSEC-2026-0534
accepted as fixed by the patch. Remove it with this folder.

Any change to the `.patch` file needs a review against upstream: the CI
check trusts it.
