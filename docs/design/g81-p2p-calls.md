# G-81: voice calls across networks over the P2P network only

- **Status:** draft for review (SL, TL), with dev-sync. Supersedes the STUN/TURN path in `voice-across-networks.md` (#333) for the release plan; #433 (TURN) stays a draft.
- **Owner's decision (2026-11-18):** "all the app needs to work without server so make it work with the decentralized network." There's no project STUN or TURN and no public STUN, so `MVS_STUN_URL` stays unset. What we have is the libp2p network the app already runs: the bootstrap/relay node, member relays (#368), and hole punching between members (DCUtR, #219/#184).
- **Review criteria:** `sec-lead-g81-p2p-calls-criteria.md` (shared notes). §6 answers each one.

## 1. Where we are

| | Today |
| --- | --- |
| **Same LAN** | Works. WebRTC with host candidates (`default_public_and_private_interfaces`), DTLS pinned to the signed fingerprint, signalling over `/mvs/voice/1` (members only, rate-limited). |
| **Different networks** | No call. Without a STUN server the browser has no server-reflexive candidate, so two homes behind NAT never find a path. The UI shows "אין חיבור קולי" after the connect timeout. |
| **Relay-only on** | No calls at all (the core refuses them, and the engine now refuses on its own, #496 S1). |

The libp2p side already crosses networks for messages:
- every node holds a connection to the relay (wss/TCP, QUIC beside it);
- members can hole punch to each other (DCUtR over QUIC and TCP, members-only gates, `punch.rs`);
- where punching fails, traffic goes through a circuit: the project relay (`MAX_CIRCUIT_BYTES` 32 MiB, `MAX_CIRCUIT_SECS` 3600) or a member relay (8 MiB per circuit, 120 s, renewed; a daily cap that defaults to 2 GB).

Noise runs end to end over a circuit, so a relay carries ciphertext only.

## 2. Options

### A. Peer STUN: cores answer binding requests

A member's core answers STUN binding requests on a UDP port. The engine's `iceServers` become a few members or relays that are publicly reachable, learned through the core.

- **Who can help.** A helper must receive *unsolicited* UDP from the asker's browser socket, so it needs a public, reachable UDP port: a public IP, a forwarded port or UPnP. A helper behind a NAT can't answer, and STUN can't ride on a libp2p connection, because the browser's ICE socket isn't the core's socket. In home-user servers that's rare, and nothing guarantees any member of a given server has one. The only always-reachable node is the project relay, and making it answer STUN is exactly the "project STUN" the owner ruled out.
- **Success rate.** Given a helper, srflx↔srflx works for full-cone, restricted and port-restricted NATs on both sides: roughly 70–80% of home pairs in published measurements. It fails if either side is symmetric (many mobile and CGNAT carriers). **Without a helper, which is the common case, it's 0%.** No fallback.
- **Work.**
  - A STUN responder in the core: an RFC 5389 subset, hand-written, since we add no crates.
  - Membership gating on a UDP port. Plain STUN carries no identity, so this means a short-lived token in a custom attribute, which Chromium's ICE agent won't send. In practice the gate is a source-IP allow-list fed from the members' libp2p-observed addresses, which is brittle.
  - Helper discovery and selection, and "am I reachable" detection (AutoNAT-like).
- **Risks.**
  - A UDP reflector on users' machines. Even rate-limited and answering only "allowed" sources, a source-IP gate can be spoofed for reflection (STUN responses are about the same size as requests, so the amplification is small but not zero).
  - Helpers learn the asker's IP and call times.
  - A lying helper only causes a failed call, since DTLS pinning is unchanged.
- **Proof in the two-NAT e2e.** Put a "public" member core on the WAN as the helper and expect G81.1 srflx↔srflx. That proves the mechanism, but it can't prove that real servers have a helper.

### B. Media over libp2p: Opus frames on a stream the core carries

The renderer encodes Opus (WebCodecs `AudioEncoder`, in Electron's Chromium) and hands frames to the core. The core sends them on a new `/mvs/voice-media/1` stream to each call peer, over whatever libp2p connection exists: LAN, DCUtR-punched QUIC or TCP, or a relay circuit. The receiver decodes them with `AudioDecoder` into a jitter buffer and plays them through the existing Web Audio graph (per-peer gain, deafen, speaking meter).

- **Who can talk.** Anyone who can exchange messages, i.e. every pair of members who are both online. The path follows the libp2p connection:
  - direct when on the same LAN or after a successful punch (about 70% of pairs is libp2p's own reported DCUtR rate, to be confirmed against our #219 data, Q1);
  - otherwise a circuit.
- **Success rate.** About 100% wherever signalling works today, as long as the relay budget allows (below). Quality differs by path:
  - **Direct QUIC:** UDP, no head-of-line blocking, latency comparable to WebRTC.
  - **Direct TCP or a circuit over TCP/wss:** reliable delivery. A lost packet stalls the stream (head-of-line), which the jitter buffer must absorb. That's fine on good links; on lossy ones it shows up as bursts of delay rather than gaps. We cap the buffer and drop late frames.
  - **Circuit:** adds the relay's round trip.
- **Latency budget.** About 20–40 ms frame + 20–80 ms network (direct) or + relay RTT + a 60–120 ms adaptive jitter buffer, so roughly 150 ms to 250 ms mouth-to-ear. Above WebRTC on a LAN, acceptable for chat.
- **Relay budget (R11).** At Opus 24 kbps in 40 ms frames (25 frames/s), payload is 3 KB/s per direction, and framing adds about 44 B per frame (our header, yamux, Noise): about 4.1 KB/s, or about **14.8 MB/h per direction**.
  - **Project relay:** one circuit is 32 MiB for at most an hour. If relay v2 counts both directions together (Q2), a two-way call uses about 30 MB/h and fits just under. A renewed circuit (or a new one each hour) is needed for long calls.
  - **Relayed links:** drop to 16 kbps (about 9 MB/h per direction), which is ample for speech.
  - **Member relays:** 8 MiB per 120 s circuit is plenty per circuit. But circuits end every 120 s (Q2: if renewal drops the stream, that's a reconnect every two minutes, which the stream must ride over with a sub-second gap), and each relayed call-hour costs the helper about 30 MB of its `daily_cap_mb` (2 GB default, about 65 call-hours a day).
  - **Meshes:** each pair is its own circuit. A 5-person call with every pair relayed costs 10 pairs × about 30 MB/h of relay traffic, so 300 MB/h. Fine for the project relay at our scale; members' caps protect member relays.
- **End to end.**
  - Every hop is inside the Noise session between the two members. On a circuit, relay v2 carries an end-to-end Noise handshake over the relayed stream, so the relay sees ciphertext, as for messages today.
  - There's no mixer or forwarding member (a full mesh, one stream per pair), so no plaintext audio exists outside the two endpoints, and no frame key is needed. If we ever add an SFU-like forwarder, frames get a key derived from the channel key with a new label (a design-review item then, not now).
- **Binding and replay.**
  - Each frame carries (call id, sequence, timestamp). The stream itself is bound to the peer's verified identity (GAP-4) and opened only to members of the call.
  - Frames from a stream not in my current call, from a non-member, or out of the sequence window are dropped.
  - The jitter buffer is bounded (in frames and ms), and a frame-rate cap per peer limits floods.
- **Work.**
  - **Core (dev-sync):** the stream protocol with the voice.rs gates, per-peer frame rate and size caps, call binding, and an IPC channel for frames between the core and the renderer (Q4).
  - **UI (voice-d):** an AudioWorklet capture → WebCodecs Opus encode, then decode → jitter buffer → the existing gain/deafen/meter graph; a path indicator for the diagnostics panel.
  - **Echo cancellation:** `getUserMedia`'s AEC applies to the capture. Whether Chromium cancels audio played through Web Audio (not a WebRTC track) depends on the platform. It's the biggest quality risk, and a spike must measure it on Windows before we commit.
- **Risks.**
  - Echo (above).
  - TCP head-of-line delay on lossy links.
  - IPC throughput and latency through the sidecar.
  - Relay cost.
  - A second media path to maintain beside WebRTC.
- **Proof in the two-NAT e2e.**
  - With the routers blocking UDP between the homes (today's `SCENARIO=blocked`), the call must still connect over the relay circuit, with audio energy arriving (V2.2).
  - Without blocking, the path should be a punched direct connection.
  - Setup time p95 (G81.2) and a new check on the frame path type: direct, circuit, or member circuit. Types only.

### C. Hybrid: WebRTC where it works, B everywhere else

- **C1, "peer STUN + B":** try WebRTC with a peer STUN helper (A), and fall back to B. It inherits A's helper and reflector problems for little gain, because B already gives a direct path whenever a hole punch works.
- **C2, "LAN WebRTC + B":** keep today's WebRTC on host candidates for peers on the same LAN, where it's best (AEC, jitter handling, no relay), and use B for everyone else. No STUN anywhere.

**The downgrade rule (both):**
- The caller's engine decides per peer.
- It tries WebRTC (host candidates only, as today) first, for a short time: about 3 s, or right away when the peers aren't on one LAN per the core's connection info.
- Then it switches to B on the same call.
- The peer never chooses the path for me. A peer can offer WebRTC, but my side starts it only when allowed (relay-only off, see §4), and an offer under relay-only is ignored, as the engine does today.

## 3. Comparison

| | A (peer STUN) | B (media over libp2p) | C2 (LAN WebRTC + B) |
| --- | --- | --- | --- |
| Works across NATs | Only with a reachable helper (rare); then about 75% | About 100% (direct about 70%, else circuit) | About 100% |
| Symmetric NAT / CGNAT | No | Yes (circuit) | Yes |
| Relay-only users can call | No | Yes, circuit only, no IP to peers | Yes (B part) |
| New attack surface | A UDP reflector on members | A members-only stream (like voice.rs) | Same as B |
| Quality | WebRTC | Good direct, fair relayed (TCP HOL) | Best on LAN, else B |
| Work | Medium-high, brittle gating | High (audio pipeline + stream) | B + a small switch |
| Server cost | None | Project relay for unpunchable pairs | Same as B |

## 4. Relay-only

- **B over circuits only** matches what relay-only means for messages: peers never learn my IP, and the relay does (as it already does).
- **DCUtR stays off under relay-only** (`punch.rs` already refuses), so a relay-only user can't be pulled into a direct path by a peer.
- **WebRTC is never started under relay-only.** That's the engine's S1 guard (#496), now with B as the path instead of "no call".
- **The #497 notice gets a v3 wording later.** "In a call, computers may connect directly, so the people in it can see your IP. With relay-only on, calls go through the relay and they can't." That's a UX/PO item when B ships.

## 5. Recommendation

**C2: LAN WebRTC plus media over libp2p (B) for everything else.** It's the only option that:
- crosses every NAT type without a server we don't already run;
- lets relay-only users call;
- adds no reflector.

A depends on helpers that real servers mostly don't have.

**Before building, a one-day spike:**
- WebCodecs Opus encode and decode in our Electron;
- echo cancellation on Windows and macOS with Web Audio playout;
- frame IPC latency through the sidecar.

If AEC fails on Web Audio playout, the fallback inside B is to feed decoded audio into a `MediaStreamTrackGenerator`, then play it as a stream on a local loopback `RTCPeerConnection`, so Chromium's AEC sees it as WebRTC playout. Measure that in the spike as well.

**Order:**
1. The spike.
2. dev-sync: `/mvs/voice-media/1` (gates, caps, binding, IPC).
3. voice-d: the B pipeline behind a flag, plus the C2 switch.
4. QA: the two-NAT e2e flips to "blocked UDP must still connect".
5. UX: notice v3 and the path in the diagnostics panel.

## 6. Security Lead criteria

| Criterion | Answer |
| --- | --- |
| **Who learns which IP** | **C2 on LAN:** co-callers on the same LAN learn my LAN address (as today). **B direct (punched):** the co-caller learns my public IP and port (as with any direct libp2p connection between members today). **B circuit:** the relay (project or member) learns my IP (it already does for messages); co-callers don't. No new party learns anything. |
| **#497 still true; relay-only = no direct path** | Yes. Direct paths exist only with relay-only off. Under relay-only, B runs on circuits only and WebRTC isn't started. #497's wording becomes stale ("relay-only turns calls off") when B ships, so v3 is planned (§4). |
| **Members only, both ways** | `/mvs/voice-media/1` uses the voice.rs gate. The peer is bound (GAP-4) and is a current member my read gate accepts on a server we share. The stream is opened only to members of my current call, and accepted only from them. |
| **No new crypto crates** | None. Noise (in the tree) protects frames, and WebCodecs is the browser's. A future frame key would use the existing chacha20poly1305 and blake3 derivation. |
| **A: no open reflector, members-only, response ≤ request, rate limits, DTLS pinning** | Not recommended, because a plain-STUN port can't be gated by identity (§2 A). If it's ever built: answer only sources on a members' observed-address allow-list, send a response ≤ the request, use per-source and global rate limits, never on the relay host. DTLS pinning is unchanged. |
| **B: Noise end to end over the circuit** | Yes. Relay v2 relays a raw stream, and the two peers run Noise over it, so the relay sees ciphertext (as `member_relay.rs` documents for member relays). |
| **B: frame key if anyone forwards** | Nobody forwards: a full mesh, one stream per pair. A forwarder would need a frame key (SFrame-like from the channel key, a new label) and a design review. |
| **B: relay budget (R11)** | About 14.8 MB/h per direction at 24 kbps, about 9 MB/h at 16 kbps (the relayed default). This fits the project relay's 32 MiB/h circuit for one pair (Q2: whether directions count together). Member relays: 8 MiB per 120 s circuit, charged against `daily_cap_mb`, about 30 MB per relayed call-hour. |
| **B: frames bound to call, sender and sequence** | The sender comes from the stream's bound identity. Each frame has call id + sequence + timestamp. A wrong call, a non-member, a duplicate or an out-of-window sequence is dropped. The jitter buffer and frame rate are capped. |
| **B: metadata** | Relays see the timing and volume of a call between two peer IDs (constant-rate small packets look like voice). Written down here; the same class as message metadata today. |
| **C: a peer can't force a direct path under relay-only** | My engine decides. Under relay-only it never creates an RTCPeerConnection (#496 S1), DCUtR is refused (`punch.rs`), and B uses circuits only. A peer's offer is ignored. |

## 7. Open questions (dev-sync)

1. **Q1: punching success.** Measured DCUtR success between members, QUIC vs TCP, on Windows.
2. **Q2: relay byte counting.** Does relay v2's `max_circuit_bytes` count both directions? Does a member-relay renewal (120 s) drop open streams?
3. **Q3: long-lived streams.** Any obstacle in `node.rs` to a long-lived, roughly 4 KB/s stream: yamux windows, keep-alive, parking relayed connections (#206)?
4. **Q4: the frame channel.** Renderer ↔ core: is stdio JSON through the desktop main fast enough for about 25 frames/s per peer, or is a binary side channel needed?
