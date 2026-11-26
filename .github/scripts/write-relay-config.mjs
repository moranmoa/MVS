// Writes the desktop app's build-time config from the environment, for the
// release workflow; dependency-free.
//
//   RELAY=/dns4/<host>/tcp/443/wss/p2p/<peer id> \
//   RELAY_TCP=/dns4/<tcp host>/tcp/4001/p2p/<peer id> \
//   node write-relay-config.mjs <out.json>
//
// Multi-relay: RELAYS and RELAYS_TCP are lists, one multiaddr per line or
// comma-separated (or both). RELAYS wins over RELAY, and RELAYS_TCP over
// RELAY_TCP; the singles stay as the fallback.
// - relays (part A): 1-4, no relay (peer ID) twice, each
//   /<host>/tcp/<port>[/ws|/wss]/p2p/<id> or /<host>/udp/<port>/quic-v1/p2p/<id>;
// - bootstrap (part C): 1-4 (the clients' MAX_BOOTSTRAP), each plain TCP
//   /<host>/tcp/<port>/p2p/<id> or QUIC /<host>/udp/<port>/quic-v1/p2p/<id>,
//   at most one per relay and transport, so a relay can have TCP and QUIC;
// - the two must agree: every bootstrap entry belongs to a configured relay,
//   and every configured relay has at least one bootstrap entry (when a
//   bootstrap is set at all).
// Any mismatch fails the build. Errors name an entry's position, never the
// address. <host> is /dns4|/dns6|/dns|/ip4|/ip6 followed by the name or IP.
//
// Output: {"relay": ..., "relays": [...], "bootstrap": [...], "stun": ...,
// "abuseAddress": ...} (ABUSE_ADDRESS, G-48); each key
// only when its variable is set ({} for none). With RELAYS, "relay" is its
// first entry. bootstrap is a direct (non-wss) route to the relays, so they
// can observe clients' public addresses (DCUtR, #219).
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

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function checked(name, value) {
  if (!value.startsWith("/") || /\s/.test(value) || value.length > 512) {
    fail(`${name} is not a multiaddr (starts with /, no spaces, at most 512 chars)`);
  }
  // Pinned by peer ID: without /p2p/<id>, Noise would accept whoever answers
  // at that address.
  if (!/\/p2p\/[1-9A-HJ-NP-Za-km-z]{46,60}$/.test(value)) {
    fail(`${name} must end in /p2p/<relay peer id>`);
  }
  return value;
}

// STUN server for voice (stun:<host>:<port>): our own, so no third party sees
// users' IPs. A hostname or IP, then a port; nothing else (no query, no
// credentials: STUN-only needs none).
function stunUrl(value) {
  const m = /^stun:([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\]):(\d{1,5})$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) fail("the STUN URL must be stun:<host>:<port>");
  return value;
}

// G-48: where people report abuse to the app's operators (B24), shown next
// to a report about a minor. An e-mail address or an https URL, at most 254
// characters; nothing else. Never printed: the domain is private.
function abuseAddress(value) {
  const email = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,63}$/;
  const url = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~%\/-]*)?$/;
  if (value.length > 254 || !(email.test(value) || url.test(value))) {
    fail("the abuse-report address must be an e-mail address or an https URL");
  }
  return value;
}

const MAX_RELAYS = 4;
const MAX_BOOTSTRAP = 4;
const HOST = "/(?:dns4|dns6|dns|ip4|ip6)/[^/\\s]+";
const PORT = "(?:[1-9][0-9]{0,4})";
const ID = "/p2p/[1-9A-HJ-NP-Za-km-z]{46,60}";
const RELAY_FORM = new RegExp(`^${HOST}(?:/tcp/${PORT}(?:/wss?)?|/udp/${PORT}/quic-v1)${ID}$`);
const BOOTSTRAP_FORM = new RegExp(`^${HOST}(?:/tcp/${PORT}|/udp/${PORT}/quic-v1)${ID}$`);
const peerId = (addr) => addr.slice(addr.lastIndexOf("/p2p/") + 5);
const transport = (addr) => (addr.includes("/quic-v1/") ? "quic" : "tcp");
const relayRule = { max: MAX_RELAYS, form: RELAY_FORM, key: peerId };
const bootstrapRule = { max: MAX_BOOTSTRAP, form: BOOTSTRAP_FORM, key: (a) => `${peerId(a)} ${transport(a)}` };

