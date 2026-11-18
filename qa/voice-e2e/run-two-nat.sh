#!/bin/bash
# G-81: a real voice call between two homes, each behind its own NAT, with
# only our STUN server (no TURN), all in Docker. See compose.two-nat.yaml for
# the topology; call.mjs (unchanged) drives both apps.
#
#   bash qa/voice-e2e/run-two-nat.sh             # one run, the direct scenario
#   RUNS=20 bash qa/voice-e2e/run-two-nat.sh     # N-STUN-1: p95 setup over 20 runs
#                                                #   (only on a quiet host: QA's rule)
#   SCENARIO=blocked bash ...                    # N-STUN-2: UDP between the homes dropped
#   SCENARIO=nostun bash ...                     # N-STUN-3: no STUN server
#   REBUILD=1 / KEEP=1 / SRC=<dir>               # as in run.sh
#
# The networks are Docker-internal: nothing reaches the host's LAN, the
# internet or the live relay. Results: qa/voice-e2e/results/<project>/;
# PASS/FAIL lines carry candidate types and times only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*) export MSYS_NO_PATHCONV=1; mount() { (cd "$1" && pwd -W); };; *) mount() { (cd "$1" && pwd); };; esac
src="$(cd "${SRC:-$repo}" && pwd)"
build="$here/.build"
SCENARIO="${SCENARIO:-direct}"
RUNS="${RUNS:-1}"
case "$SCENARIO" in direct|blocked|nostun) ;; *) echo "SCENARIO must be direct, blocked or nostun"; exit 2;; esac
mkdir -p "$build"

# 1-3. mvs-core, the UI and the relay image, as run.sh builds them (the UI
# with this e2e's own node_modules volume, so it never races run.sh).
if [ -n "${REBUILD:-}" ] || [ ! -f "$build/mvs-core" ]; then
  echo "== building mvs-core"
  docker run --rm -v "$(mount "$src/core"):/work:ro" -v "$(mount "$build"):/out" \
    -v cargo-registry:/usr/local/cargo/registry -v mvs-voice-e2e-core-target:/target -e CARGO_TARGET_DIR=/target \
    -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" -w /work rust:1.90-bookworm \
    sh -c 'cargo build --release --locked -p api --bin mvs-core && cp /target/release/mvs-core /out/'
fi
if [ -n "${REBUILD:-}" ] || [ ! -f "$build/ui/index.html" ]; then
  echo "== building the UI"
  docker run --rm -v "$(mount "$src/ui"):/app" -v mvs-voice-e2e-nat-ui-nm:/app/node_modules -v "$(mount "$build"):/out" \
    -w /app node:22.23.4-bookworm \
    sh -c 'npm ci --no-audit --no-fund >/dev/null && npx vite build --outDir /out/ui --emptyOutDir --logLevel warn'
fi
echo "== building the relay, router and app images"
docker build -q -t mvs-relay:voice-e2e --build-arg CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" "$(mount "$repo/infra/relay")" >/dev/null

export DEPS_KEY="$(sha256sum "$repo/desktop/package-lock.json" | cut -c1-12)"
docker volume create "mvs-voice-e2e-nat-desktop-nm-$DEPS_KEY" >/dev/null
docker volume create mvs-voice-e2e-nat-deps-lock >/dev/null
export BLOCK_PEER_UDP=""
[ "$SCENARIO" = blocked ] && BLOCK_PEER_UDP=1

dirs=()
status=0
for n in $(seq "$RUNS"); do
  P="mvs-voice-nat-$(date +%s)-$RANDOM"
  out="$here/results/$P"
  mkdir -p "$out"
  dirs+=("$out")
  dc() { docker compose -p "$P" -f "$(mount "$here")/compose.two-nat.yaml" "$@"; }
  [ "$n" = 1 ] && { dc build -q nat-a a; dc run --rm --no-deps deps; }

  echo "== run $n/$RUNS ($SCENARIO, $P)"
  services=(relay nat-a nat-b)
  [ "$SCENARIO" = nostun ] || services+=(stun)
  dc up -d "${services[@]}"
  relay_id=""
  for _ in $(seq 60); do
    relay_id=$(dc logs relay 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'relay node started peer_id=[A-Za-z0-9]*' | cut -d= -f2 || true)
    [ -n "$relay_id" ] && break
    sleep 1
  done
  [ -n "$relay_id" ] || { echo "relay did not start"; status=1; dc down -v --remove-orphans >/dev/null 2>&1; break; }
  export MVS_RELAY="/ip4/10.81.0.10/tcp/4001/p2p/$relay_id"

  dc up -d --no-deps a b
  code_a=$(docker wait "$(dc ps -aq a)")
  code_b=$(docker wait "$(dc ps -aq b)")
  dc logs --no-color --no-log-prefix a > "$out/a.log" 2>&1 || true
  dc logs --no-color --no-log-prefix b > "$out/b.log" 2>&1 || true
  docker cp "$(dc ps -aq a)":/rendezvous/. "$(mount "$out")" >/dev/null 2>&1 || true
  rm -f "$out"/*.invite.json
  grep -hE "^(PASS|FAIL|SKIP) " "$out/a.log" "$out/b.log" || true
  echo "app a exit $code_a, app b exit $code_b"
  if [ "$SCENARIO" = direct ] && { [ "$code_a" != 0 ] || [ "$code_b" != 0 ]; }; then status=1; fi
  [ -n "${KEEP:-}" ] || dc down -v --remove-orphans >/dev/null 2>&1 || true
done

echo
echo "== G-81 two-NAT verdict ($SCENARIO, $RUNS run(s))"
docker run --rm -v "$(mount "$here"):/e2e:ro" -e SETUP_MAX_MS="${SETUP_MAX_MS:-10000}" -w /e2e node:22.23.4-bookworm \
  node two-nat/verdict.mjs "$SCENARIO" $(for d in "${dirs[@]}"; do echo "/e2e/results/$(basename "$d")"; done) || status=1
exit "$status"
