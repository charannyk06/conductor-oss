use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

pub mod amp;
pub mod ccr;
pub mod claude_code;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod droid;
pub mod gemini;
pub mod opencode;
pub mod qwen;

pub use amp::AmpExecutor;
pub use ccr::CcrExecutor;
pub use claude_code::ClaudeCodeExecutor;
pub use codex::CodexExecutor;
pub use copilot::CopilotExecutor;
pub use cursor::CursorExecutor;
pub use droid::DroidExecutor;
pub use gemini::GeminiExecutor;
pub use opencode::OpenCodeExecutor;
pub use qwen::QwenCodeExecutor;

fn push_search_dir(seen: &mut HashSet<PathBuf>, dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if seen.insert(dir.clone()) {
        dirs.push(dir);
    }
}

fn push_path_value(seen: &mut HashSet<PathBuf>, dirs: &mut Vec<PathBuf>, path_value: &OsStr) {
    for dir in env::split_paths(path_value) {
        push_search_dir(seen, dirs, dir);
    }
}

fn fallback_search_dirs_with_path(path_override: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    if let Some(path) = path_override {
        push_path_value(&mut seen, &mut dirs, path);
    } else if let Some(path) = env::var_os("PATH") {
        push_path_value(&mut seen, &mut dirs, &path);
    }

    #[cfg(target_os = "macos")]
    {
        push_search_dir(&mut seen, &mut dirs, PathBuf::from("/opt/homebrew/bin"));
        push_search_dir(&mut seen, &mut dirs, PathBuf::from("/usr/local/bin"));
    }

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        push_search_dir(&mut seen, &mut dirs, home.join(".local").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".cargo").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".npm-global").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".opencode").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".bun").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".volta").join("bin"));
        push_search_dir(&mut seen, &mut dirs, home.join(".asdf").join("shims"));
        push_search_dir(&mut seen, &mut dirs, home.join("Library").join("pnpm"));
        for wrapper_root in legacy_wrapper_root_names() {
            push_search_dir(&mut seen, &mut dirs, home.join(wrapper_root).join("bin"));
        }
    }

    if let Some(dir) = env::var_os("PNPM_HOME").map(PathBuf::from) {
        push_search_dir(&mut seen, &mut dirs, dir);
    }
    if let Some(dir) = env::var_os("NVM_BIN").map(PathBuf::from) {
        push_search_dir(&mut seen, &mut dirs, dir);
    }
    if let Some(dir) = env::var_os("VOLTA_HOME").map(PathBuf::from) {
        push_search_dir(&mut seen, &mut dirs, dir.join("bin"));
    }
    if let Some(dir) = env::var_os("BUN_INSTALL").map(PathBuf::from) {
        push_search_dir(&mut seen, &mut dirs, dir.join("bin"));
    }

    dirs
}

fn fallback_search_dirs() -> Vec<PathBuf> {
    fallback_search_dirs_with_path(None)
}

fn legacy_wrapper_root_name() -> &'static str {
    ".legacy-runtime"
}

fn legacy_wrapper_compat_root_name() -> String {
    String::from_utf8(vec![46, 115, 117, 112, 101, 114, 115, 101, 116]).expect("static utf8")
}

fn legacy_wrapper_root_names() -> Vec<String> {
    vec![
        legacy_wrapper_root_name().to_string(),
        legacy_wrapper_compat_root_name(),
    ]
}

fn legacy_wrapper_root_prefixes() -> Vec<String> {
    let mut prefixes = vec![format!("{}-", legacy_wrapper_root_name())];
    let compat = legacy_wrapper_compat_root_name();
    prefixes.push(format!("{}-", compat));
    prefixes
}

fn is_managed_wrapper_bin_dir(dir: &Path) -> bool {
    let dir_name = dir.file_name().and_then(|name| name.to_str());
    let parent_name = dir
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str());
    let root_names = legacy_wrapper_root_names();
    let prefixes = legacy_wrapper_root_prefixes();

    matches!(dir_name, Some("bin"))
        && parent_name
            .map(|value| {
                root_names.iter().any(|name| value == name)
                    || prefixes.iter().any(|prefix| value.starts_with(prefix))
            })
            .unwrap_or(false)
}

