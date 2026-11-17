#!/usr/bin/env bash
# Proves core/vendor/libp2p-gossipsub is the crates.io libp2p-gossipsub
# 0.49.5 package with exactly one change: upstream commit 9c64782's fix for
# RUSTSEC-2026-0534, kept beside it as a .patch file. Also not vendored:
# Cargo.lock and Cargo.toml.orig; added: README.md, LICENSE and the .patch.
# Every other file (Cargo.toml, src/**, tests/**, CHANGELOG.md,
# .cargo_vcs_info.json) must match byte for byte. Run from the repository
# root; needs curl, tar, sha256sum, patch.
set -euo pipefail

CRATE_URL="https://static.crates.io/crates/libp2p-gossipsub/libp2p-gossipsub-0.49.5.crate"
CRATE_SHA256="3573f3d8e30bd62cda336df5c7c1041a1caa40a648376b8e1e274d585c0ed25c" # crates.io index checksum
VENDOR="core/vendor/libp2p-gossipsub"
PATCH="upstream-9c64782-prune-unknown-topics.patch"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' -o "$work/g.crate" "$CRATE_URL"
echo "$CRATE_SHA256  $work/g.crate" | sha256sum -c --quiet -
tar -xzf "$work/g.crate" -C "$work"
up="$work/libp2p-gossipsub-0.49.5"
rm -f "$up/Cargo.lock" "$up/Cargo.toml.orig"
# The one allowed source change, applied to the pristine crate.
(cd "$up" && patch -s -p1 --no-backup-if-mismatch < "$OLDPWD/$VENDOR/$PATCH")
cp "$VENDOR/README.md" "$VENDOR/LICENSE" "$VENDOR/$PATCH" "$up/"

if diff -r "$up" "$VENDOR" > "$work/diff.txt"; then
  echo "ok: $VENDOR is libp2p-gossipsub 0.49.5 (sha256 $CRATE_SHA256) plus only $PATCH"
else
  echo "::error::$VENDOR differs from the crates.io 0.49.5 package plus $PATCH"
  cat "$work/diff.txt"
  exit 1
fi
