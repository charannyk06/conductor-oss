use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use conductor_core::config::ConductorConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/filesystem/directory", get(read_directory))
        .route("/api/filesystem/pick-directory", post(pick_directory))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn read_directory(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DirectoryQuery>,
) -> ApiResponse {
    let config = state.config.read().await.clone();
    let browse_roots = allowed_browse_roots(&state.workspace_path, &config);
    let requested = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let path = requested
        .map(|value| expand_path(value, &state.workspace_path))
        .unwrap_or_else(|| state.workspace_path.clone());
    let current_path = if path.is_file() {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    } else {
        path
    };

    if !current_path.exists() {
        return error(StatusCode::NOT_FOUND, "Directory not found");
    }

    let Ok(current_path) = resolve_browse_path(&current_path, &browse_roots) else {
        return error(
            StatusCode::FORBIDDEN,
            "Access to this directory is not allowed",
        );
    };
    if !current_path.is_dir() {
        return error(StatusCode::BAD_REQUEST, "Path is not a directory");
    }

    let entries = std::fs::read_dir(&current_path)
        .map_err(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
        .map(|entries| {
            let mut items = entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    let file_type = entry.file_type().ok();
                    let resolved_path = resolved_entry_path(&path, file_type.as_ref());
                    let is_directory = resolved_path
                        .as_deref()
                        .map(Path::is_dir)
                        .or_else(|| file_type.as_ref().map(|value| value.is_dir()))
                        .unwrap_or(false);
                    let access_path = resolved_path.as_deref().unwrap_or(path.as_path());

                    if !is_visible_entry(access_path, is_directory, &browse_roots) {
                        return None;
                    }

                    Some(json!({
                        "name": entry.file_name().to_string_lossy().to_string(),
                        "path": path.to_string_lossy().to_string(),
                        "isDirectory": is_directory,
                        "isGitRepo": is_directory && path.join(".git").exists(),
                    }))
                })
                .collect::<Vec<_>>();
            items.sort_by(|left, right| {
                let left_dir = left["isDirectory"].as_bool().unwrap_or(false);
                let right_dir = right["isDirectory"].as_bool().unwrap_or(false);
                right_dir.cmp(&left_dir).then_with(|| {
                    left["name"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(right["name"].as_str().unwrap_or_default())
                })
            });
            items
        });

    match entries {
        Ok(items) => ok(json!({
            "currentPath": current_path.to_string_lossy().to_string(),
            "entries": items,
        })),
        Err(response) => response,
    }
}

fn resolve_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            Some(PathBuf::from(format!(
                "{}{}",
                drive.to_string_lossy(),
                path.to_string_lossy()
            )))
        })
}

/// Allowed root directories for filesystem browsing.
pub(crate) fn allowed_browse_roots(
    workspace_path: &Path,
    config: &ConductorConfig,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = resolve_user_home_dir() {
        roots.push(home);
    }
    roots.push(workspace_path.to_path_buf());
    roots.extend(
        config
            .preferences
            .filesystem_browse_roots
            .iter()
            .map(|value| expand_path(value, workspace_path)),
    );
    dedupe_browse_roots(roots)
}

fn dedupe_browse_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for root in roots {
        if root.as_os_str().is_empty() {
            continue;
        }
        let canonical = canonicalize_for_access(&root);
        if deduped.iter().any(|existing| existing == &canonical) {
            continue;
        }
        deduped.push(canonical);
    }
    deduped
}

