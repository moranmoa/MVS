#!/bin/bash
# Member relays off on a metered connection (#403), the Linux path, in Docker:
# a privileged container runs NetworkManager on its own system bus with a
# dummy connection and no other network. The check flips that connection's
# connection.metered with nmcli and asks the shell's own checkMetered()
# (desktop/src/metered.js, via gdbus), then hands the answer to a real
# mvs-core with setMetered, as desktop/src/main.js does, and reads
# getMemberRelay.
#
#   CORE=<path to a Linux mvs-core> bash qa/metered/run.sh
#   DESKTOP_SRC=<a desktop/src with metered.js> (default: this checkout's)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*) export MSYS_NO_PATHCONV=1; mount() { (cd "$1" && pwd -W); };; *) mount() { (cd "$1" && pwd); };; esac
CORE=${CORE:?set CORE to a Linux mvs-core}
src="$(cd "${DESKTOP_SRC:-$repo/desktop/src}" && pwd)"
[ -f "$src/metered.js" ] || { echo "no metered.js in $src"; exit 1; }
work="$here/.build/run-$(date +%s)"
mkdir -p "$work"
cp "$CORE" "$work/mvs-core"

docker build -q -t mvs-voice-e2e-app -f "$(mount "$repo/desktop")/Dockerfile.e2e" "$(mount "$repo/desktop")" >/dev/null
docker build -q -t mvs-qa-nm - >/dev/null <<'EOF'
FROM mvs-voice-e2e-app
RUN apt-get update && apt-get install -y --no-install-recommends network-manager libglib2.0-bin iproute2 && rm -rf /var/lib/apt/lists/*
EOF
docker run --rm --privileged --network none \
  -v "$(mount "$work"):/core:ro" -v "$(mount "$src"):/desktop-src:ro" -v "$(mount "$here"):/qa:ro" \
  mvs-qa-nm sh /qa/inner.sh
