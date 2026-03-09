use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::env;
use std::sync::Arc;
use tokio::process::Command;
use tokio::time::{Duration, sleep};

use crate::state::AppState;

const APP_UPDATE_CHECK_TTL_SECS: i64 = 5 * 60;
const APP_UPDATE_BACKGROUND_INTERVAL_SECS: u64 = 30 * 60;
const APP_UPDATE_LOG_TAIL_LIMIT: usize = 6000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppInstallMode {
    Source,
    Npx,
    GlobalNpm,
    GlobalPnpm,
    GlobalBun,
    Unknown,
}

impl AppInstallMode {
    fn from_env(value: Option<&str>) -> Self {
        match value.unwrap_or_default().trim() {
            "source" => Self::Source,
            "npx" => Self::Npx,
            "global-npm" => Self::GlobalNpm,
            "global-pnpm" => Self::GlobalPnpm,
            "global-bun" => Self::GlobalBun,
            _ => Self::Unknown,
        }
    }

    fn can_auto_update(self) -> bool {
        matches!(self, Self::GlobalNpm | Self::GlobalPnpm | Self::GlobalBun)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppUpdateJobStatus {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct AppUpdateConfig {
    pub package_name: Option<String>,
    pub current_version: Option<String>,
    pub install_mode: AppInstallMode,
    pub rerun_command: Option<String>,
    pub launcher_control_url: Option<String>,
    pub launcher_control_token: Option<String>,
}

impl AppUpdateConfig {
    pub fn from_env() -> Self {
        let package_name = env::var("CONDUCTOR_CLI_PACKAGE_NAME")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let current_version = env::var("CONDUCTOR_CLI_VERSION")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let install_mode =
            AppInstallMode::from_env(env::var("CONDUCTOR_CLI_INSTALL_MODE").ok().as_deref());
        let rerun_command = env::var("CONDUCTOR_CLI_RERUN_COMMAND")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let launcher_control_url = env::var("CONDUCTOR_LAUNCHER_CONTROL_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let launcher_control_token = env::var("CONDUCTOR_LAUNCHER_CONTROL_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        Self {
            package_name,
            current_version,
            install_mode,
            rerun_command,
            launcher_control_url,
            launcher_control_token,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub enabled: bool,
    pub reason: Option<String>,
    pub package_name: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<String>,
    pub error: Option<String>,
    pub install_mode: AppInstallMode,
    pub update_command: Option<String>,
    pub can_auto_update: bool,
    pub can_restart: bool,
    pub restarting: bool,
    pub job_status: AppUpdateJobStatus,
    pub job_message: Option<String>,
    pub job_started_at: Option<String>,
    pub job_updated_at: Option<String>,
    pub job_completed_at: Option<String>,
    pub logs_tail: Option<String>,
    pub restart_required: bool,
}

impl AppUpdateStatus {
    fn from_config(config: &AppUpdateConfig) -> Self {
        let reason = if config.package_name.is_none() || config.current_version.is_none() {
            Some("missing-cli-metadata".to_string())
        } else if matches!(config.install_mode, AppInstallMode::Source) {
            Some("source-checkout".to_string())
        } else {
            None
        };
        let enabled = reason.is_none();

        Self {
            enabled,
            reason,
            package_name: config.package_name.clone(),
            current_version: config.current_version.clone(),
            latest_version: None,
            update_available: false,
            checked_at: None,
            error: None,
            install_mode: config.install_mode,
            update_command: config.package_name.as_deref().and_then(|package_name| {
                build_update_command(
                    config.install_mode,
                    package_name,
                    config.rerun_command.as_deref(),
                )
            }),
            can_auto_update: config.install_mode.can_auto_update(),
            can_restart: config.launcher_control_url.is_some()
                && config.launcher_control_token.is_some(),
            restarting: false,
            job_status: AppUpdateJobStatus::Idle,
            job_message: None,
            job_started_at: None,
            job_updated_at: None,
            job_completed_at: None,
            logs_tail: None,
            restart_required: false,
        }
    }
}

#[derive(Debug)]
pub(crate) struct AppUpdateRuntime {
    pub status: AppUpdateStatus,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub installed_version: Option<String>,
    pub check_in_flight: bool,
    pub update_in_flight: bool,
}

impl AppUpdateRuntime {
    pub fn new(config: &AppUpdateConfig) -> Self {
        Self {
            status: AppUpdateStatus::from_config(config),
            last_checked_at: None,
            installed_version: config.current_version.clone(),
            check_in_flight: false,
            update_in_flight: false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct NpmLatestResponse {
    version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<String>,
}

fn build_update_command(
    install_mode: AppInstallMode,
    package_name: &str,
    rerun_command: Option<&str>,
) -> Option<String> {
    match install_mode {
        AppInstallMode::Npx => rerun_command
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| Some(format!("npx {package_name}@latest start"))),
        AppInstallMode::GlobalNpm => Some(format!("npm install -g {package_name}@latest")),
        AppInstallMode::GlobalPnpm => Some(format!("pnpm add -g {package_name}@latest")),
        AppInstallMode::GlobalBun => Some(format!("bun add -g {package_name}@latest")),
        AppInstallMode::Unknown => Some(format!("npm install -g {package_name}@latest")),
        AppInstallMode::Source => None,
    }
}

fn resolve_update_invocation(
    install_mode: AppInstallMode,
    package_name: &str,
) -> Option<(&'static str, Vec<String>, String)> {
    match install_mode {
        AppInstallMode::GlobalNpm => Some((
            "npm",
            vec![
                "install".to_string(),
                "-g".to_string(),
                format!("{package_name}@latest"),
            ],
            format!("npm install -g {package_name}@latest"),
        )),
        AppInstallMode::GlobalPnpm => Some((
            "pnpm",
            vec![
                "add".to_string(),
                "-g".to_string(),
                format!("{package_name}@latest"),
            ],
            format!("pnpm add -g {package_name}@latest"),
        )),
        AppInstallMode::GlobalBun => Some((
            "bun",
            vec![
                "add".to_string(),
                "-g".to_string(),
                format!("{package_name}@latest"),
            ],
            format!("bun add -g {package_name}@latest"),
        )),
        _ => None,
    }
}

fn trim_log_tail(value: &str) -> String {
    if value.len() <= APP_UPDATE_LOG_TAIL_LIMIT {
        return value.to_string();
    }
    value[value.len() - APP_UPDATE_LOG_TAIL_LIMIT..].to_string()
}

fn parse_version(value: &str) -> Option<ParsedVersion> {
    let value = value.trim().strip_prefix('v').unwrap_or(value.trim());
    let (base, prerelease) = match value.split_once('-') {
        Some((base, prerelease)) => (base, prerelease),
        None => (value, ""),
    };
    let mut segments = base.split('.');
    let major = segments.next()?.parse::<u64>().ok()?;
    let minor = segments.next()?.parse::<u64>().ok()?;
    let patch = segments.next()?.parse::<u64>().ok()?;
    if segments.next().is_some() {
        return None;
    }

    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease: prerelease
            .split('.')
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect(),
    })
}

fn compare_identifiers(left: &str, right: &str) -> Ordering {
    match (left.parse::<u64>(), right.parse::<u64>()) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        (Ok(_), Err(_)) => Ordering::Less,
        (Err(_), Ok(_)) => Ordering::Greater,
        (Err(_), Err(_)) => left.cmp(right),
    }
}

fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;

    let base_ordering = left
        .major
        .cmp(&right.major)
        .then(left.minor.cmp(&right.minor))
        .then(left.patch.cmp(&right.patch));
    if base_ordering != Ordering::Equal {
        return Some(base_ordering);
    }

    match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
        (true, true) => Some(Ordering::Equal),
        (true, false) => Some(Ordering::Greater),
        (false, true) => Some(Ordering::Less),
        (false, false) => {
            let max_len = left.prerelease.len().max(right.prerelease.len());
            for index in 0..max_len {
                match (left.prerelease.get(index), right.prerelease.get(index)) {
                    (Some(left), Some(right)) => {
                        let ordering = compare_identifiers(left, right);
                        if ordering != Ordering::Equal {
                            return Some(ordering);
                        }
                    }
                    (None, Some(_)) => return Some(Ordering::Less),
                    (Some(_), None) => return Some(Ordering::Greater),
                    (None, None) => break,
                }
            }
            Some(Ordering::Equal)
        }
    }
}

async fn fetch_latest_package_version(package_name: &str) -> Result<String> {
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        package_name.replace('/', "%2f")
    );
    let response = reqwest::Client::new().get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("npm registry returned {status}"));
    }
    let payload = response.json::<NpmLatestResponse>().await?;
    let version = payload
        .version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("npm registry response did not include a version"))?;
    Ok(version)
}

