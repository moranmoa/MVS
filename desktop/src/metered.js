// Member relays, slice 3a: is this computer on a metered connection? The
// core turns member relaying off while it is (reason "metered"). Main asks at
// start, every 60 s and when the network changes, and tells the core with
// setMetered (a shell-only command: the page can't set it).
//
// Fails open for this flag only: any error, timeout or unknown answer means
// "not metered". The relay still needs every other condition.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** How often to ask, and how often to look for a network change. */
const CHECK_EVERY_MS = 60_000;
const NETWORK_POLL_MS = 5_000;
/** A query that doesn't answer in time counts as not metered. */
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Windows: the internet connection profile's cost, through WinRT in Windows
 * PowerShell (no native module). Prints "<NetworkCostType>|<Roaming>|<OverDataLimit>",
 * or "none" without an internet profile.
 */
const WINDOWS_SCRIPT =
  "$p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile();" +
  "if($p){$c=$p.GetConnectionCost();\"$($c.NetworkCostType)|$($c.Roaming)|$($c.OverDataLimit)\"}else{'none'}";

/** Windows' answer: Fixed or Variable cost, or roaming, or over the data limit. */
function parseWindows(out) {
  if (typeof out !== 'string') return false;
  const parts = out.trim().split('|');
  if (parts.length !== 3) return false;
  const [cost, roaming, over] = parts.map((p) => p.trim().toLowerCase());
  return cost === 'fixed' || cost === 'variable' || roaming === 'true' || over === 'true';
}

/**
 * Linux: NetworkManager's Metered property (NMMetered, for the primary
 * connection), read with gdbus. gdbus prints e.g. "(<uint32 4>,)".
 * 1 = yes and 3 = guess-yes are metered; 0 unknown, 2 no, 4 guess-no aren't.
 */
const LINUX_ARGS = [
  'call', '--system', '--timeout', '5',
  '--dest', 'org.freedesktop.NetworkManager',
  '--object-path', '/org/freedesktop/NetworkManager',
  '--method', 'org.freedesktop.DBus.Properties.Get',
  'org.freedesktop.NetworkManager', 'Metered',
];

function parseLinux(out) {
  if (typeof out !== 'string') return false;
  const m = /^\(<uint32 (\d+)>,\)$/.exec(out.trim());
  return !!m && (m[1] === '1' || m[1] === '3');
}

/** The query for this platform, by absolute path (no PATH lookup), or null (macOS: never metered in v1). */
function queryFor(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform === 'win32') {
    const exe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: exe, args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], parse: parseWindows };
  }
  if (platform === 'linux') {
    const exe = ['/usr/bin/gdbus', '/bin/gdbus'].find((p) => exists(p));
    return exe ? { file: exe, args: LINUX_ARGS, parse: parseLinux } : null;
  }
  return null;
}

/** Runs a program, no shell, short timeout and small output; resolves its stdout. */
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: 16 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

/** Metered now? Never rejects: any failure is false. */
async function checkMetered({ query = queryFor(), exec = run } = {}) {
  if (!query) return false;
  try {
    return query.parse(await exec(query.file, query.args)) === true;
  } catch {
    return false;
  }
}

/** A key that changes when the network does (addresses up or down). */
function networkKey(ifaces = os.networkInterfaces()) {
  return Object.entries(ifaces || {})
    .flatMap(([name, list]) => (list || []).filter((a) => !a.internal).map((a) => `${name}/${a.family}/${a.address}`))
    .sort()
    .join(',');
}

/**
 * Asks now, every 60 s and when the network changes; calls onChange(metered)
 * with the first answer and whenever it differs. Returns { stop, current }.
 */
function watchMetered({ onChange, check = checkMetered, interfaces = () => os.networkInterfaces(), every = CHECK_EVERY_MS, poll = NETWORK_POLL_MS, timers = { setInterval, clearInterval } }) {
  let last = null;
  let busy = false;
  let stopped = false;
  let key = networkKey(interfaces());
  const ask = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = (await check()) === true;
      if (!stopped && now !== last) {
        last = now;
        onChange(now);
      }
    } finally {
      busy = false;
    }
  };
  const t1 = timers.setInterval(ask, every);
  const t2 = timers.setInterval(() => {
    let next;
    try {
      next = networkKey(interfaces());
    } catch {
      return;
    }
    if (next !== key) {
      key = next;
      void ask();
    }
  }, poll);
  void ask();
  return {
    stop() {
      stopped = true;
      timers.clearInterval(t1);
      timers.clearInterval(t2);
    },
    /** The last answer, or false before the first. */
    current: () => last === true,
  };
}

module.exports = { CHECK_EVERY_MS, NETWORK_POLL_MS, WINDOWS_SCRIPT, LINUX_ARGS, parseWindows, parseLinux, queryFor, checkMetered, networkKey, watchMetered };
