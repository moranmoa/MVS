# G-81: voice calls across networks over the P2P network only

- **Status:** draft for review (SL, TL). Written by voice-d and dev-sync. The network side is dev-sync's (`dev-sync-g81-network-side.md` in the shared notes, folded in here). It supersedes the STUN/TURN path in `voice-across-networks.md` (#333) for the release plan; #433 (TURN) stays a draft.
- **Owner's decision (2026-11-18):** "all the app needs to work without server so make it work with the decentralized network." There's no project STUN or TURN and no public STUN, so `MVS_STUN_URL` stays unset. What we have is the libp2p network the app already runs: our relays, member relays (#368), hole punching between members (DCUtR, #219/#184), and the LAN beacon (#460).
- **Review criteria:** `sec-lead-g81-p2p-calls-criteria.md` (shared notes). §7 answers each one.

## 1. Where we are

**Voice today:**
- **Same LAN:** works. WebRTC with host candidates (`default_public_and_private_interfaces`), DTLS pinned to the signed fingerprint, signalling over `/mvs/voice/1`. That protocol is members only, 5/s per peer, 10/s overall, 16 KiB.
- **Different networks:** no call. Without STUN the browser has no server-reflexive candidate, and the UI shows "אין חיבור קולי" after the connect timeout.
- **Relay-only:** no calls (the core refuses; the engine refuses on its own too, #496 S1).

**The network side, which already crosses networks for chat:**
- **Authenticated member connections.** Every member pair reaches each other through relay v2 circuits on up to 4 of our relays (#477), then often directly: DCUtR, members-only (`punch.rs`: GAP-4 binding + read gate), over TCP and QUIC. On one LAN, the LAN beacon finds them.
  - Every one of these is a Noise session **end to end between the two cores**. A circuit is a transport, and the inner connection is upgraded with Noise between the endpoints, so relays see ciphertext only.
- **Observed addresses.** identify tells each core the IP and port its relays and members see it on. They're filtered to dialable, global addresses (`announce.rs`, `punch.rs`), so this is a built-in, members-only "who am I from outside", and it's what DCUtR already uses.
- **Path per member.** The node knows whether each peer is connected directly (punched or LAN) or only relayed.
- **Relay limits:**
  - **Our relays (R11):** 256 circuits, 8 per peer, **1 h and 32 MiB per circuit, both directions summed** (libp2p-relay 0.21.1 keeps one counter). New circuits: 30, then one every 2 min per peer. At the cut, the circuit closes with every stream on it, and renewing a reservation never extends an existing circuit.
  - **Member relays:** 8 reservations, 16 circuits, **120 s and 8 MiB per circuit**. Each circuit is charged its full 8 MiB against `daily_cap_mb` (default 2,048).
- **relay-only.** It drops direct listeners and closes the punch gate (GAP-6), so a relay-only core has no direct path to anyone.
- **DCUtR success rate:** not measured. #219 proved it works in tests and in the 0.2.5 smoke (hotspot, relay → direct), but there's no QUIC, TCP or Windows rate. **Direct is opportunistic; nothing here is designed around a rate.** QA can log the path per call to measure it (§6).

## 2. Options

### A0. No helper: synthetic srflx from libp2p-observed addresses

The core gives the engine its public IPv4 as members and relays see it (`my_public_ipv4s()`, at most 2, global only). The engine adds, to the SDP it sends, a **remote-usable srflx candidate**: that IP with the host candidate's port (`typ srflx raddr <host> rport <port>`). Many home NATs keep the source port (endpoint-independent mapping). When both sides send ICE checks to each other's synthetic candidate, that's an ordinary UDP hole punch, with no STUN at all.

- **Works:** both NATs port-preserving and endpoint-independent (common in home routers).
- **Fails:** symmetric NAT, carrier-grade NAT, and port-changing NATs. It then falls back (C).
- **Attack surface:** no new protocol, no reflector, nothing to abuse. The IP goes only into SDP sent to members of my call, which is the same exposure as any direct path today, covered by #497. DTLS pinning is unchanged.
- **Relay-only:** under relay-only, no WebRTC and no candidates at all (#496 S1).

### A. Peer STUN on cores: a member answers binding requests

Chromium sends plain, unauthenticated STUN binding requests to a `stun:` URL. A helper member would therefore be answering raw UDP. To meet "never an open reflector", it could:
- answer only source IPs that currently hold an authenticated libp2p connection to it as a bound member of a shared server;
- rate-limit per IP and globally;
- drop anything larger than a minimal binding request. The response (about 32 B, XOR-MAPPED-ADDRESS) is still up to about 1.6× the request (20 B), only toward members.

**Problems:**
- A helper behind NAT can't receive the asker's UDP until a mapping exists (chicken and egg), so only members with public UDP, which is rare, can help.
- The helper learns when I'm about to call.
- It's the most code and abuse surface for the least gain over A0.

**Skipped.** We'd revisit only if A0 data (§6) showed many port-changing NATs.

### B. Media over libp2p: Opus frames on the existing connection

A new **`/mvs/voice-media/1`** stream between two in-call members, over whatever connection exists: direct after DCUtR, LAN, or our relay's circuit. It works whenever chat works.

- **Pipeline:**
  - The renderer encodes Opus with WebCodecs `AudioEncoder` (Electron's Chromium) from the existing capture (echo cancellation, noise suppression, gain).
  - The core carries the frames.
  - The receiver decodes with `AudioDecoder` into a bounded jitter buffer, then into the existing Web Audio graph (per-peer gain, deafen, speaking meter).
- **Frame:** `call_id(16) ‖ seq(u32) ‖ ts(u32) ‖ opus`.
  - Accepted only from a bound member who is in my current call; the api tells sync the call's member set, as for `/mvs/voice/1`.
  - `seq` strictly increases per (call, sender), so late frames are dropped and duplicates ignored.
  - The jitter buffer is capped at 200 ms. The stream's frame rate and size are capped.
- **Budget (R11):**
  - **Cost:** Opus 24 kbps in 40 ms frames is about 3 KB/s of audio plus about 1.2 KB/s of framing (yamux, Noise, header, at 25 frames/s), about 4.2 KB/s per direction. That's **about 29 MiB/h for a 1:1 call on one circuit**, both directions summed: just under R11's 32 MiB. 32 kbps doesn't fit.
  - **Bitrate rule:** 24 kbps on relayed paths, full quality on direct ones.
  - **Circuit refresh:** sync opens a fresh circuit before the 1 h or 32 MiB cut (make-before-break) and moves the stream.
  - **Meshes:** one circuit per pair, so 4 per peer in a 5-person call, within 8 per peer.
  - **Relay load:** about 0.8 MB/s each way for 100 relayed pairs, which devops should size for.
- **Member relays are not used for media.** A 120 s circuit means a forced switch every 2 minutes, and about 240 MiB/h charged against `daily_cap_mb` for a call that uses about 29 MiB. A voice class charged by bytes actually used would be a `member_relay.rs` change with SL review: later, if ever.
- **Path changes.** When a direct connection replaces the relayed one, the relayed one stays parked but open (#206). Sync moves the media stream to the direct one, and back if direct dies. The api sees one logical media channel per call peer.
- **Quality:** a stream over TCP stalls on loss (head-of-line blocking), and rust-libp2p 0.56 has no QUIC datagrams, so frames ride a stream even over QUIC. QUIC to the relay (#220, `/udp/4001/quic-v1`) helps a lot. Expect latency roughly 150–250 ms mouth-to-ear relayed, and worse than WebRTC over UDP on lossy links.
- **IPC.** 25–50 frames/s per peer is too much for the shared JSON-lines stdio, where frames would queue behind big responses. A **dedicated binary channel** is needed: a second pipe or fd from the desktop main to the core with length-prefixed frames, then a `MessagePort` to the renderer. That's a desktop and dev-identity item.

### C. Hybrid

1. **Every call starts on B** over whatever connection exists: at once, and it always works when chat works.
2. **In parallel, WebRTC tries a direct path** with host candidates plus A0's synthetic srflx. That covers the same LAN, port-preserving NATs, and pairs DCUtR has already punched.
3. **If ICE connects within 10 s,** audio moves to WebRTC and B's stream closes, which saves relay budget and gets WebRTC's UDP media. If WebRTC later fails (ICE restart gives up, #469), audio moves back to B rather than ending the call.
4. **Downgrade rule:**
   - Each side decides only for itself.
   - A relay-only side never creates an RTCPeerConnection and never sends host or srflx candidates, so it never accepts a punch. The call simply stays on B over our relay, and the other side can't force a direct path.
   - Neither side can make the other use a member relay for media.

## 3. Comparison

| | A0 alone | A (peer STUN) | B alone | **C (B + WebRTC with A0)** |
| --- | --- | --- | --- | --- |
| Crosses port-preserving NATs | Yes | With a reachable helper | Yes | Yes |
| Symmetric NAT / CGNAT | No | No | Yes (circuit) | Yes (circuit) |
| Relay-only users can call | No | No | Yes, circuit only | Yes, circuit only |
| New attack surface | None | A UDP reflector on members | A members-only stream | Same as B |
| Quality | WebRTC | WebRTC | Good direct, fair relayed | WebRTC whenever it connects, else B |
| Relay cost | None | None | Every relayed pair | Only pairs WebRTC can't connect |
| Work | Small | Medium + brittle gating | Large | B + A0 + a switch |

## 4. Relay-only

- **Calls become possible under relay-only,** on B over our relay's circuits only. Peers never learn my IP, and our relay does, as it already does for messages.
- **No DCUtR and no WebRTC:** `punch.rs` already refuses punches, and the engine creates no RTCPeerConnection (#496 S1).
- **New metadata at the relay:** it sees that two peer IDs exchange a steady ~4 KB/s flow, when it starts and when it stops. That goes in the threat model, and in the notice.
- **#497's notice needs a v3 when B ships.** Today's "relay-only turns calls off" becomes something like: "In a call, the people in it may see your IP when computers connect directly. With relay-only on, calls go through the relay: they can't see it, but the relay sees that you're in a call." That's a UX/PO item.

## 5. Recommendation

**C: start on B, upgrade to WebRTC (host + A0) when it connects, skip A.** Of the options, it alone:
- connects every pair that can chat, including symmetric NAT and CGNAT, with no server beyond our own relays;
- keeps WebRTC's quality wherever a direct path exists;
- spends relay budget only on pairs that need it;
- lets relay-only users call;
- adds no reflector.

**Spike first (voice-d, about 1 day):**
- WebCodecs Opus encode and decode in our Electron.
- Echo cancellation with Web Audio playout on Windows and macOS. This is the main risk: Chromium's AEC may not see audio that isn't WebRTC playout. The fallback inside B is to play decoded audio through a `MediaStreamTrackGenerator` on a local loopback RTCPeerConnection, so the AEC sees it. Measure both.
- Frame IPC latency through a binary pipe.

**Effort:**

| Piece | Owner | Size |
| --- | --- | --- |
| A0: `my_public_ipv4s()` from identify, plus tests | dev-sync | S (½ day) |
| `path_to(member) -> Direct, Lan, Relayed or None` | dev-sync | S (¼ day) |
| B: `/mvs/voice-media/1` with the in-call member gate, frame header and seq checks, rate and size caps, make-before-break circuit refresh, relay-only rules. Tests: two cores through a test relay, a 1 h cut simulated with small limits, and a byte tap showing the relay never sees Opus in the clear. | dev-sync | M–L (3–4 days) |
| api `media_open / media_send / on_media` and the binary IPC channel (desktop main ↔ core, MessagePort to the renderer) | dev-identity / desktop | M |
| Engine: the Opus pipeline, jitter buffer, B ↔ WebRTC switch, A0 candidates, diagnostics path type (types only) | voice-d | L |
| Relay sizing for media, and QUIC on #220 | devops | — |
| Notice v3, threat-model metadata entry | UX/PO, SL | S |

## 6. How the two-NAT e2e proves it (PR 2, #505)

The two-router topology (MASQUERADE homes, internal Docker networks, a throwaway relay) stays. The coturn container goes, since there's no STUN in this design, and a pair of scenarios replaces it.

| Scenario | Routers | Expected |
| --- | --- | --- |
| **N-P2P-1: port-preserving NAT** | MASQUERADE (keeps ports) | The call connects on B at once, then moves to WebRTC via A0 (G81.1 `direct (host -> srflx)` or prflx). Audio flows (V2.2). Setup p95 under 10 s (G81.2), measured to the first audio, not to WebRTC. |
| **N-P2P-2: symmetric NAT** | MASQUERADE `--random` (random ports) | WebRTC never connects. The call stays on B over the circuit, with audio flowing and the path type `relayed`. |
| **N-P2P-3: UDP blocked between homes** | `BLOCK_PEER_UDP=1` | The call is on B over the circuit (TCP to the relay). No direct path. |
| **N-P2P-4: relay-only** | Either | No RTCPeerConnection on the relay-only side (QA's G81.5 hook shows no candidates). The call works on B over the circuit. |
| **Budget** | Small relay limits (`MAX_CIRCUIT_BYTES` and `MAX_CIRCUIT_SECS`, reduced) | The circuit is refreshed make-before-break, with a gap under 300 ms in the received audio. |

QA's call.mjs hooks (#500: G81.3 no-connect, G81.4 diagnostics, G81.5 candidate types) carry over. One more hook is needed: the media path (`webrtc` / `b-direct` / `b-relayed`) read from the diagnostics panel, types only.

## 7. Security Lead criteria

| Criterion | Answer |
| --- | --- |
| **Who learns which IP** | **WebRTC on the LAN:** co-callers on the LAN learn my LAN address (today). **WebRTC via A0, and B direct after DCUtR:** the co-caller learns my public IP, the same as today's direct paths, which #497 covers. **B over our relay:** the relay learns both IPs (it already does for chat), and co-callers learn nothing. **Member relays:** not used for media. No new party learns an IP. |
| **#497 still true; relay-only means no direct path** | Yes. Under relay-only there's no WebRTC, no candidates, no DCUtR, and B runs on circuits only. #497's "relay-only turns calls off" becomes stale when B ships, so v3 is planned (§4), with the relay-metadata line. |
| **Members only, both ways** | `/mvs/voice-media/1` uses the bound-member + read-gate check of `/mvs/voice/1` and `punch.rs`, plus the in-call member set, both for opening and for accepting. A0's IP goes only into SDP signalled to members of my call. |
| **No new crypto crates** | None. Noise as today. No frame key, because nothing forwards. |
| **A: no open reflector, members-only, response ≤ request, rate limits, DTLS pinning** | A is skipped. A0 needs no reflector. If A is ever built: the member-IP allowlist, a response ≤ about 1.6× the request and only to members, per-IP and global caps. DTLS pinning is unchanged everywhere. |
| **B: Noise end to end over the circuit** | Yes. A relay v2 circuit is a transport, and the two cores run Noise over it. The sync tests include a test relay with a byte tap asserting that no Opus is seen in the clear. |
| **B: frame key if anyone forwards** | Nobody forwards: a full mesh, one stream per pair. A forwarder (SFU-like) would need a frame key from the channel key with a new label, plus a design review. Refused for now. |
| **B: relay budget (R11)** | About 29 MiB/h for 1:1 at 24 kbps (both directions summed), under 32 MiB, with make-before-break refresh before the cut. No media on member relays. Load is about 4.2 KB/s per direction per relayed pair, and devops sizes the relay. |
| **B: frames bound to call, sender, sequence** | The sender comes from the stream's bound identity. Frames are `call_id ‖ seq ‖ ts ‖ opus`. A wrong call, a non-member, a duplicate or a stale seq is dropped. The jitter buffer is ≤ 200 ms, with rate and size caps. |
| **B: metadata** | The relay sees two peer IDs, a steady ~4 KB/s, start and end: who calls whom and for how long. This goes into the threat model and notice v3. It's the same class as chat metadata, but more telling (calls are recognizable). |
| **C: a peer can't force a direct path under relay-only** | Each side decides for itself. A relay-only side creates no RTCPeerConnection and sends no candidates (#496 S1), and refuses punches (`punch.rs`). The call stays on B over the relay. Nobody can steer the other onto a member relay. |
| **What the core exposes** | `my_public_ipv4s()` (to the engine only, into SDP; never shown as text, and the UI shows types only), `path_to()`, and `media_*`. No NAT-type probe or AutoNAT service, which would probe for non-members. |
