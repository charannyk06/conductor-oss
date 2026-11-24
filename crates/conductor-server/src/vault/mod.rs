//! Local credential vault.
//!
//! Logins imported from a password manager are kept in one file encrypted with
//! AES-256-GCM. Passwords never leave this module through the listing API;
//! only [`Vault::reveal`] returns one, for the component that fills a login
//! form on the user's behalf.
//!
//! The 32-byte key lives in the operating system's keychain (macOS Keychain,
//! Windows Credential Manager, or the Secret Service on Linux). Where no
//! keychain is reachable, such as a headless Linux machine, it falls back to
//! an owner-only file beside the vault; that fallback does not protect
//! against other programs running as the same user. A key found in the file
//! is moved into the keychain the first time one is available.

pub mod import;

use chrono::Utc;
use conductor_core::paths::{expand_home, CONDUCTOR_DATA_DIR};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use thiserror::Error;
use uuid::Uuid;

use import::{ImportSource, ImportedLogin};

const KEY_FILE: &str = "vault.key";
const DATA_FILE: &str = "vault.enc";
const KEY_LEN: usize = 32;
/// First byte of the data file; bump when the layout changes.
const FORMAT_VERSION: u8 = 1;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault storage error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the vault key is missing or damaged, so saved credentials cannot be read")]
    BadKey,
    #[error("the system keychain holding the vault key could not be reached: {0}")]
    KeychainUnavailable(String),
    #[error(
        "the vault file could not be decrypted; it is damaged or was written with a different key"
    )]
    Decrypt,
    #[error("the vault file has an unsupported format")]
    Format,
    #[error("no saved credential has that id")]
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCredential {
    id: String,
    name: String,
    url: String,
    username: String,
    password: String,
    source: ImportSource,
    created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct VaultContents {
    credentials: Vec<StoredCredential>,
}

/// A saved login without its password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub name: String,
    pub url: String,
    pub username: String,
    pub source: ImportSource,
    pub created_at: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// New logins added.
    pub imported: usize,
    /// Existing logins whose password changed.
    pub updated: usize,
    /// Logins already saved with the same password.
    pub unchanged: usize,
}

/// Where the vault's encryption key is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStorage {
    Keychain,
    File,
}

/// A place outside the vault directory that can hold the key.
pub trait KeyStore: Send + Sync {
    /// `Ok(None)` means the store works but holds no key; `Err` means the
    /// store itself cannot be used.
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, key: &[u8]) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The operating system's credential store.
pub struct OsKeychain;

impl OsKeychain {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("conductor-oss", "credential-vault-key").map_err(|err| err.to_string())
    }
}

impl KeyStore for OsKeychain {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match Self::entry()?.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&self, key: &[u8]) -> Result<(), String> {
        Self::entry()?
            .set_secret(key)
            .map_err(|err| err.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

pub struct Vault {
    dir: PathBuf,
    keychain: Option<Box<dyn KeyStore>>,
    /// Serialises read-modify-write cycles within this process.
    lock: Mutex<()>,
}

impl Vault {
    /// A vault whose key is kept in a file inside `dir`.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            keychain: None,
            lock: Mutex::new(()),
        }
    }

    /// A vault whose key is kept in `keychain`, with the key file as fallback.
    pub fn with_keychain(dir: impl Into<PathBuf>, keychain: Box<dyn KeyStore>) -> Self {
        Self {
            dir: dir.into(),
            keychain: Some(keychain),
            lock: Mutex::new(()),
        }
    }

    /// The per-user vault under the Conductor data directory.
    pub fn default_location() -> Self {
        Self::with_keychain(
            expand_home(Path::new(CONDUCTOR_DATA_DIR)).join("vault"),
            Box::new(OsKeychain),
        )
    }

    /// Where the key currently lives, or `None` before anything is saved.
    pub fn key_storage(&self) -> Result<Option<KeyStorage>, VaultError> {
        let _guard = self.guard();
        Ok(self.read_key()?.map(|(_, storage)| storage))
    }

