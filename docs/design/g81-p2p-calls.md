# G-81: voice calls across networks over the P2P network only

- **Status: approved (C2)** by the manager, TL and SL at ed3715b. This version folds in their amendments (TL A1–A8, SL B1–B6, the manager's two requirements, including the §2.4 circuit order) and dev-sync's network facts (`dev-sync-g81-network-side.md`).
- **Authors:** voice-d with dev-sync.
- **Supersedes:** the STUN/TURN path in `voice-across-networks.md` (#333) for the release plan. #433 (TURN) closes (TL), `MVS_STUN_URL` stays unset, and the STUN code path stays dormant.
- **Owner's decision (2026-11-18):** "all the app needs to work without server so make it work with the decentralized network." There's no project STUN or TURN and no public STUN. We use the libp2p network the app already runs: relays, member relays (#368), members-only hole punching (DCUtR, #219/#184), and the LAN beacon (#460).
- **Review criteria:** `sec-lead-g81-p2p-calls-criteria.md`, answered in §7.

## 1. Where we are

**Voice today:**
- **Same LAN:** works. WebRTC with host candidates, DTLS pinned to the signed fingerprint, signalling over `/mvs/voice/1` (members only, 5/s per peer, 10/s overall, 16 KiB).
- **Different networks:** no call. The UI shows "אין חיבור קולי".
- **Relay-only:** no calls (the core refuses; the engine too, #496 S1).

**The network side, which already crosses networks for chat (dev-sync):**
- **Authenticated member connections.** Every member pair reaches each other through relay v2 circuits on up to 4 of our relays (#477), and often directly after DCUtR (members-only, `punch.rs`, TCP and QUIC). On one LAN, the beacon finds them. Each one is a Noise session **end to end between the two cores**: a circuit is a transport, and relays see ciphertext only.
- **Path per member.** The node knows whether each peer is direct (punched or LAN) or relayed.
- **Relay limits:**
  - **Our relays (R11):** 256 circuits, 8 per peer, **1 h and 32 MiB per circuit, both directions summed** (libp2p-relay 0.21.1 `copy_future` keeps one counter). When a circuit ends, its streams die, and renewing a reservation never extends a circuit.
  - **Member relays:** 8 reservations, 16 circuits, **120 s and 8 MiB per circuit**. Each circuit is charged its full 8 MiB against `daily_cap_mb` (default 2,048).
- **relay-only.** It drops direct listeners and closes the punch gate (GAP-6). No direct path to anyone.
- **DCUtR success rate: not measured.** #219 proved it in tests and in the 0.2.5 smoke (relay → direct over a hotspot, judged by eye). We have no rate, so **direct is opportunistic** and nothing is designed around a number. QA logs the path type per call to get one (§6).

## 2. Design: C2

**LAN peers keep WebRTC. Everyone else gets Opus over a members-only libp2p stream ("B"):** direct after a DCUtR punch, else a relay circuit.

### 2.1 Options considered

- **A, peer STUN on cores: rejected.**
  - A helper must receive unsolicited UDP from the asker's browser socket, so it needs public UDP, which real servers mostly don't have.
  - A plain-STUN port can't be gated by identity, and a source-IP allow-list is a spoofable reflector (SL).
- **A0, synthetic srflx from libp2p-observed addresses: not in v1 (dev-sync's proposal, recorded).**
  - The engine would add a srflx candidate with our identify-observed public IPv4 and the host port. That works across port-preserving NATs with no STUN.
  - The TL (A7) and SL (B4) chose WebRTC **only toward LAN peers**, so no host or srflx candidates go to peers on other networks. That makes C2 disclose less than today. B already covers those peers, direct when a punch works.
  - A0 can come back as its own design item if the spike or QA data shows relayed calls are often poor *and* punches fail where A0 would work.
- **B alone:** would also replace LAN WebRTC. Rejected: on a LAN, WebRTC has the best quality (UDP, built-in echo cancellation and jitter handling) and costs nothing.

### 2.2 The C2 switch (TL A7, SL B4)

- **My engine decides, per peer.** WebRTC is started **only when the core reports a direct connection to that peer over a private (LAN-scope) address** (`path_to(peer) == Lan`). Otherwise it's B straight away, with no wait.
- **Fallback:** a LAN attempt that hasn't connected in 3 s falls to B for that peer. If WebRTC later gives up (ICE restart, #469), the call moves to B rather than ending.
- **A peer's offer never forces a path.** An offer from a peer my core doesn't see on the LAN is ignored, and I answer on B.
- **Relay-only:** only B over circuits through our relays. There's no RTCPeerConnection (#496 S1), no candidates, no DCUtR, and no member relays (SL B5).

### 2.3 B: media over `/mvs/voice-media/1` (frozen contract, TL A2)

This contract is frozen so dev-sync (stream + core API) and voice-d (pipeline, against a loopback mock) can build in parallel.

**Wire frame:**

```
call_id [16] ‖ seq u32 ‖ ts u32 ‖ len u16 ‖ opus [len]      len ≤ 400
```

- Anything else (a bad length, an over-size frame, a malformed header) **closes the stream**.
- `seq` strictly increases per (call, sender): a duplicate or stale seq is dropped.
- A frame whose `call_id` isn't my current call is dropped.

**The stream gate (SL B1):** accepted and opened only with a peer:
- whose libp2p key is **bound** to a member identity (GAP-4; mandatory, not merely connected);
- who is a current, non-kicked member of the call's server;
- **and** who is a participant in my current call, per the call state voice.rs holds.

Noise over the bound peer key is B's authentication, standing in for WebRTC's DTLS pinning.

**Caps (SL B2):**
- payload ≤ 400 B (stricter than the SL's 512);
- per peer, 60 frames/s with a short burst;
- a global cap;
- the jitter buffer bounded in frames and in ms (≤ 200 ms).

Over a cap, the frame is dropped; after a sustained flood, the stream is closed. Nothing from a frame is logged above trace, and audio payloads never.

**Core API (TL A2, SL B3):**
- **Send:** `voiceFrame(callId, seq, ts, data)` is **fire-and-forget**, with no reply per frame. The core sends to **every peer in my current call** that is on B. The renderer can't name arbitrary targets, and it encodes **once per frame**, not once per peer.
- **Receive:** event `voice.frame { callId, from, seq, ts, data }`.
- **Both:** in `commands.js` and `guardCore`, accepted only when `fromUs` and only during an active call. They carry the same size and rate caps as the stream, so a compromised renderer can't pump traffic. While the app is locked, they're allowed only under G-78 path B (a call in progress), for that call.
- **Channel:** the existing stdio JSON channel, **unless the spike misses its target** (§5). A binary side channel is new IPC surface, which needs SL review and has to earn its place.
- **Path report:** `path_to(peer) -> Lan | Direct | Circuit | MemberCircuit | None`, for the switch and for the diagnostics panel (types only).

**Encoding (TL A4):**
- Opus via WebCodecs, 24 kbps on direct and LAN links, **16 kbps on relayed links**, 40 ms frames.
- **DTX while silent; nothing sent while muted** (this saves relay budget and member caps).

**Circuit lifetime (TL A3, dev-sync).** Circuit ends are part of normal operation: the project relay's at 3600 s or 32 MiB, a member relay's every 120 s. Sync opens a fresh circuit (or uses a newly punched direct connection) **before** the cut (make-before-break) and moves the stream, with a sub-second gap and no call teardown. The jitter buffer covers the gap.

**Path upgrade (TL A5):** a call that starts on a circuit moves to a direct connection when DCUtR succeeds, with no gap, and back if direct dies (the relayed connection stays parked, #206). The api sees one logical media channel per call peer.

**Mesh limit (TL A6):** at most 8 peers per call (the existing room cap). Each pair is its own stream and circuit, within 8 circuits per peer on our relays.

**Relay load (TL A6):** a devops item. This work changes no `MAX_CIRCUIT_*` value, since `infra/**` is devops-only and any change goes through the SL.
- **Cost per relayed 1:1 pair** (about 44 B of framing per frame, both directions summed): about 18 MB/h at 16 kbps (DTX lowers it further), about 30 MB/h at 24 kbps.
- **Against the project relay:** both fit its 32 MiB circuit, which is refreshed before the cut anyway.

### 2.4 Circuit order (decided by the manager)

**Order:** direct (LAN or punched) → a member relay of the same server → the project relay as last resort.

- **Member relays carry media through a voice circuit class** in `member_relay.rs`, charged by the bytes actually relayed. dev-sync builds it, with SL review.
- **Until that class lands,** member relays carry media only when no project relay is reachable, because today each 120 s circuit is charged its full 8 MiB.
- **Relay-only users** always use our relays only (SL B5), so members never see their IP.

The two rules are consistent: member relays come first for normal users, and relay-only users never use them.

**Background**, for the record. The requirements differed:
- **Manager:** prefer a member relay of the same server over the project relay, so calls keep working when our relays are down or gone. The project relay is the last resort, as for messages.
- **dev-sync:** member relays as they stand don't fit media.
  - Each 120 s circuit is charged its full 8 MiB, so a relayed call costs about 240 MiB/h of the helper's `daily_cap_mb` (2 GB a day is about 8 call-hours), against roughly 18 MB/h actually carried.
  - Every 120 s brings a forced switch, which A3's make-before-break handles but which is constant churn.
- **SL (non-blocking):** while relay-only is off, prefer the project relay for media, rather than reconnecting every two minutes.

The decision above follows voice-d's proposal, which the manager confirmed on 2026-11-18. The SL and TL had approved C2 before §2.4 was settled.

## 3. Relay-only and the notice

- **Calls become possible under relay-only,** on B over our relays' circuits. Peers never learn my IP; our relay does, as for chat.
- **Notice v3 ships in the same release as B (TL A8, SL B6).** Today's "relay-only turns calls off" becomes false the day B lands. The key moves to `mvs.notices.voiceIp.v3`. UX/PO write the strings, and the release gates on them. The wording should say:
  - in a call, people on your LAN may see your local address;
  - with a direct connection, people may see your IP;
  - with relay-only, they can't, but the relay sees that you're in a call and when you talk.

## 4. Accepted residuals (SL)

- **Member-relay operators:** for a pair relayed through a member relay, that member (a co-member) sees the two peer IDs, their IPs, and the timing and volume of the call. That's the same class as message sync today, and relay-only users never use member relays.
- **Metadata at any relay:** constant-rate small frames identify a call. With DTX the relay also sees *when* someone talks (TL A4). Speaking indicators already show this to co-callers, so it's new only to the relay. This goes in the threat model.
- **The project relay's budget:** it's the only always-on hop, and a member can burn their own circuit's budget. Per-circuit caps and the relay's global limits bound it.

## 5. Plan and gates

1. **Spike (voice-d), one day, on Windows (macOS if available).** Its go/no-go, written down before it runs (TL A1):
   - **Encode and decode:** WebCodecs Opus at 24 kbps, 20 or 40 ms frames, **p95 encode+decode < 10 ms** per frame.
   - **Echo:** AEC with (a) plain Web Audio playout, and (b) `MediaStreamTrackGenerator` → a local loopback `RTCPeerConnection` (`iceServers: []`, in-process, no SDP leaves) → playout. A speaker-to-mic test records which one cancels echo. **If neither does, stop and go back to the TL.**
   - **IPC:** a renderer → core → renderer frame round trip over the **existing** stdio channel at 4 peers × 25 frames/s, **p95 < 20 ms**. If it misses, the binary channel goes to SL review.
   - **Path log:** QA logs the path type per call from here on, to get a real DCUtR rate.
2. **In parallel, against the frozen contract (§2.3):**
   - **(a) dev-sync:** `/mvs/voice-media/1`: gate, caps, call binding, make-before-break, path upgrade, `path_to`, the core command and event, and CONFORMANCE. Tests:
     - two cores through a test relay;
     - a forced circuit end (small limits);
     - a relay byte tap showing no Opus in the clear;
     - a non-call member and an unbound peer getting nothing (B1);
     - relay-only staying on our relay, never direct, never a member relay (B5).
   - **(b) voice-d:** the B pipeline behind a flag. Capture → encode → `voiceFrame`; `voice.frame` → jitter buffer → playout via the spike's chosen path. Plus the C2 switch, DTX and mute, and the diagnostics path (`lan-webrtc | direct | circuit | member-circuit`, types only). Built against a loopback mock transport.
3. **QA:** the two-NAT e2e (§6).
4. **UX/PO:** notice v3, the diagnostics path wording, and release notes naming the tested network types (#499).
5. **The flag goes on by default only after 3 and 4.**

**Reviews:** SL for the stream gate, the IPC surface and the metadata; TL for everything; PO and UX accept the UI.

## 6. How the two-NAT e2e proves it (#505, adapted)

The two-router topology stays: MASQUERADE homes, internal Docker networks, a throwaway relay. The coturn container goes.

| Scenario | Setup | Expected |
| --- | --- | --- |
| **N-P2P-1: two homes** | MASQUERADE routers | B. The path is `direct` after a punch, or `circuit`. Audio energy arrives (V2.2). Setup p95 < 10 s (G81.2), measured to the first audio. No RTCPeerConnection is created (not LAN). |
| **N-P2P-2: UDP blocked between homes** | `BLOCK_PEER_UDP=1` | B over the circuit, audio arrives, path `circuit`. |
| **N-P2P-3: relay-only** | One side relay-only | B over our relay only, path `circuit`. No RTCPeerConnection and no candidates on that side (G81.5). |
| **N-P2P-4: circuit end** | The test relay with small `MAX_CIRCUIT_BYTES` / `MAX_CIRCUIT_SECS` (test relay only) | Make-before-break: the call continues, with the received-audio gap < 1 s and no teardown. |
| **N-P2P-5: same LAN** | Both apps on one LAN | `lan-webrtc` (G81.1 host → host), as today. |

QA's hooks (#500: G81.3, G81.4, G81.5) carry over. One more is needed: the media path read from the diagnostics panel, types only.

## 7. Security Lead criteria

| Criterion | Answer |
| --- | --- |
| **Who learns which IP** | **LAN WebRTC:** LAN co-callers learn my LAN address, and only peers the core already sees on my LAN get host candidates (B4), which is less than today. **B direct after DCUtR:** the co-caller learns my public IP (as for any direct member connection today). **B on our relay:** the relay learns both IPs (as for chat), and co-callers learn nothing. **B on a member relay:** that member sees both IPs and the call's timing (residual §4). |
| **#497 still true; relay-only = no direct path** | Relay-only: no WebRTC, no candidates, no DCUtR, no member relays, B on our relays only. #497's text becomes false when B ships, so v3 ships in the same release (§3). |
| **Members only, both ways** | B1: bound key (GAP-4), current non-kicked member, participant in my current call, for both opening and accepting. |
| **No new crypto crates** | None. Noise as today, and no frame key because nothing forwards. |
| **A: no open reflector** | A is rejected, and A0 isn't in v1. No reflector exists. |
| **B: Noise end to end over the circuit** | Yes. A circuit is a transport with Noise between the cores, and a sync test taps the relay's bytes. |
| **B: frame key if anyone forwards** | Nobody forwards (a full mesh, one stream per pair). A forwarder would need an SFrame-like key from the channel key with a new label, plus review. Refused for now. |
| **B: relay budget (R11)** | Both directions summed: about 18 MB/h at 16 kbps (relayed default, less with DTX), about 30 MB/h at 24 kbps, under 32 MiB. Make-before-break before the cut, no `MAX_CIRCUIT_*` change, the mesh ≤ 8. Member relays carry media via a voice circuit class charged by actual bytes (§2.4). |
| **B: frames bound to call, sender and sequence** | The frozen frame (§2.3). The sender comes from the bound stream. A wrong call, a duplicate or stale seq, or a bad length is dropped or closes the stream. Rate and size caps, jitter buffer ≤ 200 ms. |
| **B: metadata** | Relays see two peer IDs, timing and volume, and with DTX when someone talks (§4). It goes in the threat model and notice v3. |
| **C: a peer can't force a direct path under relay-only** | My engine decides (§2.2). Under relay-only, no RTCPeerConnection, candidates, DCUtR or member relays exist, so an offer is ignored. |
| **IPC surface** | A narrow fire-and-forget command plus one event, `fromUs` and active-call only, same caps (B3). The stdio channel unless the spike fails its target. |
