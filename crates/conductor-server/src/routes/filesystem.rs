use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
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

    let Ok(current_path) = resolve_browse_path(&current_path, &state.workspace_path) else {
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

                    if let Some(resolved_path) = resolved_path.as_deref() {
                        if !is_within_allowed_roots(resolved_path, &state.workspace_path) {
                            return None;
                        }
                    }

                    let is_directory = resolved_path
                        .as_deref()
                        .map(Path::is_dir)
                        .or_else(|| file_type.as_ref().map(|value| value.is_dir()))
                        .unwrap_or(false);
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

/// Allowed root directories for filesystem browsing.
fn allowed_browse_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        roots.push(home);
    }
    // On macOS, /Volumes is common for external drives.
    #[cfg(target_os = "macos")]
    roots.push(PathBuf::from("/Volumes"));
    // On Linux, common project locations.
    #[cfg(target_os = "linux")]
    {
        roots.push(PathBuf::from("/home"));
        roots.push(PathBuf::from("/opt"));
    }
    roots
}

fn canonicalize_for_access(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn resolve_browse_path(path: &Path, workspace_path: &Path) -> Result<PathBuf, ()> {
    let resolved = std::fs::canonicalize(path).map_err(|_| ())?;
    is_within_allowed_roots(&resolved, workspace_path)
        .then_some(resolved)
        .ok_or(())
}

fn resolved_entry_path(path: &Path, file_type: Option<&std::fs::FileType>) -> Option<PathBuf> {
    file_type
        .filter(|value| value.is_symlink())
        .and_then(|_| std::fs::canonicalize(path).ok())
}

fn is_within_allowed_roots(path: &Path, workspace_path: &Path) -> bool {
    let path = canonicalize_for_access(path);
    let workspace_path = canonicalize_for_access(workspace_path);

    // Always allow workspace path itself.
    if path.starts_with(workspace_path) {
        return true;
    }

    // Check against allowed roots.
    let roots = allowed_browse_roots();
    roots
        .into_iter()
        .map(|root| canonicalize_for_access(&root))
        .any(|root| path.starts_with(root))
}

fn expand_path(value: &str, workspace_path: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
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
    use super::{is_within_allowed_roots, resolve_browse_path};
    use std::fs;

    #[test]
    fn allowed_root_check_rejects_workspace_relative_path_traversal() {
        let root =
            std::env::temp_dir().join(format!("conductor-filesystem-{}", uuid::Uuid::new_v4()));
        let workspace_path = root.join("workspace");
        let outside_path = root.join("outside");
        fs::create_dir_all(&workspace_path).unwrap();
        fs::create_dir_all(&outside_path).unwrap();

        let traversal_path = workspace_path.join("..").join("outside");

        assert!(is_within_allowed_roots(&workspace_path, &workspace_path));
        assert!(!is_within_allowed_roots(&traversal_path, &workspace_path));

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

        assert!(resolve_browse_path(&workspace_path, &workspace_path).is_ok());
        assert!(resolve_browse_path(&symlink_path, &workspace_path).is_err());

        fs::remove_dir_all(&root).unwrap();
    }
}