// A list variable: multiaddrs separated by newlines and/or commas (a
// multiaddr never contains either); each entry trimmed, empty ones dropped,
// each checked against the form, at most `max`, no `key` twice.
function checkedList(name, text, { max, form, key }) {
  const entries = text.split(/[\r\n,]/).map((e) => e.trim()).filter(Boolean);
  if (entries.length > max) fail(`${name}: at most ${max} entries`);
  const seen = new Set();
  return entries.map((entry, i) => {
    const addr = checked(`${name}, entry ${i + 1},`, entry);
    if (!form.test(addr)) fail(`${name}, entry ${i + 1}: wrong form (see write-relay-config.mjs)`);
    if (seen.has(key(addr))) fail(`${name}, entry ${i + 1}: listed twice`);
    seen.add(key(addr));
    return addr;
  });
}

// The relay list and the bootstrap list must describe the same relays.
function agree(relays, bootstrap) {
  if (!relays.length || !bootstrap.length) return;
  const relayIds = new Set(relays.map(peerId));
  bootstrap.forEach((addr, i) => {
    if (!relayIds.has(peerId(addr))) fail(`bootstrap entry ${i + 1} belongs to no configured relay`);
  });
  const covered = new Set(bootstrap.map(peerId));
  relays.forEach((addr, i) => {
    if (!covered.has(peerId(addr))) fail(`relay ${i + 1} has no bootstrap entry`);
  });
}

const config = {};
const relays = process.env.RELAYS ? checkedList("the relay list", process.env.RELAYS, relayRule) : [];
if (relays.length) {
  config.relay = relays[0];
  config.relays = relays;
} else if (process.env.RELAY) {
  config.relay = checkedList("the relay address", process.env.RELAY, { ...relayRule, max: 1 })[0];
}
const boot = process.env.RELAYS_TCP ? checkedList("the bootstrap list", process.env.RELAYS_TCP, bootstrapRule) : [];
if (boot.length) {
  config.bootstrap = boot;
} else if (process.env.RELAY_TCP) {
  config.bootstrap = checkedList("the TCP bootstrap address", process.env.RELAY_TCP, { ...bootstrapRule, max: 1 });
}
agree(config.relays || (config.relay ? [config.relay] : []), config.bootstrap || []);
if (process.env.STUN) config.stun = stunUrl(process.env.STUN);
if (process.env.ABUSE_ADDRESS?.trim()) config.abuseAddress = abuseAddress(process.env.ABUSE_ADDRESS.trim());
// B24: a release build must carry the abuse-report address. REQUIRE_ABUSE_ADDRESS=1
// is set by release.yml on tag builds only; PR and dev builds stay optional.
if (process.env.REQUIRE_ABUSE_ADDRESS === "1" && !config.abuseAddress) {
  fail("a release build needs the abuse-report address: set the repository variable MVS_ABUSE_ADDRESS");
}
writeFileSync(out, JSON.stringify(config));
console.log(config.relays ? `${config.relays.length} relays configured` : config.relay ? "relay configured" : "::warning::no relay address in this build: the app will run offline");
console.log(config.bootstrap ? `${config.bootstrap.length} bootstrap address(es) configured` : "no bootstrap address in this build");
console.log(config.stun ? "STUN configured" : "no STUN server in this build");
console.log(config.abuseAddress ? "abuse-report address configured" : "no abuse-report address in this build");
