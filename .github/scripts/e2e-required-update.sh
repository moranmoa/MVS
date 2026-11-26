#!/usr/bin/env bash
# End to end, the required-update chain as a release makes it, with a
# THROWAWAY test key (never root.key):
#   updater keygen/make-root -> manifest-body.mjs --require-from ->
#   updater sign-manifest -> the core reads that signed manifest (api test
#   `required_update_end_to_end`, ignored unless the files below are given).
# Run from the repo root (CI: the core tests job). Needs node and cargo.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
updater() { cargo run --quiet --locked --manifest-path core/Cargo.toml -p updater --bin updater -- "$@"; }

# 1. A test root of one throwaway key.
mkdir -p "$work/keys"
updater keygen --out "$work/keys" --name e2e >/dev/null
updater make-root --threshold 1 --pub "$work/keys/e2e.pub" --out "$work/root.json" >/dev/null

# 2. A 1.1.0 release for the test platform, required for everything below it
#    (published: 1.0.0, the version the test core runs).
mkdir -p "$work/dist"
printf "not a real app" >"$work/app"
tar -czf "$work/dist/mvs-1.1.0-linux-x86_64.tar.gz" -C "$work" app
node .github/scripts/manifest-body.mjs --version 1.1.0 --platforms linux-x86_64 \
  --dir "$work/dist" --channel alpha --days 7 \
  --require-from 1.1.0 --published "1.0.0" --out "$work/body.json"
grep -q '"1.0.0"' "$work/body.json" || { echo "::error::--require-from did not revoke 1.0.0"; exit 1; }

# 3. Signed with the test key.
updater sign-manifest --key "$work/keys/e2e.key" --body "$work/body.json" --out "$work/manifest.json" >/dev/null
updater verify --manifest "$work/manifest.json" --root "$work/root.json" >/dev/null

# 4. The core takes it: required, quiet (RU1), kept across a restart,
#    cleared by the newer version.
MVS_E2E_MANIFEST="$work/manifest.json" MVS_E2E_ROOT="$work/root.json" \
  cargo test --release --locked --manifest-path core/Cargo.toml -p api --test update \
  required_update_end_to_end -- --ignored --exact
echo "ok: the required-update chain, end to end"