    pub fn list(&self) -> Result<Vec<CredentialSummary>, VaultError> {
        let _guard = self.guard();
        Ok(self.load()?.credentials.iter().map(summary).collect())
    }

    /// Save parsed logins. A login is identified by its URL and username.
    pub fn import(
        &self,
        source: ImportSource,
        logins: Vec<ImportedLogin>,
    ) -> Result<ImportReport, VaultError> {
        let _guard = self.guard();
        let mut contents = self.load()?;
        let mut report = ImportReport::default();

        for login in logins {
            let existing = contents
                .credentials
                .iter_mut()
                .find(|saved| saved.url == login.url && saved.username == login.username);
            match existing {
                Some(saved) if saved.password == login.password => report.unchanged += 1,
                Some(saved) => {
                    saved.password = login.password;
                    report.updated += 1;
                }
                None => {
                    contents.credentials.push(StoredCredential {
                        id: Uuid::new_v4().to_string(),
                        name: login.name,
                        url: login.url,
                        username: login.username,
                        password: login.password,
                        source,
                        created_at: Utc::now().to_rfc3339(),
                    });
                    report.imported += 1;
                }
            }
        }

        if report.imported > 0 || report.updated > 0 {
            self.save(&contents)?;
        }
        Ok(report)
    }

    /// Return one saved password, for filling a login form.
    pub fn reveal(&self, id: &str) -> Result<String, VaultError> {
        let _guard = self.guard();
        self.load()?
            .credentials
            .into_iter()
            .find(|saved| saved.id == id)
            .map(|saved| saved.password)
            .ok_or(VaultError::NotFound)
    }

    pub fn delete(&self, id: &str) -> Result<(), VaultError> {
        let _guard = self.guard();
        let mut contents = self.load()?;
        let before = contents.credentials.len();
        contents.credentials.retain(|saved| saved.id != id);
        if contents.credentials.len() == before {
            return Err(VaultError::NotFound);
        }
        self.save(&contents)
    }

    /// Forget every saved credential and discard the key.
    pub fn clear(&self) -> Result<usize, VaultError> {
        let _guard = self.guard();
        // Count what is readable, but still wipe a vault that cannot be read.
        let removed = self
            .load()
            .map(|contents| contents.credentials.len())
            .unwrap_or(0);
        for file in [DATA_FILE, KEY_FILE] {
            match fs::remove_file(self.dir.join(file)) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
        }
        if let Some(keychain) = &self.keychain {
            // Best effort: with the data file gone, a key left behind in an
            // unreachable keychain protects nothing.
            let _ = keychain.delete();
        }
        Ok(removed)
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn load(&self) -> Result<VaultContents, VaultError> {
        let data = match fs::read(self.dir.join(DATA_FILE)) {
            Ok(data) => data,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(VaultContents::default())
            }
            Err(err) => return Err(err.into()),
        };
        let (version, rest) = data.split_first().ok_or(VaultError::Format)?;
        if *version != FORMAT_VERSION || rest.len() < NONCE_LEN {
            return Err(VaultError::Format);
        }
        let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| VaultError::Format)?;

