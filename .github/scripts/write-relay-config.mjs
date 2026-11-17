// Writes the desktop app's build-time config from the environment, for the
// release workflow; dependency-free.
//
//   RELAY=/dns4/<host>/tcp/443/wss/p2p/<peer id> \
//   RELAY_TCP=/dns4/<tcp host>/tcp/4001/p2p/<peer id> \
//   node write-relay-config.mjs <out.json>
//
// Multi-relay (part A): RELAYS and RELAYS_TCP are lists, one multiaddr per
// line, 1-4 relays, no relay (peer ID) twice; RELAYS_TCP pairs with RELAYS by
// order. RELAYS wins over RELAY, and RELAYS_TCP over RELAY_TCP; the singles
// stay as the fallback.
//
// Output: {"relay": ..., "relays": [...], "bootstrap": [...], "stun": ...}; each key
// only when its variable is set ({} for none). With RELAYS, "relay" is its
// first entry. bootstrap is a plain-TCP route to the relay, so the relay can
// observe clients' public addresses (DCUtR, #219).
//
// On Windows runners, run it with MSYS2_ENV_CONV_EXCL=RELAY (a prefix, so it
// covers RELAY_TCP too): Git Bash otherwise rewrites "/dns4/..." into
// "C:/Program Files/Git/dns4/..." for native programs.
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: write-relay-config.mjs <out.json>");
  process.exit(2);
}

function checked(name, value) {
  if (!value.startsWith("/") || /\s/.test(value) || value.length > 512) {
    console.error(`::error::${name} is not a multiaddr (starts with /, no spaces, at most 512 chars)`);
    process.exit(1);
  }
  // Pinned by peer ID: without /p2p/<id>, Noise would accept whoever answers
  // at that address.
  if (!/\/p2p\/[1-9A-HJ-NP-Za-km-z]{46,60}$/.test(value)) {
    console.error(`::error::${name} must end in /p2p/<relay peer id>`);
    process.exit(1);
  }
  return value;
}

// STUN server for voice (stun:<host>:<port>): our own, so no third party sees
// users' IPs. A hostname or IP, then a port; nothing else (no query, no
// credentials: STUN-only needs none).
function stunUrl(value) {
  const m = /^stun:([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\]):(\d{1,5})$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    console.error("::error::the STUN URL must be stun:<host>:<port>");
    process.exit(1);
  }
  return value;
}

const MAX_RELAYS = 4;
const peerId = (addr) => addr.slice(addr.lastIndexOf("/p2p/") + 5);

// A list variable: one multiaddr per line (blank lines and surrounding
// spaces ignored), each checked, at most MAX_RELAYS, no peer ID twice. Errors
// name the line number only, never the address.
function checkedList(name, text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_RELAYS) {
    console.error(`::error::${name}: at most ${MAX_RELAYS} entries`);
    process.exit(1);
  }
  const seen = new Set();
  return lines.map((line, i) => {
    const addr = checked(`${name}, line ${i + 1},`, line);
    if (seen.has(peerId(addr))) {
      console.error(`::error::${name}, line ${i + 1}: the same relay twice`);
      process.exit(1);
    }
    seen.add(peerId(addr));
    return addr;
  });
}

const config = {};
const relays = process.env.RELAYS ? checkedList("the relay list", process.env.RELAYS) : [];
if (relays.length) {
  config.relay = relays[0];
  config.relays = relays;
} else if (process.env.RELAY) {
  config.relay = checked("the relay address", process.env.RELAY);
}
const tcp = process.env.RELAYS_TCP ? checkedList("the TCP bootstrap list", process.env.RELAYS_TCP) : [];
if (tcp.length) {
  if (relays.length && tcp.length > relays.length) {
    console.error("::error::the TCP bootstrap list is longer than the relay list (they pair by order)");
    process.exit(1);
  }
  config.bootstrap = tcp;
} else if (process.env.RELAY_TCP) {
  config.bootstrap = [checked("the TCP bootstrap address", process.env.RELAY_TCP)];
}
if (process.env.STUN) config.stun = stunUrl(process.env.STUN);
writeFileSync(out, JSON.stringify(config));
console.log(config.relays ? `${config.relays.length} relays configured` : config.relay ? "relay configured" :"::warning::no relay address in this build: the app will run offline");
console.log(config.bootstrap ? "TCP bootstrap configured" : "no TCP bootstrap address in this build");
console.log(config.stun ? "STUN configured" : "no STUN server in this build");
