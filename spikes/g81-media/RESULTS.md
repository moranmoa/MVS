# G-81 spike results (2026-11-18, Windows 11, Electron 44.7.0 / Chrome 152)

Go/no-go from docs/design/g81-p2p-calls.md §5 (TL A1).

| Measure | Target | Result | Verdict |
| --- | --- | --- | --- |
| WebCodecs Opus encode+decode, 24 kbps, 40 ms frames, fed in real time (750 frames) | p95 < 10 ms | encode p95 1.2 ms, decode p95 0.3 ms, encode-to-decoded p95 1.1 ms (p99 1.3) | **pass** |
| Opus frame size at 24 kbps, 40 ms, DTX on | ≤ 400 B (contract) | p50 108 B, max 119 B | **pass** |
| Frame round trip renderer → main → stdio JSON child → main → renderer, 4 peers × 25 fps, 20 s | p95 < 20 ms | p95 0.9 ms (p99 1.1, max 8.5), 0 lost | **pass** |
| Same, with a ~1 MB reply line on the same pipe every 2 s | p95 < 20 ms | p95 1.5 ms (p99 3.6, max 13.9), 0 lost | **pass** |
| AEC with speakers: Web Audio playout vs loopback RTCPeerConnection playout | echo removed | **not run**: it plays sound out loud; waiting for the owner's OK. No virtual or loopback audio device on this PC for a silent run. | **open** |

## Caveat for the build (IPC)

The IPC numbers use a stand-in child that answers each line at once. The
real mvs-core serves stdio requests **one at a time** (`core/api/src/sidecar.rs`,
`serve`): a slow command (a join waiting up to `FIRST_FETCH_WAIT` = 5 s, a big
message page) holds every `voiceFrame` queued behind it. The pipe itself is
fast enough; the core's serial loop is not, for media. The contract needs
`voiceFrame` handled on a fast path that never waits behind other commands
(for example, `serve` hands `voiceFrame` straight to the network thread
without going through `Core::handle_value`), or a separate channel. That's
a dev-sync / dev-identity item, and a TL/SL decision.

## How to run

    electron spikes/g81-media/main.js codec|ipc|aec

A throwaway profile each time. `aec` plays sound out loud and asks for the microphone.