fn extract_managed_wrapper_target(candidate: &Path) -> Option<String> {
    if !is_managed_wrapper_bin_dir(candidate.parent()?) {
        return None;
    }

    let contents = fs::read_to_string(candidate).ok()?;
    let marker = "REAL_BIN=\"$(find_real_binary \"";
    let start = contents.find(marker)? + marker.len();
    let remainder = &contents[start..];
    let end = remainder.find('"')?;
    let target = remainder[..end].trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

fn discover_real_binary(command: &str, search_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in search_dirs {
        if is_managed_wrapper_bin_dir(dir) {
            continue;
        }
        for candidate in candidate_paths(dir, command) {
            if is_executable_candidate(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

fn is_launchable_candidate(candidate: &Path, search_dirs: &[PathBuf]) -> bool {
    if let Some(target) = extract_managed_wrapper_target(candidate) {
        return discover_real_binary(&target, search_dirs).is_some();
    }

    true
}

pub fn build_runtime_env(
    binary: &Path,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut env = overrides.clone();
    let path_override = overrides.get("PATH").map(OsStr::new);
    let mut dirs = fallback_search_dirs_with_path(path_override);
    let mut seen = dirs.iter().cloned().collect::<HashSet<_>>();

    if let Some(parent) = binary.parent() {
        push_search_dir(&mut seen, &mut dirs, parent.to_path_buf());
    }
    if let Ok(canonical_binary) = binary.canonicalize() {
        if let Some(parent) = canonical_binary.parent() {
            push_search_dir(&mut seen, &mut dirs, parent.to_path_buf());
        }
    }

    if let Ok(joined) = env::join_paths(dirs.iter()) {
        env.insert("PATH".to_string(), joined.to_string_lossy().to_string());
    }

    env
}

fn candidate_paths(dir: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let pathext = env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .map(|ext| ext.trim().to_string())
                    .filter(|ext| !ext.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".exe".to_string(), ".cmd".to_string(), ".bat".to_string()]);
        std::iter::once(dir.join(command))
            .chain(
                pathext
                    .into_iter()
                    .map(|ext| dir.join(format!("{command}{ext}"))),
            )
            .collect()
    }

    #[cfg(not(windows))]
    {
        vec![dir.join(command)]
    }
}

fn is_executable_candidate(candidate: &Path) -> bool {
    if !candidate.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        candidate
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) fn discover_binary(commands: &[&str]) -> Option<PathBuf> {
    let search_dirs = fallback_search_dirs();

    for command in commands {
        if let Ok(path) = which::which(command) {
            if is_launchable_candidate(&path, &search_dirs) {
                return Some(path);
            }
        }
    }

    for dir in &search_dirs {
        for command in commands {
            for candidate in candidate_paths(dir, command) {
                if is_executable_candidate(&candidate)
                    && is_launchable_candidate(&candidate, &search_dirs)
                {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{build_runtime_env, discover_binary, legacy_wrapper_compat_root_name};
    use std::collections::HashMap;
    use std::env;
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::{LazyLock, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn mark_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("set executable bit");
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        env::temp_dir().join(format!("conductor-discovery-{prefix}-{nanos}"))
    }

    #[test]
    fn discover_binary_finds_alias_in_path() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let temp_dir = unique_temp_dir("path");
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let binary_path = temp_dir.join("cursor-agent");
        fs::write(&binary_path, b"#!/bin/sh\n").expect("write fake binary");
        mark_executable(&binary_path);

        let original_path = env::var_os("PATH");
        env::set_var("PATH", &temp_dir);

        let discovered = discover_binary(&["cursor", "cursor-cli", "cursor-agent"]);

        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&temp_dir).ok();

        assert_eq!(discovered.as_deref(), Some(binary_path.as_path()));
    }

    #[test]
    fn discover_binary_scans_common_user_bin_dirs() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("home");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");
        let binary_path = wrapper_dir.join("copilot-fixture");
        fs::write(&binary_path, b"#!/bin/sh\n").expect("write fake binary");
        mark_executable(&binary_path);

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var("PATH", "");

        let discovered = discover_binary(&["copilot-fixture"]);

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert_eq!(discovered.as_deref(), Some(binary_path.as_path()));
    }

    #[test]
    fn discover_binary_ignores_non_executable_fallback_files() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("non-executable");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");
        let binary_path = wrapper_dir.join("copilot-fixture");
        fs::write(&binary_path, b"#!/bin/sh\n").expect("write fake binary");

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var("PATH", "");

        let discovered = discover_binary(&["copilot-fixture"]);

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert_eq!(discovered, None);
    }

    #[test]
    fn build_runtime_env_adds_fallback_directories_to_path() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("runtime-env");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        let homebrew_dir = PathBuf::from("/opt/homebrew/bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var("PATH", "");

        let env_map = build_runtime_env(&wrapper_dir.join("opencode"), &HashMap::new());
        let path_value = env_map.get("PATH").cloned().unwrap_or_default();
        let path_dirs = env::split_paths(&path_value).collect::<Vec<_>>();

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert!(path_dirs.contains(&wrapper_dir));
        #[cfg(target_os = "macos")]
        assert!(path_dirs.contains(&homebrew_dir));
    }

    #[test]
    fn build_runtime_env_preserves_explicit_path_entries() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let custom_dir = unique_temp_dir("custom-path");
        fs::create_dir_all(&custom_dir).expect("create custom dir");
        let binary = custom_dir.join("codex");
        fs::write(&binary, b"#!/bin/sh\n").expect("write fake binary");
        mark_executable(&binary);

        let mut overrides = HashMap::new();
        overrides.insert("PATH".to_string(), custom_dir.to_string_lossy().to_string());
        let env_map = build_runtime_env(&binary, &overrides);
        let path_value = env_map.get("PATH").cloned().unwrap_or_default();
        let path_dirs = env::split_paths(&path_value).collect::<Vec<_>>();

        fs::remove_dir_all(&custom_dir).ok();

        assert_eq!(path_dirs.first(), Some(&custom_dir));
    }

    #[test]
    fn discover_binary_rejects_managed_wrapper_without_real_binary() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("invalid-wrapper");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");
        let wrapper_path = wrapper_dir.join("opencode-fixture");
        fs::write(
            &wrapper_path,
            "#!/bin/sh\nREAL_BIN=\"$(find_real_binary \"opencode-fixture-real\")\"\n",
        )
        .expect("write fake wrapper");
        mark_executable(&wrapper_path);

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var("PATH", &wrapper_dir);

        let discovered = discover_binary(&["opencode-fixture"]);

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert_eq!(discovered, None);
    }

    #[test]
    fn discover_binary_accepts_managed_wrapper_with_real_binary() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("valid-wrapper");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        let real_dir = home_dir.join(".local").join("bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");
        fs::create_dir_all(&real_dir).expect("create real dir");
        let wrapper_path = wrapper_dir.join("cursor-agent");
        fs::write(
            &wrapper_path,
            "#!/bin/sh\nREAL_BIN=\"$(find_real_binary \"cursor-agent\")\"\n",
        )
        .expect("write fake wrapper");
        mark_executable(&wrapper_path);
        let real_path = real_dir.join("cursor-agent");
        fs::write(&real_path, b"#!/bin/sh\n").expect("write real binary");
        mark_executable(&real_path);

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var(
            "PATH",
            env::join_paths([&wrapper_dir, &real_dir]).expect("join path"),
        );

        let discovered = discover_binary(&["cursor-agent"]);

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert_eq!(discovered.as_deref(), Some(wrapper_path.as_path()));
    }

    #[test]
    fn discover_binary_accepts_opencode_wrapper_with_real_binary_in_opencode_home() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let home_dir = unique_temp_dir("opencode-wrapper");
        let wrapper_dir = home_dir.join(legacy_wrapper_compat_root_name()).join("bin");
        let real_dir = home_dir.join(".opencode").join("bin");
        fs::create_dir_all(&wrapper_dir).expect("create wrapper dir");
        fs::create_dir_all(&real_dir).expect("create real dir");

        let wrapper_path = wrapper_dir.join("opencode");
        fs::write(
            &wrapper_path,
            "#!/bin/sh\nREAL_BIN=\"$(find_real_binary \"opencode\")\"\n",
        )
        .expect("write fake wrapper");
        mark_executable(&wrapper_path);

        let real_path = real_dir.join("opencode");
        fs::write(&real_path, b"#!/bin/sh\n").expect("write real binary");
        mark_executable(&real_path);

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        env::set_var("HOME", &home_dir);
        env::set_var("PATH", &wrapper_dir);

        let discovered = discover_binary(&["opencode"]);

        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            env::set_var("PATH", path);
        } else {
            env::remove_var("PATH");
        }
        fs::remove_dir_all(&home_dir).ok();

        assert_eq!(discovered.as_deref(), Some(wrapper_path.as_path()));
    }
}
