//! The server and each agent's tool process open the same vault directory.
//! These tests run vault operations from several real processes at once.

use conductor_server::vault::import::{ImportSource, ImportedLogin};
use conductor_server::vault::Vault;
use std::process::Command;

const WORKER_DIR_ENV: &str = "CONDUCTOR_VAULT_TEST_WORKER_DIR";
const WORKER_ROLE_ENV: &str = "CONDUCTOR_VAULT_TEST_WORKER_ROLE";
const ROUNDS: usize = 40;

fn login() -> Vec<ImportedLogin> {
    vec![ImportedLogin {
        name: "Site".into(),
        url: "https://a.test".into(),
        username: "ada".into(),
        password: uuid::Uuid::new_v4().to_string(),
    }]
}

/// Body of one worker process. Runs only when the parent test set the
/// environment; as an ordinary test it does nothing.
#[test]
fn vault_worker_process() {
    let Some(dir) = std::env::var_os(WORKER_DIR_ENV) else {
        return;
    };
    let clears = std::env::var(WORKER_ROLE_ENV).as_deref() == Ok("clear");
    let vault = Vault::new(dir);
    for _ in 0..ROUNDS {
        if clears {
            vault.clear().expect("clear");
        } else {
            vault.import(ImportSource::Chrome, login()).expect("import");
        }
        // Whatever another process left on disk must decrypt with the key
        // that is stored beside it.
        vault.list().expect("vault must stay readable");
    }
}

#[test]
fn clear_and_import_from_separate_processes_never_strand_the_data() {
    let root = tempfile::tempdir().unwrap();
    // The directory does not exist yet: first access is part of the race.
    let dir = root.path().join("vault");
    let children: Vec<_> = ["clear", "import", "clear", "import"]
        .into_iter()
        .map(|role| {
            let child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "vault_worker_process", "--nocapture"])
                .env(WORKER_DIR_ENV, &dir)
                .env(WORKER_ROLE_ENV, role)
                .spawn()
                .unwrap();
            (role, child)
        })
        .collect();
    for (role, child) in children {
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{role} worker failed");
    }

    let vault = Vault::new(&dir);
    vault.import(ImportSource::Chrome, login()).unwrap();
    assert!(!vault.list().unwrap().is_empty());
}
