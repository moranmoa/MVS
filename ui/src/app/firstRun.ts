// G-92: the first visit to Home after creating a new account gets its own
// title ("Your account is ready. What now?"). A local, one-time flag: set when
// sign-up finishes, taken (and cleared) by Home.

const KEY = 'mvs.home.firstRun.v1';

export function markFirstRun(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // No storage: Home just shows its usual title.
  }
}

/** True once, on the first Home after sign-up. */
export function takeFirstRun(): boolean {
  try {
    const on = localStorage.getItem(KEY) === '1';
    if (on) localStorage.removeItem(KEY);
    return on;
  } catch {
    return false;
  }
}
