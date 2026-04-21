use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{
    spawn_process, spawn_process_no_stdin_with_clean_env, spawn_process_with_env_removals,
};

/// OpenAI Codex CLI executor.
#[derive(Clone)]
pub struct CodexExecutor {
    binary: PathBuf,
}

fn build_codex_spawn_env(overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SHELL",
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "USER",
        "USERNAME",
        "LOGNAME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "TERM",
        "COLORTERM",
        "__CF_USER_TEXT_ENCODING",
        "VIRTUAL_ENV",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "SSH_AUTH_SOCK",
        "SYSTEMROOT",
        "XPC_FLAGS",
        "XPC_SERVICE_NAME",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    env.extend(overrides.clone());
    env
}

fn codex_clean_env_removals(allowed_env: &HashMap<String, String>) -> Vec<String> {
    std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| !allowed_env.contains_key(key))
        .collect()
}

fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }

    Ok(())
}

fn clone_or_link_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::copy(source, destination)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn strip_mcp_servers_from_codex_config(config: &str) -> String {
    let sanitized = toml::from_str::<toml::Value>(config)
        .ok()
        .and_then(|mut value| {
            value.as_table_mut()?.remove("mcp_servers");
            toml::to_string(&value).ok()
        })
        .unwrap_or_else(|| strip_mcp_servers_from_codex_config_fallback(config));

    if config.ends_with('\n') && !sanitized.ends_with('\n') {
        format!("{sanitized}\n")
    } else {
        sanitized
    }
}

fn strip_mcp_servers_from_codex_config_fallback(config: &str) -> String {
    let mut sanitized = Vec::new();
    let mut skipping_mcp_section = false;

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let table_name = trimmed.trim_matches(|ch| ch == '[' || ch == ']');
            skipping_mcp_section =
                table_name == "mcp_servers" || table_name.starts_with("mcp_servers.");
            if skipping_mcp_section {
                continue;
            }
        }

        if !skipping_mcp_section {
            sanitized.push(line);
        }
    }

    let mut sanitized_config = sanitized.join("\n");
    if config.ends_with('\n') {
        sanitized_config.push('\n');
    }

    sanitized_config
}

fn seed_isolated_codex_home(source_home: &Path, target_home: &Path) -> std::io::Result<()> {
    let source_codex_dir = source_home.join(".codex");
    let target_codex_dir = target_home.join(".codex");
    create_private_dir_all(target_home)?;
    create_private_dir_all(&target_codex_dir)?;

    let source_auth = source_codex_dir.join("auth.json");
    if source_auth.is_file() {
        clone_or_link_file(&source_auth, &target_codex_dir.join("auth.json"))?;
    }

    let source_version = source_codex_dir.join("version.json");
    if source_version.is_file() {
        std::fs::copy(&source_version, target_codex_dir.join("version.json"))?;
    }

    let source_config = source_codex_dir.join("config.toml");
    if source_config.is_file() {
        let config = std::fs::read_to_string(&source_config)?;
        let sanitized = strip_mcp_servers_from_codex_config(&config);
        std::fs::write(target_codex_dir.join("config.toml"), sanitized)?;
    }

    Ok(())
}

fn next_headless_codex_home_path(source_home: &Path) -> PathBuf {
    source_home
        .join(".conductor")
        .join("codex-headless")
        .join(Uuid::new_v4().to_string())
}

fn resolve_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn apply_headless_codex_env(
    env: &mut HashMap<String, String>,
    headless_home: &Path,
) -> std::io::Result<()> {
    env.insert(
        "HOME".to_string(),
        headless_home.to_string_lossy().to_string(),
    );

    #[cfg(windows)]
    {
        let roaming = headless_home.join("AppData").join("Roaming");
        let local = headless_home.join("AppData").join("Local");
        create_private_dir_all(&roaming)?;
        create_private_dir_all(&local)?;
        env.insert(
            "USERPROFILE".to_string(),
            headless_home.to_string_lossy().to_string(),
        );
        env.insert("APPDATA".to_string(), roaming.to_string_lossy().to_string());
        env.insert(
            "LOCALAPPDATA".to_string(),
            local.to_string_lossy().to_string(),
        );
    }

    Ok(())
}

