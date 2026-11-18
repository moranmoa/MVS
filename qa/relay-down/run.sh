#!/bin/bash
# Relay down, in Docker, with a THROWAWAY relay only (never the live one):
# an owner who relays for members (member relays, #399) and two members.
# Once all three exchange messages, the test relay is killed. Then:
#   (a) do messages still flow, directly or through the owner's member relay
#       (members fall back to it after about 60 s)?
#   (b) a member that restarts while the relay is down: today it is expected
#       to stay offline (no remembered addresses, no LAN discovery yet), so
#       this is reported as XFAIL until dev-sync's fix lands.
#
#   CORE=<path to a Linux mvs-core> TOPO=lan   bash qa/relay-down/run.sh
#   CORE=<path to a Linux mvs-core> TOPO=split bash qa/relay-down/run.sh
#
# TOPO=lan:   A and B share a LAN; the owner is elsewhere and reachable only
#             through the relay (a home owner behind NAT).
# TOPO=split: A and B have no path to each other; the owner is reachable by
#             both (a public owner), so A and B can only meet through its
#             member relay once the relay is down.
# The relay uses the live circuit limits (32 MiB, 3600 s), as qa/join-matrix.
# Logs, with addresses and peer IDs masked: qa/relay-down/.build/<run>/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*) export MSYS_NO_PATHCONV=1; mount() { (cd "$1" && pwd -W); };; *) mount() { (cd "$1" && pwd); };; esac
CORE=${CORE:?set CORE to a Linux mvs-core}
TOPO=${TOPO:-lan}
P="mvs-rdown-$(date +%s)-$RANDOM"
rv="$here/.build/$P"
mkdir -p "$rv/core" "$rv/rv"
cp "$CORE" "$rv/core/mvs-core"
mask() {
  sed -E -e 's#/p2p/[1-9A-HJ-NP-Za-km-z]{40,}#/p2p/<peer>#g' -e 's#([0-9]{1,3}\.){3}[0-9]{1,3}#<ip>#g' \
    -e 's#\b12D3KooW[1-9A-HJ-NP-Za-km-z]{40,}#<peer>#g' -e 's#\x1b\[[0-9;]*m##g'
}
nets() { if [ "$TOPO" = split ]; then echo na nb; else echo lan on; fi; }
cleanup() {
  docker rm -f "$P-relay" "$P-o" "$P-a" "$P-b" >/dev/null 2>&1 || true
  for n in $(nets); do docker network rm "$P-$n" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

docker build -q -t mvs-voice-e2e-app -f "$(mount "$repo/desktop")/Dockerfile.e2e" "$(mount "$repo/desktop")" >/dev/null
docker image inspect mvs-relay:voice-e2e >/dev/null 2>&1 ||
  docker build -q -t mvs-relay:voice-e2e --build-arg CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" "$(mount "$repo/infra/relay")" >/dev/null
for n in $(nets); do docker network create "$P-$n" >/dev/null; done
set -- $(nets)
docker run -d --name "$P-relay" --network "$P-$1" --network-alias relay --read-only --tmpfs /tmp --tmpfs /data:uid=10001,mode=700 \
  -e ALLOW_PRIVATE_ADDRS=1 -e EXTERNAL_ADDRS=/dns4/relay/tcp/4001 -e RUST_LOG=info \
  -e MAX_CIRCUITS="${MAX_CIRCUITS-256}" -e MAX_CIRCUITS_PER_PEER="${MAX_CIRCUITS_PER_PEER-8}" \
  -e MAX_CIRCUIT_SECS="${MAX_CIRCUIT_SECS-3600}" -e MAX_CIRCUIT_BYTES="${MAX_CIRCUIT_BYTES-33554432}" mvs-relay:voice-e2e >/dev/null
docker network connect --alias relay "$P-$2" "$P-relay"
relay_id=""
for _ in $(seq 30); do
  relay_id=$(docker logs "$P-relay" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'relay node started peer_id=[A-Za-z0-9]*' | cut -d= -f2 || true)
  [ -n "$relay_id" ] && break
  sleep 1
done
[ -n "$relay_id" ] || { echo "relay did not start"; exit 1; }

side() { # role first-network [second-network]
  docker run -d --name "$P-$1" --network "$P-$2" -e ROLE="$1" -e TOPO="$TOPO" \
    -e MVS_RELAY="/dns4/relay/tcp/4001/p2p/$relay_id" \
    -v "$(mount "$rv/core"):/core:ro" -v "$(mount "$here"):/qa:ro" -v "$(mount "$rv/rv"):/rendezvous" \
    mvs-voice-e2e-app sh -c "chmod 777 /rendezvous; runuser -u pwuser -- dbus-run-session -- sh -c 'eval \"\$(gnome-keyring-daemon --start --components=secrets)\"; export GNOME_KEYRING_CONTROL; printf test | gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null && w=0 && until { dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets | grep -q \"boolean true\" && dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default | grep -q collection/login; } || [ \$w -ge 150 ]; do w=\$((w+1)); sleep 0.2; done && echo keyring-wait=\$w >&2 && node /qa/relaydown.mjs'" >/dev/null
  [ -z "${3:-}" ] || docker network connect "$P-$3" "$P-$1"
}
if [ "$TOPO" = split ]; then
  side o na nb
  side a na
  side b nb
else
  side o on
  side a lan
  side b lan
fi

# The owner asks for the kill once all three have talked through the relay.
for _ in $(seq 1200); do [ -f "$rv/rv/o.kill.json" ] && break; sleep 0.5; done
if [ -f "$rv/rv/o.kill.json" ]; then
  docker rm -f "$P-relay" >/dev/null
  echo "{\"at\":$(($(date +%s) * 1000))}" > "$rv/rv/relay.killed.json"
fi
docker wait "$P-o" "$P-a" "$P-b" >/dev/null
for r in o a b; do
  docker logs "$P-$r" 2>&1 | mask > "$rv/$r.log"
  mask < "$rv/rv/core-$r.log" > "$rv/core-$r.log" 2>/dev/null || true
done
rm -f "$rv"/rv/core-*.log
echo "== relay down, topology $TOPO ($rv)"
grep -hE "^(PASS|FAIL|XFAIL|XPASS|INFO)" "$rv/o.log" "$rv/a.log" "$rv/b.log"
for r in o a b; do
  echo "$r: member-relay log lines: $(grep -ci 'member relay' "$rv/core-$r.log" || true)"
done
