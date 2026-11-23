# Relay in the app: users are the relays

**Owner (2026-11-23):** "put the relay inside the app, so the users are the relay." The goal is that no project relay is needed: every MVS app can be a relay and bootstrap for others, under the no-central-server rule.

This builds on member relays (#368, `docs/design/member-relays.md`), Kademlia, members-only DCUtR (#184/#219), multi-relay (#477) and G-81 C2 media (#509/#554). The SL and TL review it; nothing is built until they agree.

## 1. Who relays

The **role**: a core runs the relay v2 server role (`member_relay.rs` today) only when it is **publicly reachable**. That means it has a confirmed public address that peers dialled back. It's learnt from identify observations confirmed by a successful inbound dial from a peer that isn't on our LAN (a members-only "dial me back" over an existing connection). There's no AutoNAT service open to strangers. A core behind NAT or CGNAT never relays, since it couldn't carry anyone's circuit anyway.

**Opt-in or automatic:**
- **v1:** keep #368's rule. It's on by default for server owners and admins who are reachable, and opt-in for everyone else.
- **v2, the owner's goal:** on by default for every reachable desktop core that isn't relay-only, with an off switch. Phones and laptops on battery or metered links never relay.

**For whom:**
- **v1: members only.** We relay only for peers bound (GAP-4) to a member of a server we share, exactly as #368 does today.
- **v2:** also for "any MVS user", which is what a fresh install needs before it has any server (§2). That widens who can use our bandwidth, so it comes with strangers' quotas: a separate, smaller budget (for example 2 reservations and 64 MiB a day), circuits only, and nothing else served to strangers (no sync, no DHT records beyond relay discovery).

**Relay-only users** never relay (#368 §1). They use relays: ours while they exist, then members' reachable relays. Their IP is still seen by the relaying member, which the relay-only notice must say.

## 2. Bootstrap with no fixed relay

A fresh install has no peers. The options, in order:
1. **The invite link carries the way in.** Invites already carry the server; add up to 3 signed **relay hints** from the inviter: reachable members' `/ip4|ip6/.../tcp|quic/<port>/p2p/<id>` addresses, refreshed when the invite is created.
   - They're signed by the inviter and valid for the invite's lifetime.
   - The joiner dials them **only** for the join, and treats them as untrusted transport (Noise authenticates the peer ID).
   - Privacy: whoever holds the link learns those members' public IPs. They're shown to the owner and admins who opted in to relaying, never to plain members without consent.
   - Short links (T8-02) resolve the envelope through the DHT, which needs a first peer, so they keep a fallback (option 3).
2. **The peer cache.** After the first join, the core keeps up to 64 recently-good reachable peers (relays and bootstraps), signed-binding verified, with an age-out. That's enough for later starts with no hints. Today's `peer_addrs` and remembered-address code (#419) is the base.
3. **A small public seed list in the release**, as the last resort: a few community or project addresses, like BitTorrent's DHT seeds. It's a bootstrap only, never a relay for content, and the app works without it whenever 1 or 2 succeed. This is the one "known address" left; the owner decides whether it ships (the no-central-server rule says the app must *work* without it, and it does once a peer is cached).

The DHT then finds the rest: relays announce a provider record under `mvs/relays/v1` (rotating per day), so peers find relays they share no server with. That's a v2 item, since it exposes reachable users' IPs to anyone who asks.

## 3. Limits, abuse and privacy

- **What a relaying user learns:** the IPs and peer IDs of the two ends of each circuit, plus timing and volume. Content stays end-to-end Noise. The UI says this when relaying is turned on (#368's notice, extended), and the threat model gets a row.
- **Caps** (from #368, kept):
  - 8 reservations and 16 circuits;
  - 120 s and 8 MiB per circuit, with the daily cap (2 GiB default, 256 MiB minimum);
  - for strangers (v2), a separate, smaller budget.
  - When a cap is hit it refuses, never queues.
  - For voice, each circuit is still charged its full 8 MiB up front, which is why calls avoid member relays while ours exist (#509 §2.4 (c)). Before our relays are removed, voice needs option (a) from #509: about 1 MiB charge units on member relays.
- **Abuse:** a relay only ever carries traffic for bound members (v1), so a stranger can't use it. In v2, stranger circuits are capped, and a relay may refuse peers that misbehave (rate of circuit requests, a burst of reservations). Reservations don't carry any MVS data, so a relay can't read or change messages.
- **Exposure:** a reachable relay's home IP is visible to everyone it serves. Only reachable, opted-in users do it, and they can turn it off; minors never relay.

## 4. The project relays

Keep them through the migration as one relay among many (`OurRelay` list, #477). Order of use: direct, then a member relay, then ours. That flips today's order, so ours becomes the last resort. Ours are removed when the field data (QA's path logs and relay stats) shows member relays and the cache carry joins and sync for, say, 95% of sessions over two releases. The owner decides the date.

## 5. Migration and effort

| Step | What | Effort (dev-sync unless noted) |
|---|---|---|
| R1 | Reachability check: a members-only dial-back to confirm a public address; relay only when reachable | S–M (2–3 days) |
| R2 | Relay hints in invites (signed, ≤ 3), and the joiner dialling them; the peer cache from #419, bounded and verified | M (3–4 days) + api/UI copy |
| R3 | The flipped order (member relays before ours) behind a flag; G-81 option (a) charge units for voice | M (2–3 days) |
| R4 | On by default for reachable desktop cores (v2), with the stranger budget and `mvs/relays/v1` DHT discovery | M–L (4–5 days), SL review |
| R5 | The seed list (if the owner wants it), the field metrics, then removing our relays | S + devops |

Order: R1 → R2 → R3, then R4 and R5. Each step ships behind a flag with SL review. The G-81 part (b) refresh and the voice charge units come before R3.
