use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const CONDUCTOR_DATA_DIR: &str = "~/.conductor";

pub fn generate_config_hash(config_path: &Path) -> Result<String> {
    let resolved = fs::canonicalize(config_path)
        .with_context(|| format!("failed to canonicalize {}", config_path.display()))?;
    let config_dir = resolved.parent().map(Path::to_path_buf).unwrap_or(resolved);
    let digest = sha256(config_dir.to_string_lossy().as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(hex[..12].to_string())
}

pub fn generate_project_id(project_path: &Path) -> String {
    project_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

pub fn generate_instance_id(config_path: &Path, project_path: &Path) -> Result<String> {
    Ok(format!(
        "{}-{}",
        generate_config_hash(config_path)?,
        generate_project_id(project_path)
    ))
}

pub fn generate_session_prefix(project_id: &str) -> String {
    if project_id.len() <= 4 {
        return project_id.to_lowercase();
    }

    let uppercase: String = project_id
        .chars()
        .filter(|ch| ch.is_ascii_uppercase())
        .collect();
    if uppercase.len() > 1 {
        return uppercase.to_lowercase();
    }

    if project_id.contains('-') || project_id.contains('_') {
        let separator = if project_id.contains('-') { '-' } else { '_' };
        return project_id
            .split(separator)
            .filter_map(|segment| segment.chars().next())
            .collect::<String>()
            .to_lowercase();
    }

    project_id
        .chars()
        .take(3)
        .collect::<String>()
        .to_lowercase()
}

pub fn get_project_base_dir(config_path: &Path, project_path: &Path) -> Result<PathBuf> {
    Ok(expand_home(Path::new(CONDUCTOR_DATA_DIR))
        .join(generate_instance_id(config_path, project_path)?))
}

pub fn get_sessions_dir(config_path: &Path, project_path: &Path) -> Result<PathBuf> {
    Ok(get_project_base_dir(config_path, project_path)?.join("sessions"))
}

pub fn get_worktrees_dir(config_path: &Path, project_path: &Path) -> Result<PathBuf> {
    Ok(get_project_base_dir(config_path, project_path)?.join("worktrees"))
}

pub fn get_archive_dir(config_path: &Path, project_path: &Path) -> Result<PathBuf> {
    Ok(get_sessions_dir(config_path, project_path)?.join("archive"))
}

pub fn get_origin_file_path(config_path: &Path, project_path: &Path) -> Result<PathBuf> {
    Ok(get_project_base_dir(config_path, project_path)?.join(".origin"))
}

pub fn generate_session_name(prefix: &str, num: u32) -> String {
    format!("{prefix}-{num}")
}

pub fn expand_home(path: &Path) -> PathBuf {
    let as_text = path.to_string_lossy();
    if let Some(rest) = as_text.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

pub fn validate_and_store_origin(config_path: &Path, project_path: &Path) -> Result<()> {
    let origin_path = get_origin_file_path(config_path, project_path)?;
    let resolved_config_path = fs::canonicalize(config_path)
        .with_context(|| format!("failed to canonicalize {}", config_path.display()))?;

    if origin_path.exists() {
        let stored = fs::read_to_string(&origin_path)
            .with_context(|| format!("failed to read {}", origin_path.display()))?;
        let stored = stored.trim();
        if stored != resolved_config_path.to_string_lossy() {
            anyhow::bail!(
                "Hash collision detected!\nDirectory: {}\nExpected config: {}\nActual config: {}\nThis is a rare hash collision. Please move one of the configs to a different directory.",
                get_project_base_dir(config_path, project_path)?.display(),
                resolved_config_path.display(),
                stored
            );
        }
        return Ok(());
    }

    if let Some(parent) = origin_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(
        &origin_path,
        resolved_config_path.to_string_lossy().as_ref(),
    )
    .with_context(|| format!("failed to write {}", origin_path.display()))?;
    Ok(())
}

pub fn get_workspace_artifacts_dir(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".conductor").join("rust-backend")
}

pub fn get_dev_server_logs_dir(workspace_path: &Path) -> PathBuf {
    get_workspace_artifacts_dir(workspace_path).join("dev-servers")
}

pub fn get_dev_server_log_path(workspace_path: &Path, project_id: &str) -> PathBuf {
    get_dev_server_logs_dir(workspace_path).join(format!("{}.log", sanitize_token(project_id)))
}

pub fn get_session_notes_dir(workspace_path: &Path) -> PathBuf {
    workspace_path.join("sessions")
}

pub fn get_session_note_path(workspace_path: &Path, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    Ok(get_session_notes_dir(workspace_path).join(format!("{session_id}.md")))
}

pub fn read_metadata_raw(
    data_dir: &Path,
    session_id: &str,
) -> Result<Option<BTreeMap<String, String>>> {
    let path = metadata_path(data_dir, session_id)?;
    if !path.exists() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    Ok(Some(parse_metadata_file(&content)))
}

pub fn update_metadata(
    data_dir: &Path,
    session_id: &str,
    updates: &BTreeMap<String, String>,
) -> Result<()> {
    let path = metadata_path(data_dir, session_id)?;
    let mut existing = if path.exists() {
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        parse_metadata_file(&content)
    } else {
        BTreeMap::new()
    };

    for (key, value) in updates {
        if value.is_empty() {
            existing.remove(key);
        } else {
            existing.insert(key.clone(), sanitize_metadata_value(value));
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(&path, serialize_metadata(&existing))
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

pub fn get_metadata_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    metadata_path(data_dir, session_id)
}

pub fn get_conversation_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    Ok(data_dir
        .join("conversation")
        .join(format!("{session_id}.jsonl")))
}

fn parse_metadata_file(content: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        result.insert(key.to_string(), value.trim().to_string());
    }
    result
}

fn serialize_metadata(data: &BTreeMap<String, String>) -> String {
    let body = data
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("{key}={}", sanitize_metadata_value(value)))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{body}\n")
}

fn sanitize_metadata_value(value: &str) -> String {
    value
        .lines()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn metadata_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    Ok(data_dir.join(session_id))
}

fn validate_session_id(session_id: &str) -> Result<()> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        anyhow::bail!("Invalid session ID: {session_id}");
    }
    Ok(())
}