impl AppState {
    pub fn start_app_update_watchdog(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let _ = state.refresh_app_update(true).await;
            loop {
                sleep(Duration::from_secs(APP_UPDATE_BACKGROUND_INTERVAL_SECS)).await;
                let _ = state.refresh_app_update(false).await;
            }
        });
    }

    pub async fn app_update_snapshot(&self) -> AppUpdateStatus {
        self.app_update.lock().await.status.clone()
    }

    pub async fn refresh_app_update(self: &Arc<Self>, force: bool) -> AppUpdateStatus {
        let config = self.app_update_config.clone();
        let package_name = match config.package_name.clone() {
            Some(value) if !value.is_empty() => value,
            _ => return self.app_update_snapshot().await,
        };

        {
            let mut runtime = self.app_update.lock().await;
            if !runtime.status.enabled {
                return runtime.status.clone();
            }
            if runtime.update_in_flight || runtime.check_in_flight {
                return runtime.status.clone();
            }
            if !force
                && runtime
                    .last_checked_at
                    .map(|checked_at| {
                        (Utc::now() - checked_at).num_seconds() < APP_UPDATE_CHECK_TTL_SECS
                    })
                    .unwrap_or(false)
            {
                return runtime.status.clone();
            }
            runtime.check_in_flight = true;
        }

        let result = fetch_latest_package_version(&package_name).await;

        let snapshot = {
            let mut runtime = self.app_update.lock().await;
            runtime.check_in_flight = false;
            runtime.last_checked_at = Some(Utc::now());
            runtime.status.checked_at = Some(Utc::now().to_rfc3339());

            match result {
                Ok(latest_version) => {
                    let compare_target = runtime
                        .installed_version
                        .as_deref()
                        .or(runtime.status.current_version.as_deref())
                        .unwrap_or("");
                    let update_available = compare_versions(compare_target, &latest_version)
                        .map(|ordering| ordering == Ordering::Less)
                        .unwrap_or(compare_target != latest_version);

                    runtime.status.latest_version = Some(latest_version);
                    runtime.status.update_available = update_available;
                    runtime.status.error = None;
                }
                Err(error) => {
                    runtime.status.error = Some(error.to_string());
                    runtime.status.latest_version = None;
                    runtime.status.update_available = false;
                }
            }

            runtime.status.clone()
        };

        self.publish_snapshot().await;
        snapshot
    }

    pub async fn trigger_app_update(self: &Arc<Self>) -> Result<AppUpdateStatus> {
        let config = self.app_update_config.clone();
        let snapshot = self.refresh_app_update(true).await;

        let package_name = config
            .package_name
            .clone()
            .ok_or_else(|| anyhow!("Conductor update metadata is unavailable in this runtime."))?;
        let latest_version = snapshot
            .latest_version
            .clone()
            .ok_or_else(|| anyhow!("No newer Conductor version is available right now."))?;

        let (command, args, display_command) =
            resolve_update_invocation(config.install_mode, &package_name).ok_or_else(|| {
                anyhow!(
            "Automatic updates are unavailable for this install. Use the suggested command instead."
        )
            })?;

        let next_snapshot = {
            let mut runtime = self.app_update.lock().await;
            if !runtime.status.enabled {
                return Err(anyhow!(
                    "Conductor update metadata is unavailable in this runtime."
                ));
            }
            if runtime.update_in_flight {
                return Ok(runtime.status.clone());
            }
            if !runtime.status.update_available {
                return Err(anyhow!(
                    "No newer Conductor version is available right now."
                ));
            }

            let now = Utc::now().to_rfc3339();
            runtime.update_in_flight = true;
            runtime.status.job_status = AppUpdateJobStatus::Running;
            runtime.status.job_message = Some(format!("Running {display_command}"));
            runtime.status.job_started_at = Some(now.clone());
            runtime.status.job_updated_at = Some(now);
            runtime.status.job_completed_at = None;
            runtime.status.logs_tail = None;
            runtime.status.restart_required = false;
            runtime.status.restarting = false;
            runtime.status.clone()
        };
        self.publish_snapshot().await;

        let state = Arc::clone(self);
        tokio::spawn(async move {
            let result = Command::new(command)
                .args(&args)
                .env("NO_COLOR", "1")
                .output()
                .await;

            let finished_at = Utc::now().to_rfc3339();
            let next_snapshot = {
                let mut runtime = state.app_update.lock().await;
                runtime.update_in_flight = false;
                runtime.status.job_updated_at = Some(finished_at.clone());
                runtime.status.job_completed_at = Some(finished_at.clone());

                match result {
                    Ok(output) if output.status.success() => {
                        runtime.installed_version = Some(latest_version.clone());
                        runtime.last_checked_at = Some(Utc::now());
                        runtime.status.latest_version = Some(latest_version.clone());
                        runtime.status.update_available = false;
                        runtime.status.error = None;
                        runtime.status.job_status = AppUpdateJobStatus::Completed;
                        runtime.status.job_message = Some(format!(
                            "Installed {latest_version}. Restart Conductor to use the new version."
                        ));
                        runtime.status.restart_required = true;
                        runtime.status.restarting = false;
                        runtime.status.logs_tail = None;
                    }
                    Ok(output) => {
                        let combined_output = format!(
                            "{}{}{}",
                            String::from_utf8_lossy(&output.stdout),
                            if output.stdout.is_empty() || output.stderr.is_empty() {
                                ""
                            } else {
                                "\n"
                            },
                            String::from_utf8_lossy(&output.stderr),
                        );
                        runtime.status.job_status = AppUpdateJobStatus::Failed;
                        runtime.status.job_message = Some(format!(
                            "{display_command} exited with code {}.",
                            output.status.code().unwrap_or_default()
                        ));
                        runtime.status.restarting = false;
                        runtime.status.logs_tail = Some(trim_log_tail(combined_output.trim()));
                    }
                    Err(error) => {
                        runtime.status.job_status = AppUpdateJobStatus::Failed;
                        runtime.status.job_message = Some(error.to_string());
                        runtime.status.restarting = false;
                        runtime.status.logs_tail = None;
                    }
                }

                runtime.status.clone()
            };

            state.publish_snapshot().await;
            let _ = next_snapshot;
        });

        Ok(next_snapshot)
    }

    pub async fn trigger_app_restart(self: &Arc<Self>) -> Result<AppUpdateStatus> {
        let config = self.app_update_config.clone();
        let control_url = config
            .launcher_control_url
            .clone()
            .ok_or_else(|| anyhow!("Launcher restart control is unavailable for this runtime."))?;
        let control_token = config
            .launcher_control_token
            .clone()
            .ok_or_else(|| anyhow!("Launcher restart control is unavailable for this runtime."))?;

        let snapshot = self.app_update_snapshot().await;
        if !snapshot.restart_required {
            return Err(anyhow!(
                "Restart is only available after the update has been installed."
            ));
        }

        let restart_snapshot = {
            let mut runtime = self.app_update.lock().await;
            runtime.status.restarting = true;
            runtime.status.job_updated_at = Some(Utc::now().to_rfc3339());
            runtime.status.job_message = Some("Restarting Conductor...".to_string());
            runtime.status.clone()
        };
        self.publish_snapshot().await;

        let response = reqwest::Client::new()
            .post(format!("{control_url}/restart"))
            .bearer_auth(control_token)
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                {
                    let mut runtime = self.app_update.lock().await;
                    runtime.status.restarting = false;
                    runtime.status.job_updated_at = Some(Utc::now().to_rfc3339());
                    runtime.status.job_message = Some("Restart failed. Try again.".to_string());
                }
                self.publish_snapshot().await;
                return Err(error.into());
            }
        };

        if !response.status().is_success() {
            {
                let mut runtime = self.app_update.lock().await;
                runtime.status.restarting = false;
                runtime.status.job_updated_at = Some(Utc::now().to_rfc3339());
                runtime.status.job_message = Some("Restart failed. Try again.".to_string());
            }
            self.publish_snapshot().await;
            return Err(anyhow!(
                "Launcher restart request failed with status {}.",
                response.status()
            ));
        }

        Ok(restart_snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_versions_orders_release_and_prerelease_values() {
        assert_eq!(compare_versions("0.2.8", "0.2.9"), Some(Ordering::Less));
        assert_eq!(compare_versions("0.2.9", "0.2.9"), Some(Ordering::Equal));
        assert_eq!(
            compare_versions("0.3.0-beta.1", "0.3.0"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_versions("0.3.0", "0.3.0-beta.1"),
            Some(Ordering::Greater)
        );
    }

    #[test]
    fn build_update_command_matches_install_mode() {
        assert_eq!(
            build_update_command(AppInstallMode::Npx, "conductor-oss", None),
            Some("npx conductor-oss@latest start".to_string())
        );
        assert_eq!(
            build_update_command(AppInstallMode::GlobalNpm, "conductor-oss", None),
            Some("npm install -g conductor-oss@latest".to_string())
        );
        assert_eq!(
            build_update_command(AppInstallMode::Source, "conductor-oss", None),
            None
        );
    }

    #[test]
    fn build_update_command_prefers_launcher_rerun_command_for_npx() {
        assert_eq!(
            build_update_command(
                AppInstallMode::Npx,
                "conductor-oss",
                Some("npx conductor-oss@latest start --workspace demo"),
            ),
            Some("npx conductor-oss@latest start --workspace demo".to_string())
        );
    }
}
