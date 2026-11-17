#!/usr/bin/env bash
# Proves core/vendor/libp2p-dns is the crates.io libp2p-dns 0.45.0 package,
# changed only as listed in core/vendor/libp2p-dns/README.md:
#   - Cargo.toml: version 0.45.0 -> 0.44.0, libp2p-core 0.44.0 -> 0.43.1,
#     libp2p-identity 0.3.0 -> 0.2.12, [dev-dependencies*] removed
#     (rebuilt here from the upstream file and compared byte for byte);
#   - Cargo.lock and Cargo.toml.orig not vendored;
#   - README.md and LICENSE added by us.
# Every other file (src/**, CHANGELOG.md, .cargo_vcs_info.json) must be
# byte-identical. Run from the repository root; needs curl, tar, sha256sum.
set -euo pipefail

CRATE_URL="https://static.crates.io/crates/libp2p-dns/libp2p-dns-0.45.0.crate"
CRATE_SHA256="18694695e98ff9ce26ee245fdede7cd0b4186cb793b25da3258d9c053400a291" # crates.io index checksum
VENDOR="core/vendor/libp2p-dns"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' -o "$work/dns.crate" "$CRATE_URL"
echo "$CRATE_SHA256  $work/dns.crate" | sha256sum -c --quiet -
tar -xzf "$work/dns.crate" -C "$work"
up="$work/libp2p-dns-0.45.0"

# The same edits README.md lists, applied to the upstream Cargo.toml.
sed 's/^version = "0.45.0"/version = "0.44.0"/' "$up/Cargo.toml" | awk '
/^\[dependencies.libp2p-core\]/ {print; getline; print "version = \"0.43.1\""; next}
/^\[dependencies.libp2p-identity\]/ {print; getline; print "version = \"0.2.12\""; next}
/^\[dev-dependencies/ {skip=1}
/^\[lints/ {skip=0}
!skip {print}' > "$work/expected-Cargo.toml"

fail=0
cmp -s "$work/expected-Cargo.toml" "$VENDOR/Cargo.toml" || { echo "::error::$VENDOR/Cargo.toml differs beyond the listed edits"; diff "$work/expected-Cargo.toml" "$VENDOR/Cargo.toml" || true; fail=1; }

# Same file set: upstream minus the two dropped files, plus our two.
expected_files=$( (cd "$up" && find . -type f ! -name Cargo.lock ! -name Cargo.toml.orig; echo ./README.md; echo ./LICENSE) | sort)
actual_files=$(cd "$VENDOR" && find . -type f | sort)
if [ "$expected_files" != "$actual_files" ]; then
  echo "::error::$VENDOR has a different file set from the crate"; diff <(echo "$expected_files") <(echo "$actual_files") || true; fail=1
fi

# Every upstream file except Cargo.toml: byte-identical.
while IFS= read -r f; do
  case "$f" in ./Cargo.toml|./Cargo.lock|./Cargo.toml.orig) continue ;; esac
  cmp -s "$up/$f" "$VENDOR/$f" || { echo "::error::$VENDOR/${f#./} is not the crates.io file"; fail=1; }
done < <(cd "$up" && find . -type f | sort)

[ "$fail" = 0 ] && echo "ok: $VENDOR is libp2p-dns 0.45.0 (sha256 $CRATE_SHA256) with only the listed changes"
exit "$fail"