fn sanitize_token(value: &str) -> String {
    let normalized = value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();

    normalized.trim_matches('-').to_string()
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const INITIAL_STATE: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut state = INITIAL_STATE;
    let mut padded = input.to_vec();
    let bit_len = (padded.len() as u64) * 8;
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut schedule = [0u32; 64];
    for chunk in padded.chunks_exact(64) {
        for (index, word) in chunk.chunks_exact(4).take(16).enumerate() {
            schedule[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let s1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(s1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];

        for index in 0..64 {
            let sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sigma1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(schedule[index]);
            let sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sigma0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..(index + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "conductor-paths-tests-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn generate_session_prefix_matches_expected_patterns() {
        assert_eq!(generate_session_prefix("repo"), "repo");
        assert_eq!(generate_session_prefix("PyTorch"), "pt");
        assert_eq!(generate_session_prefix("conductor-v2"), "cv");
        assert_eq!(generate_session_prefix("integrator"), "int");
    }

    #[test]
    fn generate_config_hash_uses_parent_directory() {
        let temp_dir = TestDir::new();
        let config_path = temp_dir.path().join("conductor.yaml");
        fs::write(&config_path, "projects: {}\n").unwrap();

        let hash = generate_config_hash(&config_path).unwrap();
        assert_eq!(hash.len(), 12);
        assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn session_directory_helpers_match_expected_layout() {
        let _guard = env_lock().lock().unwrap();
        let temp_dir = TestDir::new();
        let config_path = temp_dir.path().join("workspace").join("conductor.yaml");
        let project_path = temp_dir.path().join("repos").join("example-app");
        fs::create_dir_all(project_path.parent().unwrap()).unwrap();
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(&config_path, "projects: {}\n").unwrap();
        fs::create_dir_all(&project_path).unwrap();

        let base_dir = get_project_base_dir(&config_path, &project_path).unwrap();
        let sessions_dir = get_sessions_dir(&config_path, &project_path).unwrap();
        let worktrees_dir = get_worktrees_dir(&config_path, &project_path).unwrap();
        let archive_dir = get_archive_dir(&config_path, &project_path).unwrap();
        let origin_file = get_origin_file_path(&config_path, &project_path).unwrap();

        assert_eq!(sessions_dir, base_dir.join("sessions"));
        assert_eq!(worktrees_dir, base_dir.join("worktrees"));
        assert_eq!(archive_dir, sessions_dir.join("archive"));
        assert_eq!(origin_file, base_dir.join(".origin"));
    }

    #[test]
    fn validate_and_store_origin_detects_collisions() {
        let _guard = env_lock().lock().unwrap();
        let temp_dir = TestDir::new();
        let original_home = std::env::var_os("HOME");
        std::env::set_var("HOME", temp_dir.path());

        let config_a = temp_dir.path().join("a").join("conductor.yaml");
        let project_path = temp_dir.path().join("repo");
        fs::create_dir_all(config_a.parent().unwrap()).unwrap();
        fs::create_dir_all(&project_path).unwrap();
        fs::write(&config_a, "projects: {}\n").unwrap();

        validate_and_store_origin(&config_a, &project_path).unwrap();
        let origin_path = get_origin_file_path(&config_a, &project_path).unwrap();
        fs::write(&origin_path, "/tmp/some-other-workspace/conductor.yaml").unwrap();

        let err = validate_and_store_origin(&config_a, &project_path).unwrap_err();
        assert!(err.to_string().contains("Hash collision detected"));

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn update_metadata_merges_sanitizes_and_removes_values() {
        let temp_dir = TestDir::new();
        let data_dir = temp_dir.path().join("sessions");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("int-1"), "status=working\nnote=hello\n").unwrap();

        update_metadata(
            &data_dir,
            "int-1",
            &BTreeMap::from([
                ("status".to_string(), "idle".to_string()),
                ("note".to_string(), "".to_string()),
                ("summary".to_string(), "line one\nline two".to_string()),
            ]),
        )
        .unwrap();

        let metadata = read_metadata_raw(&data_dir, "int-1").unwrap().unwrap();
        assert_eq!(metadata.get("status").map(String::as_str), Some("idle"));
        assert_eq!(
            metadata.get("summary").map(String::as_str),
            Some("line one line two")
        );
        assert!(!metadata.contains_key("note"));
    }

    #[test]
    fn workspace_artifact_paths_match_runtime_layout() {
        let workspace = Path::new("/tmp/workspace");
        assert_eq!(
            get_workspace_artifacts_dir(workspace),
            PathBuf::from("/tmp/workspace/.conductor/rust-backend")
        );
        assert_eq!(
            get_dev_server_log_path(workspace, "My Project"),
            PathBuf::from("/tmp/workspace/.conductor/rust-backend/dev-servers/my-project.log")
        );
        assert_eq!(
            get_session_note_path(workspace, "abc-1").unwrap(),
            PathBuf::from("/tmp/workspace/sessions/abc-1.md")
        );
    }
}