fn prepare_headless_codex_home() -> std::io::Result<Option<PathBuf>> {
    let Some(source_home) = resolve_home_dir() else {
        return Ok(None);
    };

    let target_home = next_headless_codex_home_path(&source_home);
    seed_isolated_codex_home(&source_home, &target_home)?;
    Ok(Some(target_home))
}

fn wrap_codex_output_with_home_cleanup(
    headless_home: Option<PathBuf>,
    mut output_rx: mpsc::Receiver<ExecutorOutput>,
) -> mpsc::Receiver<ExecutorOutput> {
    let (cleanup_tx, cleanup_rx) = mpsc::channel(1024);

    tokio::spawn(async move {
        while let Some(event) = output_rx.recv().await {
            if cleanup_tx.send(event).await.is_err() {
                break;
            }
        }

        if let Some(headless_home) = headless_home {
            let _ = tokio::fs::remove_dir_all(headless_home).await;
        }
    });

    cleanup_rx
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") | ("linux", "arm64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") | ("macos", "arm64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") | ("windows", "arm64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_platform_package(target_triple: &str) -> Option<&'static str> {
    match target_triple {
        "x86_64-unknown-linux-musl" => Some("@openai/codex-linux-x64"),
        "aarch64-unknown-linux-musl" => Some("@openai/codex-linux-arm64"),
        "x86_64-apple-darwin" => Some("@openai/codex-darwin-x64"),
        "aarch64-apple-darwin" => Some("@openai/codex-darwin-arm64"),
        "x86_64-pc-windows-msvc" => Some("@openai/codex-win32-x64"),
        "aarch64-pc-windows-msvc" => Some("@openai/codex-win32-arm64"),
        _ => None,
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if let Ok(metadata) = std::fs::metadata(path) {
            return metadata.permissions().mode() & 0o111 != 0;
        }
        false
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_native_codex_binary(binary: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf());
    let is_node_wrapper = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("js"))
        .unwrap_or(false)
        && canonical
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("codex.js"))
            .unwrap_or(false);

    if !is_node_wrapper {
        return canonical;
    }

    let Some(target_triple) = codex_target_triple() else {
        return canonical;
    };
    let binary_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let Some(package_root) = canonical.parent().and_then(Path::parent) else {
        return canonical;
    };

    let local_candidate = package_root
        .join("vendor")
        .join(target_triple)
        .join("codex")
        .join(binary_name);
    if is_executable_file(&local_candidate) {
        return local_candidate;
    }

    let Some(platform_package) = codex_platform_package(target_triple) else {
        return canonical;
    };
    let packaged_candidate = package_root
        .join("node_modules")
        .join(platform_package)
        .join("vendor")
        .join(target_triple)
        .join("codex")
        .join(binary_name);
    if is_executable_file(&packaged_candidate) {
        return packaged_candidate;
    }

    canonical
}