fn canonicalize_for_access(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn resolve_browse_path(path: &Path, browse_roots: &[PathBuf]) -> Result<PathBuf, ()> {
    let resolved = std::fs::canonicalize(path).map_err(|_| ())?;
    is_browsable_directory(&resolved, browse_roots)
        .then_some(resolved)
        .ok_or(())
}

fn resolved_entry_path(path: &Path, file_type: Option<&std::fs::FileType>) -> Option<PathBuf> {
    file_type
        .filter(|value| value.is_symlink())
        .and_then(|_| std::fs::canonicalize(path).ok())
}

fn is_path_within_root(path: &Path, root: &Path) -> bool {
    let path = canonicalize_for_access(path);
    let root = canonicalize_for_access(root);
    path.starts_with(root)
}

fn is_path_ancestor_of_root(path: &Path, root: &Path) -> bool {
    let path = canonicalize_for_access(path);
    let root = canonicalize_for_access(root);
    root.starts_with(path)
}

fn is_browsable_directory(path: &Path, browse_roots: &[PathBuf]) -> bool {
    browse_roots
        .iter()
        .any(|root| is_path_within_root(path, root) || is_path_ancestor_of_root(path, root))
}

fn is_browsable_file(path: &Path, browse_roots: &[PathBuf]) -> bool {
    browse_roots
        .iter()
        .any(|root| is_path_within_root(path, root))
}

fn is_visible_entry(path: &Path, is_directory: bool, browse_roots: &[PathBuf]) -> bool {
    if is_directory {
        is_browsable_directory(path, browse_roots)
    } else {
        is_browsable_file(path, browse_roots)
    }
}

pub(crate) fn expand_path(value: &str, workspace_path: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = resolve_user_home_dir() {
            return home.join(stripped);
        }
    }
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

async fn pick_directory() -> ApiResponse {
    let result = if cfg!(target_os = "macos") {
        tokio::process::Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Select a folder\")",
            ])
            .output()
            .await
    } else if cfg!(target_os = "windows") {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select a folder"
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
"#;
        tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .await
    } else {
        // Linux: try zenity
        tokio::process::Command::new("zenity")
            .args(["--file-selection", "--directory", "--title=Select a folder"])
            .output()
            .await
    };

    match result {
        Ok(output) => {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !output.status.success() || path.is_empty() {
                return ok(json!({ "cancelled": true }));
            }
            let clean = path.trim_end_matches(['/', '\\']);
            let final_path = if clean.is_empty() {
                path
            } else {
                clean.to_string()
            };
            ok(json!({ "path": final_path }))
        }
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_browse_roots, is_browsable_directory, is_browsable_file, is_visible_entry,
        resolve_browse_path,
    };
    use conductor_core::config::ConductorConfig;
    use std::fs;

    #[test]
    fn allowed_root_check_rejects_workspace_relative_path_traversal() {
        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let workspace_path = root.join("workspace");
        let outside_path = root.join("outside");
        fs::create_dir_all(&workspace_path).unwrap();
        fs::create_dir_all(&outside_path).unwrap();

        let browse_roots = vec![workspace_path.clone()];

        assert!(is_browsable_directory(&workspace_path, &browse_roots));
        assert!(!is_browsable_directory(&outside_path, &browse_roots));

        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_browse_path_rejects_symlink_escape_from_workspace() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let workspace_path = root.join("workspace");
        let outside_path = root.join("outside");
        let symlink_path = workspace_path.join("escape");
        fs::create_dir_all(&workspace_path).unwrap();
        fs::create_dir_all(&outside_path).unwrap();
        symlink(&outside_path, &symlink_path).unwrap();

        let browse_roots = vec![workspace_path.clone()];

        assert!(resolve_browse_path(&workspace_path, &browse_roots).is_ok());
        assert!(resolve_browse_path(&symlink_path, &browse_roots).is_err());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn browse_path_allows_ancestor_directories_of_configured_roots() {
        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let allowed_root = root.join("Users").join("charann");
        fs::create_dir_all(&allowed_root).unwrap();

        let browse_roots = vec![allowed_root.clone()];

        assert!(resolve_browse_path(&root, &browse_roots).is_ok());
        assert!(resolve_browse_path(&root.join("Users"), &browse_roots).is_ok());
        assert!(resolve_browse_path(&allowed_root, &browse_roots).is_ok());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn visible_entries_hide_unreachable_directories_but_keep_ancestors() {
        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let allowed_root = root.join("Users").join("charann");
        let blocked_root = root.join("Applications");
        let file_path = allowed_root.join("notes.txt");
        fs::create_dir_all(&allowed_root).unwrap();
        fs::create_dir_all(&blocked_root).unwrap();
        fs::write(&file_path, "ok").unwrap();

        let browse_roots = vec![allowed_root.clone()];

        assert!(is_visible_entry(&root.join("Users"), true, &browse_roots));
        assert!(is_visible_entry(&allowed_root, true, &browse_roots));
        assert!(!is_visible_entry(&blocked_root, true, &browse_roots));
        assert!(is_visible_entry(&file_path, false, &browse_roots));
        assert!(!is_browsable_file(&blocked_root.join("app"), &browse_roots));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn default_browse_roots_do_not_include_system_wide_roots() {
        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let workspace_path = root.join("workspace");
        fs::create_dir_all(&workspace_path).unwrap();

        let roots = allowed_browse_roots(&workspace_path, &ConductorConfig::default());
        let canonical_workspace = std::fs::canonicalize(&workspace_path).unwrap();

        assert!(roots.iter().any(|entry| entry == &canonical_workspace));
        assert!(!roots
            .iter()
            .any(|entry| entry == std::path::Path::new("/Users")));
        assert!(!roots
            .iter()
            .any(|entry| entry == std::path::Path::new("/Volumes")));
        assert!(!roots
            .iter()
            .any(|entry| entry == std::path::Path::new("/home")));
        assert!(!roots
            .iter()
            .any(|entry| entry == std::path::Path::new("/opt")));

        fs::remove_dir_all(&root).unwrap();
    }
}
