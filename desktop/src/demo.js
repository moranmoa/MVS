// T8-04: `MVS_DEMO` in a checkout runs the page on the UI's mock (sample
// servers), not on a core. Main starts no core and the app lock is off (there
// is no data to protect); the preload leaves `invoke` off `window.mvs`, so the
// UI's createCore() falls through to the mock with ?demo=<value>. The shell's
// own helpers (notifications, badge, push-to-talk, clipboard) stay, so the
// demo still exercises them. Never in a packaged build.
'use strict';

/** The renderer argument main adds (additionalArguments) in demo mode. */
const DEMO_ARG = '--mvs-demo';

/** The ?demo value the UI mock knows: '1', 'unchecked', … (short, plain). */
const DEMO_VALUE = /^[A-Za-z0-9_-]{1,32}$/;

/** The demo value, or null: never packaged, and only a plain short value. */
function demoFor({ packaged, env = process.env }) {
  if (packaged !== false) return null;
  const v = env.MVS_DEMO;
  return typeof v === 'string' && DEMO_VALUE.test(v) ? v : null;
}

/** The demo's own profile, beside (not inside) the checkout's real one. */
function demoProfile(userData) {
  return `${userData.replace(/[\\/]+$/, '')}-demo`;
}

module.exports = { DEMO_ARG, demoFor, demoProfile };