        // A data file without its key is unreadable; never mint a new key here.
        let (key, _) = self.read_key()?.ok_or(VaultError::BadKey)?;
        let mut buffer = ciphertext.to_vec();
        let plaintext = key
            .open_in_place(nonce, Aad::from([FORMAT_VERSION]), &mut buffer)
            .map_err(|_| VaultError::Decrypt)?;
        serde_json::from_slice(plaintext).map_err(|_| VaultError::Format)
    }

    fn save(&self, contents: &VaultContents) -> Result<(), VaultError> {
        create_private_dir(&self.dir)?;
        let key = match self.read_key()? {
            Some((key, _)) => key,
            None => self.create_key()?,
        };

        let mut nonce_bytes = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| VaultError::BadKey)?;
        let mut buffer = serde_json::to_vec(contents).map_err(|_| VaultError::Format)?;
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from([FORMAT_VERSION]),
            &mut buffer,
        )
        .map_err(|_| VaultError::BadKey)?;

        let mut file = Vec::with_capacity(1 + NONCE_LEN + buffer.len());
        file.push(FORMAT_VERSION);
        file.extend_from_slice(&nonce_bytes);
        file.extend_from_slice(&buffer);
        write_private_file(&self.dir, DATA_FILE, &file)?;
        Ok(())
    }

    fn read_key(&self) -> Result<Option<(LessSafeKey, KeyStorage)>, VaultError> {
        let file_key = match fs::read(self.dir.join(KEY_FILE)) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err.into()),
        };
        let Some(keychain) = &self.keychain else {
            return file_key
                .map(|bytes| make_key(&bytes).map(|key| (key, KeyStorage::File)))
                .transpose();
        };

        match (keychain.get(), file_key) {
            (Ok(Some(bytes)), _) => Ok(Some((make_key(&bytes)?, KeyStorage::Keychain))),
            (Ok(None), None) => Ok(None),
            (Ok(None), Some(bytes)) => {
                // Move a key left in the fallback file into the keychain.
                let key = make_key(&bytes)?;
                if keychain.set(&bytes).is_ok() {
                    fs::remove_file(self.dir.join(KEY_FILE))?;
                    Ok(Some((key, KeyStorage::Keychain)))
                } else {
                    Ok(Some((key, KeyStorage::File)))
                }
            }
            (Err(_), Some(bytes)) => Ok(Some((make_key(&bytes)?, KeyStorage::File))),
            // Without a file key, an unreachable keychain may still hold the
            // real key, so report it rather than treating the key as absent.
            (Err(reason), None) if self.dir.join(DATA_FILE).exists() => {
                Err(VaultError::KeychainUnavailable(reason))
            }
            (Err(_), None) => Ok(None),
        }
    }

    fn create_key(&self) -> Result<LessSafeKey, VaultError> {
        let mut bytes = [0u8; KEY_LEN];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| VaultError::BadKey)?;
        let stored_in_keychain = self
            .keychain
            .as_ref()
            .is_some_and(|keychain| keychain.set(&bytes).is_ok());
        if !stored_in_keychain {
            write_private_file(&self.dir, KEY_FILE, &bytes)?;
        }
        make_key(&bytes)
    }
}

fn summary(saved: &StoredCredential) -> CredentialSummary {
    CredentialSummary {
        id: saved.id.clone(),
        name: saved.name.clone(),
        url: saved.url.clone(),
        username: saved.username.clone(),
        source: saved.source,
        created_at: saved.created_at.clone(),
    }
}

