#!/bin/bash
# Packaged Linux app smoke, in Docker: the release's .deb (installed with apt,
# so its declared dependencies must resolve) and its AppImage (extracted, no
# FUSE), each started under Xvfb in a throwaway container with a test keyring
# and NO network (a packaged build's default relay is the live one, which
# tests never touch). The packaged shell refuses debugger flags, so Playwright
# cannot drive it; this checks what can be seen from outside: the main window
# opens, mvs-core starts and stays up, and the app writes its profile. The
# flows themselves run on the same release's core and UI in qa/join-matrix and
# qa/voice-e2e.
#
#   ASSETS=<folder with the release's .deb, .AppImage and SHA256SUMS> bash qa/packaged/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*) export MSYS_NO_PATHCONV=1; mount() { (cd "$1" && pwd -W); };; *) mount() { (cd "$1" && pwd); };; esac
ASSETS="$(cd "${ASSETS:?set ASSETS to the downloaded release assets}" && pwd)"
deb=$(cd "$ASSETS" && ls *.deb | head -1)
img=$(cd "$ASSETS" && ls *.AppImage | head -1)
(cd "$ASSETS" && grep -E " ($deb|$img)\$" SHA256SUMS | sha256sum -c -)

ctx="$here/.build/ctx"
rm -rf "$ctx" && mkdir -p "$ctx"
cp "$ASSETS/$deb" "$ctx/app.deb"
docker build -q -t mvs-voice-e2e-app -f "$(mount "$repo/desktop")/Dockerfile.e2e" "$(mount "$repo/desktop")" >/dev/null
docker build -q -t mvs-qa-deb "$(mount "$ctx")" -f - >/dev/null <<'EOF'
FROM mvs-voice-e2e-app
COPY app.deb /tmp/app.deb
RUN apt-get update && apt-get install -y --no-install-recommends x11-utils procps /tmp/app.deb && rm -rf /var/lib/apt/lists/* /tmp/app.deb
EOF
rm -rf "$ctx"
fail=0
for kind in deb appimage; do
  echo "== $kind"
  docker run --rm --network none -v "$(mount "$ASSETS"):/assets:ro" -v "$(mount "$here"):/qa:ro" \
    -e KIND=$kind -e IMG="$img" mvs-qa-deb sh /qa/inner.sh || fail=1
done
exit $fail
