# Design note: relay-in-app v2 (owner input, 2026-11-26)

Status: proposal by the Tech Lead; the Security Lead decides the privacy points (marked **SL**). It builds on `relay-in-app.md` (R1–R5), `member-relays.md` (RR-R1) and the UX spec `docs/ux/specs/relay-in-app.md` (port mapping PM1–PM11).

## Where main stands today
- **Our relays come first.** Every app reserves a circuit on our relays (by domain name, from the build-time config) and is reached by peer ID through them.
- **Member relays are a fallback.**
  - Any member can relay for co-members: on by default ("Auto") for owners and admins, opt-in for others.
  - The switch is off for minors, relay-only and metered connections, and paused on battery (#573).
  - It's capped per peer and per day.
  - Offers ride in sync answers to members only. They're used only after all our relays have been down for 60 s.
- **R1 (#565)** is approved and merging: an app relays only after another member proved it reachable (dial-back).
- **Sync:**
  - every 5 s, each app pulls the server logs from the members it's connected to (anti-entropy), and new records spread by gossip;
  - **every member stores the whole log**, so any online member is a store-and-forward point for anyone who was offline;
  - our relays keep a mailbox only for backups and notices, not chat.
- **Addresses:** members swap their current listen addresses inside pull answers (members only), and identify does the same. Nothing is published outside the server.

## 1. Port mapping (R1b): decided yes (owner)
The app asks the home router (UPnP-IGD, NAT-PMP, PCP) for one port, so a home computer can relay. PM1–PM11 (the SL's conditions) stand. The open point is the **default**.

**Recommendation:**
- **On by default when the person has turned relaying on themselves** ("On", not "Auto"): they already saw the disclosure, and the disclosure gains one line saying the home IP becomes visible to the members they relay for.
- **Off by default under "Auto"** (the owner and admin default): that's a router change nobody asked for. Ask once, with a one-tap prompt in the relay status, when R1 shows "not reachable".
- Never on minors' or relay-only devices, nor on battery or metered connections (paused).
- The mapping is removed when relaying stops or the app quits, and is renewed with a short lease (PM conditions).

**SL decides** whether "On" may imply the mapping or must stay a separate switch (PM1 today says a separate switch, off by default).

## 2. Relays in invite links (owner request: 1–5 relays)
**Goal:** a joiner can reach the server even when our relays are down, and without DHT luck. Today a joiner finds an invite holder only if the DHT walk happens to connect it to a member.

**Constraint:** links get shared (chats, screenshots, posts). Anything in the link is readable by anyone who holds it. Encrypting under the link's own key hides nothing from those people; it only hides it from those who see part of a link.

| Option | Works with our relays down? | What a link holder learns | Link length |
| --- | --- | --- | --- |
| A. Raw IP:port of 1–5 relays | yes | members' home IPs | about 140–350 characters |
| B. Peer IDs only, dialled through our relays (circuit by ID) | **no** | nothing new | about 100–300 characters |
| C. Addresses fetched after opening (from our relays or the DHT, by `h(k)`) | **no** | nothing in the link | unchanged |
| D. A, but only R1-proven, opted-in relays, a short truncated ID, 7-day expiry, disclosed | yes | the public relay IPs of members who agreed to it | about 100–150 characters for 3 |

**Recommendation: D, with B as the fallback when no member qualifies.**
- A relay that R1 proved reachable already shows its IP to every peer that connects to it. The disclosure (§1) tells the person their IP becomes visible, and adds "it can also appear in invite links".
- The link carries **at most 3** hints. Five would make a link too long to share easily, and 3 are enough with expiry.
- Each hint is IPv4 or IPv6:port plus 16 bytes of the relay's peer ID. The noise handshake checks the full ID, so a wrong hint fails closed.
- **Only links that carry hints expire after 7 days.** An old link still works through our relays (B) after its hints go stale.
- An owner or admin can create a link without hints (a toggle when creating the invite). **SL decides** whether that's the default for 18+ servers.
- **Needs:** link format v2 (a new version byte; older apps show "update needed", as today), and the hint source from R1c.

## 3. The owner's model: can it work? Yes, mostly as a re-ordering of what's planned
| Owner's step | Today | What's missing | Where it lands |
| --- | --- | --- | --- |
| On coming online, push my new address to the other members' relays | addresses ride in pull answers every 5 s, members only | a small **signed address record** (my peer ID, addresses, expiry), pushed on change and re-served by member relays | **R1c** |
| Each client keeps a table of member relays with a ping score | relay offers are stored for 24 h; no score | per-relay RTT and uptime over 24 h, kept locally, never sent (this also feeds the health counter, §4) | **new: relay table** |
| Sends and changes go to the 1–3 strongest | records go by gossip to all connected members, which is more robust than 1–3 | keep gossip, which already forwards (a mesh); use the table only to choose **which relays to reserve on** | **R3** (order: the best member relays alongside ours) |
| Pull periodically from the 1–3 strongest | pulls every 5 s from connected members, plus re-dials | pull targets ranked by the table | **R3** |

**What the model needs beyond itself:**
- **CGNAT:** those users can't be relays (no inbound), only clients. The table must handle "zero member relays" by falling back to ours.
- **Offline store-and-forward:** already covered, because every member keeps the whole log. A member relay is also a member, so it holds the log; no separate mailbox is needed for chat.
- **Fan-out and forwarding:** gossip already forwards. Don't narrow sends to 1–3, because a single slow relay would delay everyone.
- **Load caps:** keep the per-peer, per-day and circuit caps, and add a cap on reservations per relay so the table doesn't pile everyone onto the single best relay. Spread choices by hashing the client ID.
- **IP privacy:** address records go to **members only** (bound), never to the DHT or to strangers. R2 (relaying for strangers) stays an owner decision.

## 4. Relay-health counter (the PO is specifying it)
- **Count:** member relays plus our relays this device can reserve on.
- **Uptime:** the share of probe successes over 24 h.
- **Green:** 6 or more relays at ≥ 95%. **Red:** 0–2. **Yellow:** anything else.
- **Probes:** reservation state and pings on connections that are already open; no new dials just to measure. Computed and kept on the device only.
- **What the UI shows:** a colour and counts, with no relay names, IDs or IPs (PM11). It needs the relay table from §3.

## Build order
1. R1 (#565, merging).
2. **R1b** port mapping, with the default from §1 (SL).
3. **R1c** signed address records to members.
4. **The relay table** with RTT and uptime, plus the **health counter** (§4).
5. **R3**: rank relays by the table, keeping ours and capping per relay.
6. **Invite link v2** with hints (§2), after R1c, since it needs proven relays.
7. R2 (strangers): an owner decision, last.