fn make_key(bytes: &[u8]) -> Result<LessSafeKey, VaultError> {
    if bytes.len() != KEY_LEN {
        return Err(VaultError::BadKey);
    }
    UnboundKey::new(&AES_256_GCM, bytes)
        .map(LessSafeKey::new)
        .map_err(|_| VaultError::BadKey)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write `bytes` to `dir/name` through a temporary file so a crash cannot
/// leave a half-written vault, with owner-only permissions on Unix.
fn write_private_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let temp_path = dir.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp_path, dir.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(url: &str, username: &str, password: &str) -> ImportedLogin {
        ImportedLogin {
            name: "Site".into(),
            url: url.into(),
            username: username.into(),
            password: password.into(),
        }
    }

    #[test]
    fn empty_vault_lists_nothing_and_creates_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().join("vault"));
        assert!(vault.list().unwrap().is_empty());
        assert!(!dir.path().join("vault").exists());
    }

    #[test]
    fn import_persists_and_listing_never_contains_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let report = vault
            .import(
                ImportSource::Chrome,
                vec![login("https://a.test", "ada", "top-secret-pw")],
            )
            .unwrap();
        assert_eq!(report.imported, 1);

        // A fresh handle reads what the first one wrote.
        let reopened = Vault::new(dir.path());
        let listed = reopened.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].username, "ada");
        assert!(!serde_json::to_string(&listed)
            .unwrap()
            .contains("top-secret-pw"));
        assert_eq!(reopened.reveal(&listed[0].id).unwrap(), "top-secret-pw");
    }

    #[test]
    fn data_file_is_encrypted_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        vault
            .import(
                ImportSource::Bitwarden,
                vec![login("https://bank.test", "ada-lovelace", "top-secret-pw")],
            )
            .unwrap();
        let raw = fs::read(dir.path().join(DATA_FILE)).unwrap();
        for needle in ["top-secret-pw", "ada-lovelace", "bank.test"] {
            assert!(!raw
                .windows(needle.len())
                .any(|window| window == needle.as_bytes()));
        }
    }

    #[test]
    fn reimport_reports_unchanged_and_updated() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        vault
            .import(
                ImportSource::Chrome,
                vec![
                    login("https://a.test", "ada", "one"),
                    login("https://b.test", "ada", "two"),
                ],
            )
            .unwrap();
        let report = vault
            .import(
                ImportSource::Chrome,
                vec![
                    login("https://a.test", "ada", "one"),
                    login("https://b.test", "ada", "changed"),
                    login("https://c.test", "ada", "three"),
                ],
            )
            .unwrap();
        assert_eq!(
            report,
            ImportReport {
                imported: 1,
                updated: 1,
                unchanged: 1
            }
        );
        assert_eq!(vault.list().unwrap().len(), 3);
    }

    #[test]
    fn delete_removes_one_and_rejects_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        vault
            .import(
                ImportSource::Chrome,
                vec![
                    login("https://a.test", "ada", "one"),
                    login("https://b.test", "ada", "two"),
                ],
            )
            .unwrap();
        let id = vault.list().unwrap()[0].id.clone();
        vault.delete(&id).unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
        assert!(matches!(vault.delete(&id), Err(VaultError::NotFound)));
        assert!(matches!(vault.reveal(&id), Err(VaultError::NotFound)));
    }

    #[test]
    fn tampered_or_wrong_key_data_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        vault
            .import(
                ImportSource::Chrome,
                vec![login("https://a.test", "ada", "one")],
            )
            .unwrap();

        let data_path = dir.path().join(DATA_FILE);
        let mut raw = fs::read(&data_path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        fs::write(&data_path, &raw).unwrap();
        assert!(matches!(vault.list(), Err(VaultError::Decrypt)));

        raw[last] ^= 0x01;
        fs::write(&data_path, &raw).unwrap();
        fs::write(dir.path().join(KEY_FILE), [7u8; KEY_LEN]).unwrap();
        assert!(matches!(vault.list(), Err(VaultError::Decrypt)));

        fs::remove_file(dir.path().join(KEY_FILE)).unwrap();
        assert!(matches!(vault.list(), Err(VaultError::BadKey)));
    }

    #[test]
    fn clear_forgets_everything() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        vault
            .import(
                ImportSource::Chrome,
                vec![login("https://a.test", "ada", "one")],
            )
            .unwrap();
        assert_eq!(vault.clear().unwrap(), 1);
        assert!(!dir.path().join(DATA_FILE).exists());
        assert!(!dir.path().join(KEY_FILE).exists());
        assert!(vault.list().unwrap().is_empty());
        assert_eq!(vault.clear().unwrap(), 0);
    }

    /// An in-memory keychain that can be switched off to mimic a machine
    /// with no credential store.
    #[derive(Clone, Default)]
    struct FakeKeychain {
        key: std::sync::Arc<Mutex<Option<Vec<u8>>>>,
        broken: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl FakeKeychain {
        fn set_broken(&self, broken: bool) {
            self.broken
                .store(broken, std::sync::atomic::Ordering::SeqCst);
        }

        fn check(&self) -> Result<(), String> {
            if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
                Err("no credential store".into())
            } else {
                Ok(())
            }
        }
    }

    impl KeyStore for FakeKeychain {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            self.check()?;
            Ok(self.key.lock().unwrap().clone())
        }

        fn set(&self, key: &[u8]) -> Result<(), String> {
            self.check()?;
            *self.key.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            self.check()?;
            *self.key.lock().unwrap() = None;
            Ok(())
        }
    }

    fn one_login() -> Vec<ImportedLogin> {
        vec![login("https://a.test", "ada", "one")]
    }

    #[test]
    fn key_goes_to_the_keychain_and_no_key_file_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let vault = Vault::with_keychain(dir.path(), Box::new(keychain.clone()));
        assert_eq!(vault.key_storage().unwrap(), None);

        vault.import(ImportSource::Chrome, one_login()).unwrap();
        assert_eq!(vault.key_storage().unwrap(), Some(KeyStorage::Keychain));
        assert!(!dir.path().join(KEY_FILE).exists());
        assert_eq!(
            keychain.key.lock().unwrap().as_ref().unwrap().len(),
            KEY_LEN
        );

        let reopened = Vault::with_keychain(dir.path(), Box::new(keychain));
        assert_eq!(reopened.list().unwrap().len(), 1);
    }

    #[test]
    fn file_key_is_moved_into_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        Vault::new(dir.path())
            .import(ImportSource::Chrome, one_login())
            .unwrap();
        assert!(dir.path().join(KEY_FILE).exists());

        let keychain = FakeKeychain::default();
        let vault = Vault::with_keychain(dir.path(), Box::new(keychain.clone()));
        assert_eq!(vault.list().unwrap().len(), 1);
        assert!(!dir.path().join(KEY_FILE).exists());
        assert!(keychain.key.lock().unwrap().is_some());
        assert_eq!(vault.key_storage().unwrap(), Some(KeyStorage::Keychain));
    }

    #[test]
    fn falls_back_to_the_key_file_without_a_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = FakeKeychain::default();
        keychain.set_broken(true);
        let vault = Vault::with_keychain(dir.path(), Box::new(keychain));
        vault.import(ImportSource::Chrome, one_login()).unwrap();
        assert_eq!(vault.key_storage().unwrap(), Some(KeyStorage::File));
        assert!(dir.path().join(KEY_FILE).exists());
        assert_eq!(vault.list().unwrap().len(), 1);
        assert_eq!(vault.clear().unwrap(), 1);
        assert!(!dir.path().join(KEY_FILE).exists());
    }

    #[test]
    fn unreachable_keychain_is_reported_not_treated_as_a_lost_key() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let vault = Vault::with_keychain(dir.path(), Box::new(keychain.clone()));
        vault.import(ImportSource::Chrome, one_login()).unwrap();

        keychain.set_broken(true);
        assert!(matches!(
            vault.list(),
            Err(VaultError::KeychainUnavailable(_))
        ));
        // Importing must not mint a second key over data it cannot read.
        assert!(vault.import(ImportSource::Chrome, one_login()).is_err());
        assert!(!dir.path().join(KEY_FILE).exists());

        keychain.set_broken(false);
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn clear_removes_the_keychain_key() {
        let dir = tempfile::tempdir().unwrap();
        let keychain = FakeKeychain::default();
        let vault = Vault::with_keychain(dir.path(), Box::new(keychain.clone()));
        vault.import(ImportSource::Chrome, one_login()).unwrap();
        assert_eq!(vault.clear().unwrap(), 1);
        assert!(keychain.key.lock().unwrap().is_none());
        assert!(!dir.path().join(DATA_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let vault_dir = dir.path().join("vault");
        let vault = Vault::new(&vault_dir);
        vault
            .import(
                ImportSource::Chrome,
                vec![login("https://a.test", "ada", "one")],
            )
            .unwrap();
        let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(vault_dir.clone()), 0o700);
        assert_eq!(mode(vault_dir.join(KEY_FILE)), 0o600);
        assert_eq!(mode(vault_dir.join(DATA_FILE)), 0o600);
    }
}
