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

## Pipeline smoke test (silent, real WebCodecs)

`electron spikes/g81-media/main.js pipeline` (build first: `ui/node_modules/.bin/esbuild spikes/g81-media/pipeline.ts --bundle --format=iife --outfile=spikes/g81-media/pipeline.bundle.js`). The real `ui/src/voice/media` MediaSession, a synthetic oscillator as the mic, a loopback with 20-80 ms jitter and 2% loss, and output to a MediaStreamDestination (never the speakers). 10 s: 250 frames sent (25 fps), 0 oversize; 246 delivered, 244 played, 3 missing; the jitter target settled at 120 ms; decoded audio reached the output. It caught two bugs fixed in the module: a stereo track failed the mono encoder silently (now downmixed, and send errors show in stats).

## AEC speaker test, run 1 (2026-11-25, owner approved): inconclusive

`electron spikes/g81-media/main.js aec`, a throwaway profile, Electron 44.7.0.

- **Devices:** the default output was **Bluetooth earbuds (OnePlus Buds 4)**; the input was the USB PnP microphone.
- **Result:** the test sound never reached the mic. Even with AEC off, the mic level while playing matched the room:

| Path | Room RMS | While playing RMS | Echo above room |
| --- | --- | --- | --- |
| Web Audio, AEC off | 0.00293 | 0.00266 | -0.8 dB |
| Web Audio, AEC on | 0.00273 | 0.00186 | -3.4 dB |
| Loopback RTCPeerConnection, AEC off | 0.00272 | 0.00236 | -1.2 dB |
| Loopback RTCPeerConnection, AEC on | 0.00239 | 0.00198 | -1.7 dB |

With no echo to cancel, the "attenuation" figures (3.1 dB and 1.5 dB) are noise. **No decision.**

**Rerun needed:** playback must go to audible speakers. The candidates on this PC are the VG27A monitor (HDMI) and Digital Output; the harness can target one with `setSinkId` without changing the system default. Headphones don't test echo at all. With headphones there is no echo, so they're the safe case for any playout path.
