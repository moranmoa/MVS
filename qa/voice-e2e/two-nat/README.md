# G-81 two-NAT voice e2e

A call between two homes, each behind its own NAT, using only our STUN server and no TURN. It checks that STUN-only calls work across networks wherever NAT allows, and fail cleanly where it doesn't. Plan: the shared note `g81-stun-only-plan.md` §D. Security Lead conditions: `sec-lead-g81-stun-only.md` (S5, N10).

```
lan_a  a ── nat-a ┐
                  ├── wan: relay, stun (coturn --stun-only)
lan_b  b ── nat-b ┘
```

- **Routers.** `nat-a` and `nat-b` are Alpine with iptables MASQUERADE, so a port-restricted cone NAT like most home routers (`nat.sh`). They forward only LAN → WAN and its replies, never into another home's LAN.
- **Clients.** Each app's default route goes through its router (`client.sh`), so the shell gathers candidates on that one interface. The call itself is `call.mjs`, unchanged.
- **Networks.** All three are Docker-`internal`. Nothing reaches the host LAN, the internet or the live relay, and there's no host networking.
- **Caches.** The UI build's node_modules volume (`mvs-voice-e2e-nat-ui-nm`) and the desktop deps volume (`mvs-voice-e2e-nat-desktop-nm-*`) are separate from `run.sh`'s, so the two can't race.

## Scenarios

| | Command | Checks |
| --- | --- | --- |
| **N-STUN-1** | `RUNS=20 bash qa/voice-e2e/run-two-nat.sh` | Every run connects with srflx/prflx on both ends (`G81.1`), audio flows (`V2.2`), and the joiner's setup (`G81.2`) is under 10 s at p95 (PO, #426). `two-nat/verdict.mjs` reads the results. **Take timings only on a quiet host** (QA). |
| **N-STUN-2** | `SCENARIO=blocked bash qa/voice-e2e/run-two-nat.sh` | UDP between the homes is dropped (STUN still answers). Expected: "אין חיבור קולי" (peer-failed) within the 30 s connect timeout, and no relay candidate. |
| **N-STUN-3** | `SCENARIO=nostun bash qa/voice-e2e/run-two-nat.sh` | No STUN server. Expected: the diagnostics panel says STUN didn't answer (`stun-unreachable`), and the call fails cleanly. |

N-STUN-2 and N-STUN-3 run today, but their verdict needs three small `call.mjs` hooks, which QA adds in their own PR:
- `EXPECT_CONNECT=none`: expect no connection.
- `EXPECT_STUN=answered|unreachable`: read the "Connection diagnostics" panel.
- **N10:** local candidate types are only host and srflx, with one host. Types only.

Until then `verdict.mjs` reports them as SKIP.

## Privacy

- **Reports:** PASS/FAIL lines and `verdict.mjs` carry candidate types and times only. A detail that looks like an address fails the run.
- **Addresses:** the 10.81.x subnets are Docker-private and appear only in the compose file and the routers' rules.
