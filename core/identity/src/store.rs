//! Where secrets live on this device.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use zeroize::Zeroizing;

/// A small store of named secrets. Implementations never log values.
pub trait SecretStore {
    /// `None` if there is no entry with this name.
    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError>;
    fn save(&self, name: &str, secret: &[u8]) -> Result<(), StoreError>;
    /// Succeeds if the entry is already gone.
    fn delete(&self, name: &str) -> Result<(), StoreError>;
}

/// The platform store failed (locked keychain, no Secret Service running,
/// access denied). The message never contains a secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "secret store: {}", self.0)
    }
}

impl std::error::Error for StoreError {}

/// In-memory store for tests. Values are zeroized when replaced or dropped.
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }
}

impl SecretStore for MemoryStore {
    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let entries = self.entries.lock().expect("not poisoned");
        Ok(entries.get(name).cloned())
    }

    fn save(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        let mut entries = self.entries.lock().expect("not poisoned");
        entries.insert(name.to_owned(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        self.entries.lock().expect("not poisoned").remove(name);
        Ok(())
    }
}

impl fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entries = self.entries.lock().expect("not poisoned");
        let mut names: Vec<&String> = entries.keys().collect();
        names.sort();
        f.debug_struct("MemoryStore").field("names", &names).finish()
    }
}

impl<S: SecretStore + ?Sized> SecretStore for &S {
    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        (**self).load(name)
    }

    fn save(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        (**self).save(name, secret)
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        (**self).delete(name)
    }
}

/// The keychain service every entry of this app lives under. Frozen for the
/// alpha: changing it makes existing identities invisible (the app would
/// offer sign-up again).
pub const KEYCHAIN_SERVICE: &str = "io.github.moranmoa.mvs.identity.v1";

/// The OS keychain: Windows Credential Manager, macOS Keychain, or the
/// Secret Service on Linux (GNOME Keyring, KWallet). Every entry is under
/// [`KEYCHAIN_SERVICE`]; there is no way to pick another service.
///
/// On Windows the credential's target name is `<service>/<name>` (set
/// explicitly, so no other `user.service` pair can collide with it) and its
/// persistence is `Local`: never copied into a roaming profile.
#[cfg(feature = "os-keychain")]
#[derive(Clone, Debug, Default)]
pub struct OsKeychain {
    _private: (),
}

#[cfg(feature = "os-keychain")]
impl OsKeychain {
    pub fn new() -> OsKeychain {
        OsKeychain::default()
    }

    fn entry(&self, name: &str) -> Result<keyring_core::Entry, StoreError> {
        default_store()?;
        let owned = modifiers(name);
        let mods: HashMap<&str, &str> = owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
        keyring_core::Entry::new_with_modifiers(KEYCHAIN_SERVICE, name, &mods).map_err(platform)
    }
}

/// Sets up the platform's default store once it works.
///
/// On Linux we set up the Secret Service store ourselves. keyring's own
/// setup (`Entry::store_status`) runs once per process and keeps its first
/// result, so a Secret Service that wasn't up yet when the core first asked
/// (a D-Bus session or gnome-keyring started alongside the core) left that
/// core with `keyring-unavailable` forever (QA, 0.4.5 features run). Here a
/// failure is not kept: the next call tries again, and a success is kept.
#[cfg(all(feature = "os-keychain", unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
fn default_store() -> Result<(), StoreError> {
    static READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    static SETUP: Mutex<()> = Mutex::new(());
    if READY.get().is_some() {
        return Ok(());
    }
    let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    if READY.get().is_none() {
        let store = zbus_secret_service_keyring_store::Store::new().map_err(platform)?;
        keyring_core::set_default_store(store);
        let _ = READY.set(());
    }
    Ok(())
}

/// Windows and macOS: their stores don't depend on a service that may start
/// later, so keyring's once-per-process setup is enough.
#[cfg(all(feature = "os-keychain", not(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))))]
fn default_store() -> Result<(), StoreError> {
    keyring::Entry::store_status().as_ref().map(|_| ()).map_err(|e| StoreError(e.to_string()))
}

#[cfg(all(feature = "os-keychain", target_os = "windows"))]
fn modifiers(name: &str) -> HashMap<&'static str, String> {
    HashMap::from([("target", windows_target(name)), ("persistence", "Local".to_owned())])
}

#[cfg(all(feature = "os-keychain", not(target_os = "windows")))]
fn modifiers(_name: &str) -> HashMap<&'static str, String> {
    HashMap::new()
}

#[cfg(feature = "os-keychain")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_target(name: &str) -> String {
    format!("{KEYCHAIN_SERVICE}/{name}")
}

#[cfg(feature = "os-keychain")]
impl SecretStore for OsKeychain {
    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        match self.entry(name)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(platform(e)),
        }
    }

    fn save(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        self.entry(name)?.set_secret(secret).map_err(platform)
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(platform(e)),
        }
    }
}

#[cfg(feature = "os-keychain")]
fn platform(error: keyring_core::Error) -> StoreError {
    match error {
        // These two carry the stored bytes; never put them in a message.
        keyring_core::Error::BadEncoding(_) | keyring_core::Error::BadDataFormat(..) => {
            StoreError("stored value has an unexpected format".into())
        }
        other => StoreError(other.to_string()),
    }
}

#[cfg(all(test, feature = "os-keychain"))]
mod tests {
    use super::*;

    #[test]
    fn windows_target_is_frozen() {
        assert_eq!(
            windows_target("identity-secret-v1"),
            "io.github.moranmoa.mvs.identity.v1/identity-secret-v1"
        );
    }
}

/// QA on 0.4.5: a Secret Service that comes up after the first call is
/// still found (keyring's own setup kept the first failure for the whole
/// process). Needs `dbus-daemon` and `gnome-keyring-daemon`; run with
/// `--ignored` and `MVS_LATE_KEYRING_START`, a shell command that starts a
/// session bus at `DBUS_SESSION_BUS_ADDRESS` and an unlocked keyring on it.
#[cfg(all(test, feature = "os-keychain", target_os = "linux"))]
mod late_secret_service {
    use super::*;

    #[test]
    #[ignore = "needs dbus-daemon and gnome-keyring (MVS_LATE_KEYRING_START)"]
    fn a_secret_service_started_after_the_first_call_is_used() {
        let start = std::env::var("MVS_LATE_KEYRING_START").expect("MVS_LATE_KEYRING_START");
        let keychain = OsKeychain::new();
        assert!(keychain.save("late-test", b"one").is_err(), "no bus yet");
        let status = std::process::Command::new("sh").arg("-c").arg(&start).status().unwrap();
        assert!(status.success(), "the keyring didn't start");
        keychain.save("late-test", b"one").expect("found once it is up");
        assert_eq!(keychain.load("late-test").unwrap().as_deref().map(|s| s.as_slice()), Some(&b"one"[..]));
        keychain.delete("late-test").unwrap();
    }
}
