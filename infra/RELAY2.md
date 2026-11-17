# Relay-2 on the owner's PC (interim)

Owner, 2026-11-17: a second live relay runs **in Docker on the same PC** as
relay-1 until a real second host exists. It is a separate compose project
with its own identity, so clients can treat it as an independent relay.

| | relay-1 | relay-2 |
|---|---|---|
| compose project | `infra` | `infra2` |
| container | `infra-relay-1` | `infra2-relay-1` |
| volume (node key, backup mailbox) | `infra_relay-data` | `infra2_relay-data` |
| peer ID | its own | **its own** (generated on first start; never copy relay-1's key) |
| host ports | 4001/tcp, 4001/udp, 4002/tcp (wss via the proxy) | **4011/tcp, 4011/udp (QUIC)**, 4012/tcp on 127.0.0.1 only |
| wss | yes (reverse proxy) | no |

## Run it

From a checkout of `main`, with relay-2's own `.env` kept outside the repo
(start from relay-1's: same `DOMAIN`, `EXTERNAL_ADDRS` with port **4011** and
no `wss` entry, `WS_BIND=127.0.0.1`):

```powershell
docker compose -p infra2 -f infra/docker-compose.yml -f infra/docker-compose.relay2.yml --env-file <relay2 dir>\.env up -d --build relay
```

`docker-compose.relay2.yml` only moves the host ports; the service is
relay-1's, hardening included. After the first start, set `PROXY_IPS` in
relay-2's `.env` to the `infra2_default` network's gateway (Docker Desktop
rewrites inbound source addresses to it, like relay-1's), then run the same
command again. Relay-2's peer ID is in its first `relay node started` log
line; keep it out of the repo.

## Router (owner)

Forward to this PC, next to relay-1's 4001 rules:

- **4011/tcp**: libp2p TCP
- **4011/udp**: libp2p QUIC

Nothing else: relay-2 has no wss and no STUN.

## How clients address it

Multiaddrs, pinned by peer ID (placeholders here; real values live in repo
variables, never in git):

```text
/dns4/<relay-host>/tcp/4011/p2p/<relay-2 peer id>
/dns4/<relay-host>/udp/4011/quic-v1/p2p/<relay-2 peer id>
```

(`/ip4/<public ip>/...` works the same if there is no DNS name.)

## What the client needs

- **A bootstrap list, not one address.** The build-time config
  (`write-relay-config.mjs` → `mvs-config.json`) has one `relay` (wss) and a
  `bootstrap` array, but the release workflow fills `bootstrap` from a single
  repository variable (`MVS_RELAY_TCP_ADDR`). To ship relay-2, the variable
  and the script must take a comma-separated list (relay-1 TCP, relay-2 TCP,
  and each relay's `/quic-v1`), each entry checked and pinned by `/p2p/`.
  That's a small devops PR when the owner wants relay-2 in a release.
- **Device link:** device-link (#398) dials through our own relay and ignores
  the QR's circuit, so two devices on different relays wouldn't meet. Fix
  that before clients are spread over two relays (Tech Lead, 2026-11-17).
- **Backups:** each relay keeps its own mailbox and puts provider records only
  in its own DHT store (provider republishing is off, see README "Backup
  mailbox"). With two relays, clients must write to both, or republishing must
  come back on (GAP-9).

## Limits of "the same PC"

Same uptime, same internet connection and the same Docker Desktop NAT as
relay-1, so it adds an independent identity, not independent availability.
It moves to its own host (and `network_mode: host`, #220) later.

## Follow-ups

- With the next `infra/relay` libp2p update, move off `hickory-proto` 0.25
  (advisories; lower risk for the relay, whose DNS use is only its own
  config).
