// Relay-in-app R1 (docs/design/relay-in-app.md, RR2): the core never relays
// while the computer runs on battery. Main tells it the power source with
// setOnBattery (a shell-only command: the page can't set it) when the core
// comes up and whenever the source changes.
//
// Electron's powerMonitor answers: `isOnBatteryPower()` and the `on-battery`
// / `on-ac` events. Desktops without a battery read as on AC. Some Linux
// setups miss the events, so it's also read again every 60 s.
//
// Fails closed for this flag: if the power source can't be read, the answer
// is "on battery", so the core doesn't relay. That costs a relay, never a
// laptop's battery.

'use strict';

const CHECK_EVERY_MS = 60_000;

/** On battery now? Any error counts as yes. */
function readOnBattery(powerMonitor) {
  try {
    return powerMonitor.isOnBatteryPower() !== false;
  } catch {
    return true;
  }
}

/**
 * Reads now, on the power events and every 60 s; calls onChange(onBattery)
 * with the first answer and whenever it differs. Returns { stop, current }.
 */
function watchPower({ powerMonitor, onChange, every = CHECK_EVERY_MS, timers = { setInterval, clearInterval } }) {
  let last = null;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const now = readOnBattery(powerMonitor);
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };
  const onBattery = () => check();
  const onAc = () => check();
  powerMonitor.on('on-battery', onBattery);
  powerMonitor.on('on-ac', onAc);
  const t = timers.setInterval(check, every);
  check();
  return {
    stop() {
      stopped = true;
      timers.clearInterval(t);
      powerMonitor.removeListener('on-battery', onBattery);
      powerMonitor.removeListener('on-ac', onAc);
    },
    /** The last answer; on battery (true) before the first. */
    current: () => last !== false,
  };
}

module.exports = { CHECK_EVERY_MS, readOnBattery, watchPower };
