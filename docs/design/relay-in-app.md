# Relay in the app: users are the relays

**Owner (2026-11-23):** "put the relay inside the app, so the users are the relay." The goal is that no project relay is needed: every MVS app can be a relay and bootstrap for others, under the no-central-server rule.

This builds on member relays (#368, `docs/design/member-relays.md`), Kademlia, members-only DCUtR (#184/#219), multi-relay (#477) and G-81 C2 media (#509/#554).

**Status:** approved by the TL (R1 → R2 → R3, with amendments) and the SL (RR1–RR9) on #561. Their conditions are folded in below and listed per step in §6. **R4 (strangers) and R5 (seeds, removing our relays) are not approved steps:** each waits for an owner decision.

## 1. Who relays

The **role**: a core runs the relay v2 server role (`member_relay.rs` today) only when it is **publicly reachable**. That means it has a confirmed public address that peers dialled back. It's learnt from identify observations confirmed by a successful inbound dial from a peer that isn't on our LAN (a members-only "dial me back" over an existing connection). There's no AutoNAT service open to strangers. A core behind NAT or CGNAT never relays, since it couldn't carry anyone's circuit anyway.

**Opt-in or automatic:**
- **v1:** keep #368's rule. It's on by default for server owners and admins who are reachable, and opt-in for everyone else.
- **v2, the owner's goal:** on by default for every reachable desktop core that isn't relay-only, with an off switch, **for members of shared servers**. It never runs on battery or metered links, for relay-only users, on unreachable cores, or for users under 18 (effective age, enforced in the core: RR2).

**For whom:**
- **v1: members only.** We relay only for peers bound (GAP-4) to a member of a server we share, exactly as #368 does today.
- **Strangers ("any MVS user") are a separate owner and SL decision (R4), not part of the approved plan.** If approved, it's **opt-in, never a default, never for minors** (RR8). It has a separate small budget (for example 2 reservations and 64 MiB a day), circuits only, no sync, no DHT records beyond relay discovery, and a cap that refuses rather than queues.

**Relay-only users** never relay (#368 §1). They use relays: ours while they exist, then members' reachable relays. Their IP is still seen by the relaying member, which the relay-only notice must say.

## 2. Bootstrap with no fixed relay

A fresh install has no peers. The options, in order:
1. **The invite link carries the way in.** Invites already carry the server; add up to 3 signed **relay hints** from the inviter: reachable members' `/ip4|ip6/.../tcp|quic/<port>/p2p/<id>` addresses, refreshed when the invite is created.
   - They're signed by the inviter and valid for the invite's lifetime.
   - The joiner dials them **only** for the join, and treats them as untrusted transport (Noise authenticates the peer ID).
   - Privacy: whoever holds the link learns those members' home IPs, and links get pasted in public. So a member is listed **only if that member turned on its own "my address may appear in invites" setting**, separate from "I relay", and never if a minor (TL 1, RR3). The invite dialog says the link contains relay addresses.
   - Shape (RR4): at most 3 hints, each a public `/ip4|ip6/…/tcp|quic-v1/<port>/p2p/<id>` with nothing else (no DNS, LAN or circuit addresses), size-capped, expiring no later than the invite. The joiner dials a hint only for this join, expecting that peer ID, and discards it after. A hint enters the peer cache only if that peer later proves to be a bound member.
   - Short links (T8-02) resolve the envelope through the DHT, which needs a first peer, so they keep a fallback (option 3).
2. **The peer cache.** After the first join, the core keeps up to 64 recently-good reachable peers, which is enough for later starts with no hints. Today's `peer_addrs` and remembered-address code (#419) is the base. The rules (TL 5, RR5):
   - only peers whose identity binding was verified and who were members of a server I share when cached;
   - public addresses only, unless LAN is allowed, with an age-out;
   - per device: never in the restore backup, never synced, cleared on sign-out and when I leave that peer's last shared server;
   - a relay-only user's cache holds relay addresses only, used only for circuits.
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

Keep them through the migration as one relay among many (`OurRelay` list, #477). Order of use: direct, then a member relay, then ours. That flips today's order (R3), so ours become the last resort, with two exceptions:
- **relay-only users keep our relays first** for as long as ours exist (RR6);
- **voice keeps today's rule** (member relays only when none of ours is reachable) until the voice charge units and G-81 part (b) land (TL 6, RR7).

**Removal** (R5, the owner's decision) needs field data (QA's path logs and relay stats) showing member relays and the cache carry joins and sync for about 95% of sessions over two releases. It **also** needs the count of **servers with zero reachable members** (TL 2): such a server has no relay once ours are gone, its relay-only members can't connect at all, and fresh joins rely on hints or the cache. After removal, relay-only means "circuits through members of servers I share only", and notice v3 says that it needs at least one reachable member, and that the relaying member sees your IP (RR6).

## 5. Migration and effort

| Step | What | Effort (dev-sync unless noted) |
|---|---|---|
| R1 | Reachability check: a members-only dial-back to confirm a public address; relay only when reachable | S–M (2–3 days) |
| R2 | Relay hints in invites (per-member consent, ≤ 3), and the joiner dialling them; the peer cache from #419, bounded and verified | M (3–4 days) + api/UI copy |
| R3 | The flipped order (member relays before ours) behind a flag; G-81 option (a) charge units for voice | M (2–3 days) |
| R4 | *Not approved; owner and SL decision.* Opt-in stranger relaying with its own budget, and `mvs/relays/v1` DHT discovery | M–L (4–5 days) |
| R5 | *Owner decision.* The seed list, the field metrics (including servers with no reachable member), then removing our relays | S + devops |

**Approved order: R1 → R2 → R3.** That's about 2–2.5 weeks of dev-sync time, plus api and UI copy for R2. Each step ships behind a flag and gets an SL review. Each also gets QA's two-NAT e2e with **no project relay** in the test network: a join through hints, then sync through a member relay. The voice charge units and G-81 part (b) come before R3.

## 6. Review conditions, per step (TL and SL on #561)

- **R1, the dial-back** (RR1, TL 4):
  - only over an existing connection, between bound members, never offered to strangers;
  - the helper dials **only the address it observed** for the asker (identify's observed address or the connection's remote address), never one the asker supplies;
  - that address must be global (not private, loopback, link-local or our LAN), and the dial expects the asker's peer ID, so a wrong host gets at most one failed handshake;
  - at most one per asker every 10 minutes, plus a global cap;
  - the result is cached about 30 minutes and rechecked on a network change.
  - Test: a NAT'd core never advertises itself as a relay.
- **R1, who may relay** (RR2): never while relay-only, unreachable, on battery or metered, or under 18 (effective age, in the core).
- **R2, hints** (RR3, RR4, TL 1): per-member consent, never minors, the shape and use rules in §2, and the invite dialog says so.
- **R2, peer cache** (RR5, TL 5): the rules in §2.
- **R3, the flipped order** (RR6, RR7, TL 6): relay-only users keep our relays first; voice keeps today's rule until the charge units and part (b) land. The SL adds the threat-model row when R3 lands.
- **R4, strangers** (RR8, TL 3): opt-in only, never minors, a separate small budget, the DHT key rotated daily. It waits for the owner.
- **R5, seeds** (RR9): bootstrap only, peer IDs pinned in the release, never relaying content. A CI test proves the app works with every seed down. Whether they ship is the owner's call.
- **General:** content stays end-to-end Noise. What a relaying user learns (both ends' IPs and peer IDs, timing, volume) is shown when relaying is turned on. The SL holds firm on RR1, RR3 and RR8.
