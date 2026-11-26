// G-81 two-NAT e2e: reads results-a.json and results-b.json of one or more
// runs (call.mjs, unchanged) and checks the STUN-only scenario. Types and
// times only; anything address-shaped in a detail fails the run.
//
//   node verdict.mjs direct <run dir>...   N-STUN-1: every run connected on a
//       srflx/prflx path (across two NATs a host path can't work), and the
//       joiner's setup time (G81.2) is under SETUP_MAX_MS at p95.
//
// Usage from run-two-nat.sh; exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenario, ...dirs] = process.argv.slice(2);
const MAX = Number(process.env.SETUP_MAX_MS || 10_000);
const ADDRESS = /\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4}:/i;
let failed = 0;
const fail = (m) => {
  failed++;
  console.log(`FAIL ${m}`);
};

if (scenario !== 'direct') {
  console.log(`SKIP N-STUN verdict for "${scenario}": needs call.mjs hooks (EXPECT_CONNECT=none, STUN check), see README`);
  process.exit(0);
}

const setups = [];
for (const dir of dirs) {
  const results = (role) => {
    try {
      return JSON.parse(readFileSync(join(dir, `results-${role}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  const run = dir.split(/[\\/]/).pop();
  for (const role of ['a', 'b']) {
    const r = results(role);
    if (!r) {
      fail(`${run} ${role}: no results`);
      continue;
    }
    for (const x of r) if (typeof x.detail === 'string' && ADDRESS.test(x.detail)) fail(`${run} ${role} ${x.id}: an address reached the report`);
    const path = r.find((x) => x.id === 'G81.1');
    if (path?.status !== 'PASS') fail(`${run} ${role}: G81.1 ${path?.status ?? 'missing'} ${path?.detail ?? ''}`);
    // Across two NATs only server-reflexive (or peer-reflexive) candidates can meet.
    else if (!/^direct \((srflx|prflx) -> (srflx|prflx)\)$/.test(path.detail)) fail(`${run} ${role}: path ${path.detail}, expected srflx/prflx on both ends`);
    if (role === 'b') {
      const s = r.find((x) => x.id === 'G81.2');
      const sec = s && /^([\d.]+) s$/.exec(s.detail ?? '');
      if (sec) setups.push(Number(sec[1]) * 1000);
      else fail(`${run} b: no setup time (G81.2 ${s?.status ?? 'missing'})`);
    }
  }
}
if (setups.length) {
  const sorted = [...setups].sort((x, y) => x - y);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const line = `setup over ${sorted.length} run(s): median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)} s, p95 ${(p95 / 1000).toFixed(1)} s (limit ${MAX / 1000} s)`;
  if (p95 > MAX) fail(`N-STUN-1 ${line}`);
  else console.log(`PASS N-STUN-1 ${line}`);
}
process.exit(failed ? 1 : 0);
