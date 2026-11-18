//! G-78, the app lock: the core's part (`docs/design/app-lock.md` §3, §6,
//! §8). A UI gate in front of the window, enforced by the shell's main
//! process. The core keeps the passcode verifier and the one attempt counter.
//!
//! - **The verifier:** `identity::app_lock_verifier`, which is Argon2id at
//!   `LockParams::MIN` (19 MiB, t=2), derive_key'd. It's stored in the core
//!   DB as `{ v: 1, salt, params, hash }` with the settings. It is **not**
//!   `Vault::set_app_lock`, and this passcode never becomes the vault
//!   passphrase (§7).
//! - **One attempt counter,** persistent, shared by `verifyAppLock`, the
//!   `current` checks of `setAppLock` and `clearAppLock`, and
//!   `clearAppLockWithWords`. The 5th wrong attempt in a row starts a delay
//!   of 30 s, doubling up to 15 min. While it runs, answers are
//!   `rate-limited` without checking. Nothing is ever wiped.
//! - **Nothing is logged:** neither the passcode nor the words.

use serde::{Deserialize, Serialize};

use crate::types::AppLockMethod;

/// Wrong attempts in a row allowed before the delay starts (the 5th starts it).
pub const FREE_ATTEMPTS: u32 = 4;
pub const FIRST_DELAY_MS: u64 = 30_000;
pub const MAX_DELAY_MS: u64 = 15 * 60_000;
/// The idle-lock choices are 1, 5, 15, 30 and 60 minutes. The core
/// accepts any value from 1 to 60.
pub const IDLE_MINUTES: std::ops::RangeInclusive<u8> = 1..=60;
pub const DEFAULT_IDLE_MINUTES: u8 = 5;
/// The longest passcode or passphrase, in characters, after NFC.
pub const MAX_LEN: usize = 64;
/// The longest words answer read for `clearAppLockWithWords`.
pub const MAX_WORDS_LEN: usize = 1024;

/// What the core DB keeps under `app-lock`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub v: u8,
    /// 16 random bytes, hex.
    pub salt: String,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    /// The verifier, hex.
    pub hash: String,
    pub method: AppLockMethod,
    pub idle_minutes: u8,
    pub lock_on_sleep: bool,
}

/// The attempt counter, under `app-lock-attempts`: wrong attempts in a
/// row, and the time (core clock, ms) before which nothing is checked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempts {
    pub failures: u32,
    pub not_before: u64,
}

impl Attempts {
    /// How long to wait before the next check, if a delay is running.
    pub fn wait_ms(&self, now: u64) -> Option<u64> {
        (now < self.not_before).then(|| self.not_before - now)
    }

    /// A wrong attempt. From the 5th in a row: 30 s, then 60 s, 2 min and
    /// so on, at most 15 min.
    pub fn fail(&mut self, now: u64) {
        self.failures = self.failures.saturating_add(1);
        if self.failures > FREE_ATTEMPTS {
            let doublings = (self.failures - FREE_ATTEMPTS - 1).min(10);
            let delay = (FIRST_DELAY_MS << doublings).min(MAX_DELAY_MS);
            self.not_before = now + delay;
        }
    }
}

/// Whole seconds to wait, rounded up, for `retryAfter`.
pub fn retry_after_secs(wait_ms: u64) -> u64 {
    wait_ms.div_ceil(1000)
}

/// A passcode an attempt may carry: 4 to [`MAX_LEN`] characters after NFC,
/// with no control characters. Anything else counts as wrong without being
/// hashed. (The shell already checks 4–64; the core checks again.)
pub fn attempt_ok(passcode: &str) -> bool {
    let n = passcode.chars().count();
    (4..=MAX_LEN).contains(&n) && !passcode.chars().any(char::is_control)
}

/// A new passcode (§3): 4–12 digits, or a passphrase of 6–64 characters,
/// with no control characters. The input is already NFC.
pub fn new_passcode_ok(passcode: &str) -> bool {
    let n = passcode.chars().count();
    if passcode.chars().any(char::is_control) || passcode.trim() != passcode {
        return false;
    }
    if passcode.chars().all(|c| c.is_ascii_digit()) {
        (4..=12).contains(&n)
    } else {
        (6..=MAX_LEN).contains(&n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fifth_wrong_attempt_starts_a_doubling_delay_up_to_15_minutes() {
        let mut a = Attempts::default();
        let now = 1_000_000;
        for _ in 0..4 {
            a.fail(now);
            assert_eq!(a.wait_ms(now), None, "4 free attempts");
        }
        let mut expected = Vec::new();
        for _ in 0..8 {
            a.fail(now);
            expected.push(a.wait_ms(now).unwrap() / 1000);
        }
        assert_eq!(expected, [30, 60, 120, 240, 480, 900, 900, 900]);
        assert_eq!(a.wait_ms(now + MAX_DELAY_MS), None, "over once the time is up");
        assert_eq!(retry_after_secs(1), 1);
        assert_eq!(retry_after_secs(30_000), 30);
        assert_eq!(retry_after_secs(30_001), 31);
        // A huge count can't overflow the delay.
        let mut many = Attempts { failures: u32::MAX - 1, not_before: 0 };
        many.fail(now);
        many.fail(now);
        assert_eq!(many.wait_ms(now), Some(MAX_DELAY_MS));
    }

    #[test]
    fn passcode_rules() {
        assert!(new_passcode_ok("2468"));
        assert!(new_passcode_ok("123456789012"));
        assert!(!new_passcode_ok("246"), "too few digits");
        assert!(!new_passcode_ok("1234567890123"), "13 digits: too long a PIN");
        assert!(new_passcode_ok("סוד שלי"));
        assert!(!new_passcode_ok("abc12"), "a passphrase needs 6");
        assert!(!new_passcode_ok(&"x".repeat(65)));
        assert!(new_passcode_ok(&"x".repeat(64)));
        assert!(!new_passcode_ok("pass\nword"));
        assert!(!new_passcode_ok(" 123456"), "no leading or trailing spaces");
        assert!(attempt_ok("2468"));
        assert!(!attempt_ok("246"));
        assert!(!attempt_ok(&"x".repeat(65)));
        assert!(!attempt_ok("24\u{0}68"));
    }
}