impl CodexExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self {
            binary: resolve_native_codex_binary(&binary),
        }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["codex"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for CodexExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn name(&self) -> &str {
        "Codex"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let mut env = build_codex_spawn_env(&options.env);
        let headless_home = if options.structured_output {
            let headless_home = prepare_headless_codex_home()?;
            if let Some(ref headless_home) = headless_home {
                apply_headless_codex_env(&mut env, headless_home)?;
            }
            headless_home
        } else {
            None
        };
        let needs_stdin = options.structured_output && args.iter().any(|arg| arg == "-");
        let spawn_result = if options.structured_output && !needs_stdin {
            spawn_process_no_stdin_with_clean_env(&self.binary, &args, &options.cwd, &env).await
        } else if options.structured_output {
            let env_remove = codex_clean_env_removals(&env);
            spawn_process_with_env_removals(&self.binary, &args, &options.cwd, &env, &env_remove)
                .await
        } else {
            spawn_process(&self.binary, &args, &options.cwd, &env).await
        };
        let handle = match spawn_result {
            Ok(handle) => handle,
            Err(error) => {
                if let Some(headless_home) = headless_home.clone() {
                    let _ = tokio::fs::remove_dir_all(headless_home).await;
                }
                return Err(error);
            }
        };
        let output_rx = wrap_parsed_output(self.clone(), handle.output_rx);
        let output_rx = wrap_codex_output_with_home_cleanup(headless_home, output_rx);

        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            output_rx,
            handle.input_tx,
            handle.kill_tx,
        )
        .with_terminal_io(handle.terminal_rx, handle.resize_tx))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        if options.structured_output {
            let mut args = vec![
                "exec".to_string(),
                "--color".to_string(),
                "never".to_string(),
            ];

            if options.resume_target.is_some() {
                args.push("resume".to_string());
            }

            args.push("--json".to_string());
            args.push("--skip-git-repo-check".to_string());

            if options.skip_permissions {
                args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
            }

            args.extend(options.sanitized_extra_args());

            if let Some(resume_target) = &options.resume_target {
                args.push(resume_target.clone());
                if options.prompt.trim().is_empty() {
                    args.push("-".to_string());
                } else {
                    args.push(options.prompt.clone());
                }
            } else {
                // codex exec takes the prompt as a positional argument in headless mode.
                args.push(options.prompt.clone());
            }

            return args;
        }

        if options.interactive {
            let mut args = vec!["--no-alt-screen".to_string()];

            if let Some(resume_target) = &options.resume_target {
                args.push("resume".to_string());

                if let Some(model) = &options.model {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }

                if let Some(reasoning_effort) = &options.reasoning_effort {
                    args.push("-c".to_string());
                    args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
                }

                if options.skip_permissions {
                    args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
                }

                args.extend(options.sanitized_extra_args());
                args.push(resume_target.clone());
                return args;
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
            }

            if options.skip_permissions {
                args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
            }

            args.extend(options.sanitized_extra_args());
            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "exec".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--json".to_string(),
            "--skip-git-repo-check".to_string(),
        ];

        if options.skip_permissions {
            args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        }

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(reasoning_effort) = &options.reasoning_effort {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
        }

        args.extend(options.sanitized_extra_args());

        // codex exec takes the prompt as a positional argument in headless mode.
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if let Some(event_type) = value.get("type").and_then(|v| v.as_str()) {
                match event_type {
                    "agent_message" => {
                        if let Some(text) = extract_text(&value) {
                            return ExecutorOutput::Stdout(text);
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "agent_message_delta" => {
                        if let Some(text) = extract_text(&value) {
                            return ExecutorOutput::Stdout(text);
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "thread.started" => {
                        if let Some(thread_id) = value
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                        {
                            let mut metadata = HashMap::new();
                            metadata.insert(
                                "eventKind".to_string(),
                                Value::String("thread_started".to_string()),
                            );
                            metadata.insert(
                                "codexThreadId".to_string(),
                                Value::String(thread_id.to_string()),
                            );
                            return ExecutorOutput::StructuredStatus {
                                text: String::new(),
                                metadata,
                            };
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "turn.started" | "turn.completed" | "task.started" => {
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "item.started" => {
                        if let Some(item) = value.get("item") {
                            match item.get("type").and_then(|v| v.as_str()) {
                                Some("command_execution") => {
                                    if let Some(command) = item
                                        .get("command")
                                        .and_then(|v| v.as_str())
                                        .map(str::trim)
                                        .filter(|v| !v.is_empty())
                                    {
                                        return ExecutorOutput::StructuredStatus {
                                            text: "Command".to_string(),
                                            metadata: tool_metadata(
                                                "command",
                                                "Command",
                                                "running",
                                                vec![command.to_string()],
                                            ),
                                        };
                                    }
                                }
                                Some("reasoning") => {
                                    return ExecutorOutput::StructuredStatus {
                                        text: "Thinking".to_string(),
                                        metadata: tool_metadata(
                                            "thinking",
                                            "Thinking",
                                            "running",
                                            Vec::new(),
                                        ),
                                    };
                                }
                                Some("mcp_tool_call") => {
                                    return ExecutorOutput::StructuredStatus {
                                        text: tool_title_from_item(item),
                                        metadata: tool_metadata(
                                            &tool_kind_from_item(item),
                                            &tool_title_from_item(item),
                                            "running",
                                            tool_content_from_item(item),
                                        ),
                                    };
                                }
                                _ => {}
                            }
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "item.completed" => {
                        if let Some(item) = value.get("item") {
                            match item.get("type").and_then(|v| v.as_str()) {
                                Some("agent_message") => {
                                    if let Some(text) = extract_text(item) {
                                        return ExecutorOutput::Stdout(text);
                                    }
                                }
                                Some("reasoning") => return ExecutorOutput::Stdout(String::new()),
                                Some("command_execution") => {
                                    return ExecutorOutput::Stdout(String::new())
                                }
                                Some("mcp_tool_call") => {
                                    return ExecutorOutput::Stdout(String::new())
                                }
                                _ => {}
                            }
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "error" => {
                        let error = value
                            .get("message")
                            .and_then(|v| v.as_str())
                            .or_else(|| value.get("error").and_then(|v| v.as_str()))
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .unwrap_or("Codex failed")
                            .to_string();
                        return ExecutorOutput::Failed {
                            error,
                            exit_code: Some(1),
                        };
                    }
                    _ => return ExecutorOutput::Stdout(String::new()),
                }
            }

            if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                match method {
                    "message" => {
                        if let Some(content) = value
                            .get("params")
                            .and_then(|p| p.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            return ExecutorOutput::Stdout(content.to_string());
                        }
                    }
                    "done" => return ExecutorOutput::Completed { exit_code: 0 },
                    _ => return ExecutorOutput::Stdout(String::new()),
                }
            }

            return ExecutorOutput::Stdout(String::new());
        }

        if is_internal_codex_log_line(trimmed) {
            return ExecutorOutput::Stdout(String::new());
        }

        ExecutorOutput::Stdout(trimmed.to_string())
    }
}

fn is_internal_codex_log_line(line: &str) -> bool {
    // Filter non-JSON stderr noise that Codex emits after process completion.
    if line == "Reading additional input from stdin..." {
        return true;
    }

    let mut parts = line.split_whitespace();
    let Some(timestamp) = parts.next() else {
        return false;
    };
    let Some(level) = parts.next() else {
        return false;
    };
    if !looks_like_iso8601_timestamp(timestamp) {
        return false;
    }
    if !matches!(level, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return false;
    }

    let Some(target) = parts.next() else {
        return false;
    };
    if target.ends_with(':') && target.contains("::") {
        return true;
    }

    let remainder = std::iter::once(target)
        .chain(parts)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    remainder.contains("failed to list resources for mcp server")
        || remainder.contains("failed to list resource templates for mcp server")
        || remainder.contains("mcp error: -32601: method not found")
}

fn looks_like_iso8601_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && value.ends_with('Z')
}

fn tool_title_from_item(item: &Value) -> String {
    if let Some(tool) = item
        .get("tool")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return tool
            .split(['_', '-'])
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                let lower = segment.to_ascii_lowercase();
                match lower.as_str() {
                    "mcp" => "MCP".to_string(),
                    _ => {
                        let mut chars = lower.chars();
                        match chars.next() {
                            Some(first) => {
                                format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                            }
                            None => String::new(),
                        }
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }

    "Tool".to_string()
}

fn tool_kind_from_item(item: &Value) -> String {
    item.get("tool")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("tool")
        .to_ascii_lowercase()
}

fn tool_content_from_item(item: &Value) -> Vec<String> {
    let mut content = Vec::new();
    if let Some(server) = item
        .get("server")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        content.push(format!("server: {server}"));
    }
    if let Some(arguments) = item.get("arguments") {
        if let Some(path) = arguments
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            content.push(path.to_string());
        } else if let Some(pattern) = arguments
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            content.push(pattern.to_string());
        } else if let Ok(serialized) = serde_json::to_string(arguments) {
            if !serialized.trim().is_empty() && serialized != "{}" {
                content.push(serialized);
            }
        }
    }
    content
}

fn tool_metadata(
    tool_kind: &str,
    tool_title: &str,
    tool_status: &str,
    tool_content: Vec<String>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert("toolKind".to_string(), Value::String(tool_kind.to_string()));
    metadata.insert(
        "toolTitle".to_string(),
        Value::String(tool_title.to_string()),
    );
    metadata.insert(
        "toolStatus".to_string(),
        Value::String(tool_status.to_string()),
    );
    metadata.insert(
        "toolContent".to_string(),
        Value::Array(tool_content.into_iter().map(Value::String).collect()),
    );
    metadata
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(message) = value.get("message") {
        if let Some(text) = extract_text(message) {
            return Some(text);
        }
    }

    let content = value.get("content").and_then(|v| v.as_array())?;
    let text = content
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(|v| v.as_str())
                .or_else(|| item.as_str())
                .map(str::trim)
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::Executor;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::time::{timeout, Duration};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("conductor-codex-{prefix}-{nanos}"))
    }

    fn mark_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("set executable bit");
        }
    }

    #[test]
    fn next_headless_codex_home_path_is_unique() {
        let source_home = unique_temp_dir("headless-home-root");
        let first = next_headless_codex_home_path(&source_home);
        let second = next_headless_codex_home_path(&source_home);
        assert_ne!(first, second);
        assert!(first.to_string_lossy().contains("codex-headless"));
        assert!(second.to_string_lossy().contains("codex-headless"));
    }

    #[test]
    fn strip_mcp_servers_from_codex_config_preserves_non_mcp_settings() {
        let config = concat!(
            "model = \"gpt-5.4\"\n",
            "approval_policy = \"never\"\n\n",
            "[profiles.default]\n",
            "model = \"gpt-5.4\"\n\n",
            "[mcp_servers.memory]\n",
            "command = \"npx\"\n\n",
            "[tools]\n",
            "web_search = true\n"
        );

        let sanitized = strip_mcp_servers_from_codex_config(config);
        assert!(sanitized.contains("approval_policy = \"never\""));
        assert!(sanitized.contains("[profiles.default]"));
        assert!(sanitized.contains("[tools]"));
        assert!(!sanitized.contains("mcp_servers"));
    }

    #[test]
    fn strip_mcp_servers_from_codex_config_removes_dotted_keys() {
        let config = concat!(
            "model = \"gpt-5.4\"\n",
            "mcp_servers.memory.command = \"npx\"\n",
            "mcp_servers.memory.args = [\"-y\", \"demo\"]\n",
            "approval_policy = \"never\"\n"
        );

        let sanitized = strip_mcp_servers_from_codex_config(config);
        assert!(sanitized.contains("model = \"gpt-5.4\""));
        assert!(sanitized.contains("approval_policy = \"never\""));
        assert!(!sanitized.contains("mcp_servers"));
    }

    #[tokio::test]
    async fn wrap_codex_output_with_home_cleanup_removes_headless_home() {
        let temp_dir = unique_temp_dir("headless-cleanup");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let (output_tx, output_rx) = mpsc::channel(4);
        let mut wrapped = wrap_codex_output_with_home_cleanup(Some(temp_dir.clone()), output_rx);
        output_tx
            .send(ExecutorOutput::Completed { exit_code: 0 })
            .await
            .expect("send completion");
        drop(output_tx);

        assert!(matches!(
            wrapped.recv().await,
            Some(ExecutorOutput::Completed { exit_code: 0 })
        ));
        timeout(Duration::from_secs(2), async {
            while temp_dir.exists() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("cleanup should remove headless home");
    }

    #[test]
    fn seed_isolated_codex_home_copies_auth_and_strips_mcp_config() {
        let temp_dir = unique_temp_dir("isolated-home");
        let source_home = temp_dir.join("source-home");
        let target_home = temp_dir.join("target-home");
        let source_codex_dir = source_home.join(".codex");
        fs::create_dir_all(&source_codex_dir).expect("create source codex dir");
        fs::write(source_codex_dir.join("auth.json"), b"{\"token\":\"ok\"}\n").expect("write auth");
        fs::write(
            source_codex_dir.join("config.toml"),
            concat!(
                "model = \"gpt-5.4\"\n",
                "approval_policy = \"never\"\n\n",
                "[mcp_servers.memory]\n",
                "command = \"npx\"\n\n",
                "[profiles.default]\n",
                "model = \"gpt-5.4\"\n"
            ),
        )
        .expect("write source config");

        seed_isolated_codex_home(&source_home, &target_home).expect("seed isolated home");

        let target_codex_dir = target_home.join(".codex");
        assert!(target_codex_dir.join("auth.json").is_file());
        #[cfg(unix)]
        assert!(!fs::symlink_metadata(target_codex_dir.join("auth.json"))
            .expect("auth metadata")
            .file_type()
            .is_symlink());
        let config = fs::read_to_string(target_codex_dir.join("config.toml")).expect("read config");
        assert!(config.contains("approval_policy = \"never\""));
        assert!(config.contains("[profiles.default]"));
        assert!(!config.contains("mcp_servers"));

        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn new_resolves_native_binary_from_node_wrapper() {
        let Some(target_triple) = codex_target_triple() else {
            return;
        };
        let Some(platform_package) = codex_platform_package(target_triple) else {
            return;
        };

        let temp_dir = unique_temp_dir("native-resolve");
        let package_root = temp_dir.join("@openai").join("codex");
        let wrapper_path = package_root.join("bin").join("codex.js");
        let native_path = package_root
            .join("node_modules")
            .join(platform_package)
            .join("vendor")
            .join(target_triple)
            .join("codex")
            .join(if cfg!(windows) { "codex.exe" } else { "codex" });

        fs::create_dir_all(wrapper_path.parent().expect("wrapper parent"))
            .expect("create wrapper dir");
        fs::create_dir_all(native_path.parent().expect("native parent"))
            .expect("create native dir");
        fs::write(&wrapper_path, b"#!/usr/bin/env node\n").expect("write wrapper");
        fs::write(&native_path, b"#!/bin/sh\nexit 0\n").expect("write native binary");
        mark_executable(&wrapper_path);
        mark_executable(&native_path);

        let executor = CodexExecutor::new(wrapper_path.clone());
        let expected = fs::canonicalize(&native_path).expect("canonical native path");
        assert_eq!(executor.binary_path(), expected.as_path());

        fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn parse_started_mcp_tool_call_emits_structured_status() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = r#"{"type":"item.started","item":{"type":"mcp_tool_call","tool":"read_text_file","server":"filesystem","arguments":{"path":"/tmp/demo.txt"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Read Text File");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("read_text_file")
        );
    }

    #[test]
    fn parse_thread_started_emits_resume_target_metadata() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let output =
            executor.parse_output(r#"{"type":"thread.started","thread_id":"session-123"}"#);

        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert!(text.is_empty());
        assert_eq!(
            metadata.get("eventKind").and_then(Value::as_str),
            Some("thread_started")
        );
        assert_eq!(
            metadata.get("codexThreadId").and_then(Value::as_str),
            Some("session-123")
        );
    }

    #[test]
    fn build_args_includes_reasoning_effort_override() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"high\"".to_string()));
    }

    #[test]
    fn build_args_resumes_native_session_without_inline_prompt() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "continue".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("medium".to_string()),
            skip_permissions: true,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: Some("session-123".to_string()),
        });

        assert_eq!(args.first().map(String::as_str), Some("--no-alt-screen"));
        assert!(!args.contains(&"--skip-git-repo-check".to_string()));
        assert!(args.contains(&"resume".to_string()));
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(!args.contains(&"--yolo".to_string()));
        assert!(args.contains(&"session-123".to_string()));
        assert!(!args.contains(&"continue".to_string()));
    }

    #[test]
    fn build_args_structured_output_uses_exec_json_in_interactive_mode() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: true,
            resume_target: None,
        });

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        assert!(!args.contains(&"--output-format".to_string()));
        assert!(!args.contains(&"--no-alt-screen".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("hello"));
    }

    #[test]
    fn build_args_structured_resume_reads_follow_up_from_stdin() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: String::new(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("medium".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: true,
            resume_target: Some("session-123".to_string()),
        });

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.contains(&"resume".to_string()));
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"session-123".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(!args.contains(&"--output-format".to_string()));
    }

    #[test]
    fn parse_output_ignores_internal_codex_logs() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = "2026-03-09T01:31:02.130169Z WARN codex_core::mcp_connection_manager: Failed to list resources for MCP server 'filesystem': resources/list failed: Mcp error: -32601: Method not found";

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout suppression");
        };
        assert!(text.is_empty());
    }

    #[test]
    fn parse_output_ignores_sqlx_tracing_logs() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = "2026-03-09T01:40:13.738303Z WARN sqlx::query: slow statement: execution time exceeded alert threshold";

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout suppression");
        };
        assert!(text.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires local codex binary and model access"]
    async fn structured_spawn_emits_assistant_message() {
        let executor = CodexExecutor::new(PathBuf::from("codex"));
        let handle = executor
            .spawn(SpawnOptions {
                cwd: std::env::temp_dir(),
                prompt: "Reply with exactly: codex executor smoke ok".to_string(),
                model: None,
                reasoning_effort: None,
                skip_permissions: false,
                extra_args: Vec::new(),
                env: HashMap::new(),
                branch: None,
                timeout: Some(Duration::from_secs(60)),
                interactive: false,
                structured_output: true,
                resume_target: None,
            })
            .await
            .expect("codex structured spawn should start");

        let (_pid, _kind, mut output_rx, _input_tx, _terminal_rx, _resize_tx, _kill_tx) =
            handle.into_parts();

        let mut saw_assistant = false;
        let mut seen_events = Vec::new();
        let result = timeout(Duration::from_secs(60), async {
            while let Some(event) = output_rx.recv().await {
                seen_events.push(format!("{event:?}"));
                match event {
                    ExecutorOutput::Stdout(text) => {
                        if text.contains("codex executor smoke ok") {
                            saw_assistant = true;
                            break;
                        }
                    }
                    ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. } => break,
                    _ => {}
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timed out waiting for codex structured output"
        );
        assert!(
            saw_assistant,
            "expected assistant message from codex structured spawn, saw events: {:?}",
            seen_events
        );
    }

    #[tokio::test]
    #[ignore = "requires local conductor checkout, codex binary, and model access"]
    async fn structured_spawn_with_dispatcher_like_mcp_emits_assistant_message() {
        let executor = CodexExecutor::new(PathBuf::from("codex"));
        let conductor_root = required_smoke_path("CONDUCTOR_ROOT");
        let project_cwd = required_smoke_path("CODER_SMOKE_PROJECT_CWD");
        let mut env = HashMap::new();
        env.insert(
            "CONDUCTOR_SESSION_ID".to_string(),
            "dispatcher-smoke-session".to_string(),
        );
        env.insert(
            "CONDUCTOR_PROJECT_ID".to_string(),
            "agent-client-protocol-main".to_string(),
        );
        env.insert(
            "CONDUCTOR_SESSION_KIND".to_string(),
            "project_dispatcher".to_string(),
        );
        let extra_args = vec![
            "-c".to_string(),
            format!(
                "mcp_servers.conductor.command=\"{}\"",
                conductor_root.join("target/debug/conductor").display()
            ),
            "-c".to_string(),
            format!(
                "mcp_servers.conductor.args=[\"--workspace\",\"{}\",\"-c\",\"{}\",\"mcp-server\"]",
                conductor_root.display(),
                conductor_root.join("conductor.yaml").display()
            ),
            "-c".to_string(),
            format!("mcp_servers.conductor.cwd=\"{}\"", conductor_root.display()),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_SESSION_ID=\"dispatcher-smoke-session\""
                .to_string(),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_PROJECT_ID=\"agent-client-protocol-main\""
                .to_string(),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_SESSION_KIND=\"project_dispatcher\"".to_string(),
        ];
        let handle = executor
            .spawn(SpawnOptions {
                cwd: project_cwd,
                prompt: "Reply with exactly: dispatcher smoke ok".to_string(),
                model: None,
                reasoning_effort: None,
                skip_permissions: false,
                extra_args,
                env,
                branch: None,
                timeout: Some(Duration::from_secs(90)),
                interactive: false,
                structured_output: true,
                resume_target: None,
            })
            .await
            .expect("dispatcher-like codex structured spawn should start");

        let (_pid, _kind, mut output_rx, _input_tx, _terminal_rx, _resize_tx, _kill_tx) =
            handle.into_parts();

        let mut saw_assistant = false;
        let mut seen_events = Vec::new();
        let result = timeout(Duration::from_secs(90), async {
            while let Some(event) = output_rx.recv().await {
                seen_events.push(format!("{event:?}"));
                match event {
                    ExecutorOutput::Stdout(text) => {
                        if text.contains("dispatcher smoke ok") {
                            saw_assistant = true;
                            break;
                        }
                    }
                    ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. } => break,
                    _ => {}
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timed out waiting for dispatcher-like codex output"
        );
        assert!(
            saw_assistant,
            "expected assistant message from dispatcher-like spawn, saw events: {:?}",
            seen_events
        );
    }

    #[tokio::test]
    #[ignore = "requires local dispatcher state, codex binary, and model access"]
    async fn structured_spawn_with_full_dispatcher_prompt_emits_assistant_message() {
        let executor = CodexExecutor::new(PathBuf::from("codex"));
        let conductor_root = required_smoke_path("CONDUCTOR_ROOT");
        let project_cwd = required_smoke_path("CODER_SMOKE_PROJECT_CWD");
        let thread_path = required_smoke_path("CODER_SMOKE_DISPATCHER_THREAD_PATH");
        let thread: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&thread_path).expect("dispatcher thread fixture should exist"),
        )
        .expect("dispatcher thread fixture should parse");
        let base_prompt = thread
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .expect("dispatcher prompt should exist");
        let turn_prompt = concat!(
            "ACP execution mode: inspect context first, then create or update the necessary board tasks in this same turn when the request is actionable. Use tool calls to review the repo, board, relevant files, and diffs before writing task packets. Only pause for plan-only review when the user explicitly asks for it or the requested mutation would be ambiguous or unsafe.\n\n",
            "ACP dispatcher preference: prefer `codex` for newly created implementation tasks unless the user explicitly wants another agent.\n",
            "Default coding model: `gpt-5.4`. Persist it onto implementation tasks with `model:gpt-5.4` unless the user explicitly overrides it.\n",
            "Default coding reasoning: `high`. Persist it onto implementation tasks with `reasoningEffort:high` unless the user explicitly overrides it.\n\n",
            "Reply with exactly: dispatcher smoke ok"
        );
        let full_prompt = format!("{base_prompt}\n\n## User request\n{turn_prompt}\n");

        let mut env = HashMap::new();
        env.insert(
            "CONDUCTOR_SESSION_ID".to_string(),
            "dispatcher-smoke-session".to_string(),
        );
        env.insert(
            "CONDUCTOR_PROJECT_ID".to_string(),
            "agent-client-protocol-main".to_string(),
        );
        env.insert(
            "CONDUCTOR_SESSION_KIND".to_string(),
            "project_dispatcher".to_string(),
        );
        let extra_args = vec![
            "-c".to_string(),
            format!(
                "mcp_servers.conductor.command=\"{}\"",
                conductor_root.join("target/debug/conductor").display()
            ),
            "-c".to_string(),
            format!(
                "mcp_servers.conductor.args=[\"--workspace\",\"{}\",\"-c\",\"{}\",\"mcp-server\"]",
                conductor_root.display(),
                conductor_root.join("conductor.yaml").display()
            ),
            "-c".to_string(),
            format!("mcp_servers.conductor.cwd=\"{}\"", conductor_root.display()),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_SESSION_ID=\"dispatcher-smoke-session\""
                .to_string(),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_PROJECT_ID=\"agent-client-protocol-main\""
                .to_string(),
            "-c".to_string(),
            "mcp_servers.conductor.env.CONDUCTOR_SESSION_KIND=\"project_dispatcher\"".to_string(),
        ];

        let handle = executor
            .spawn(SpawnOptions {
                cwd: project_cwd,
                prompt: full_prompt,
                model: None,
                reasoning_effort: None,
                skip_permissions: false,
                extra_args,
                env,
                branch: None,
                timeout: Some(Duration::from_secs(120)),
                interactive: false,
                structured_output: true,
                resume_target: None,
            })
            .await
            .expect("full dispatcher-like codex spawn should start");

        let (_pid, _kind, mut output_rx, _input_tx, _terminal_rx, _resize_tx, _kill_tx) =
            handle.into_parts();

        let mut saw_assistant = false;
        let mut seen_events = Vec::new();
        let result = timeout(Duration::from_secs(120), async {
            while let Some(event) = output_rx.recv().await {
                seen_events.push(format!("{event:?}"));
                match event {
                    ExecutorOutput::Stdout(text) => {
                        if text.contains("dispatcher smoke ok") {
                            saw_assistant = true;
                            break;
                        }
                    }
                    ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. } => break,
                    _ => {}
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timed out waiting for full dispatcher-like codex output"
        );
        assert!(
            saw_assistant,
            "expected assistant message from full dispatcher-like spawn, saw events: {:?}",
            seen_events
        );
    }

    fn required_smoke_path(name: &str) -> PathBuf {
        std::env::var_os(name)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("set {name} before running this ignored smoke test"))
    }
}
