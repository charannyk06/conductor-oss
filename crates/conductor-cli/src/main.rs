mod bridge;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use conductor_core::scaffold::{
    build_conductor_board, build_conductor_yaml, resolve_scaffold_project, scaffold_workspace,
    ConductorYamlScaffoldConfig, ScaffoldPreferencesConfig, ScaffoldWorkspaceOptions,
};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

use conductor_core::config::ConductorConfig;
use conductor_core::event::EventBus;
use conductor_db::Database;

#[derive(Parser)]
#[command(name = "conductor", version, about = "AI agent orchestrator")]
struct Cli {
    #[arg(long, default_value = ".")]
    workspace: PathBuf,
    #[arg(long, short)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Start {
        #[arg(long, short, default_value = "4747")]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },
    Bridge {
        #[command(subcommand)]
        command: BridgeCommands,
    },
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long, short)]
        force: bool,
        #[arg(long)]
        project_id: Option<String>,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        reasoning_effort: Option<String>,
        #[arg(long)]
        ide: Option<String>,
        #[arg(long)]
        markdown_editor: Option<String>,
        #[arg(long)]
        default_branch: Option<String>,
        #[arg(long)]
        default_working_directory: Option<String>,
        #[arg(long)]
        dashboard_url: Option<String>,
        #[arg(long)]
        json: bool,
    },
    BootstrapHome {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    McpServer,
    AcpServer,
    Projects,
    Status {
        #[arg(long, short, default_value = "4747")]
        port: u16,
    },
    Spawn {
        #[arg(long, short)]
        project: String,
        prompt: String,
        #[arg(long, short)]
        agent: Option<String>,
        #[arg(long, short)]
        model: Option<String>,
        #[arg(long)]
        port: Option<u16>,
    },
}

#[derive(Subcommand)]
enum BridgeCommands {
    Connect {
        #[arg(long)]
        relay: String,
        #[arg(long)]
        token: Option<String>,
    },
    Status,
    Disconnect,
}

#[tokio::main]
async fn main() -> Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let use_json = std::env::var("CONDUCTOR_LOG_JSON")
        .map(|v| v == "true")
        .unwrap_or(false);
    if use_json {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let cli = Cli::parse();
    match cli.command {
        Commands::Bridge { command } => match command {
            BridgeCommands::Connect { relay, token } => {
                if let Some(ref token) = token {
                    bridge::save_token(token)?;
                }
                bridge::connect(relay, token).await?;
            }
            BridgeCommands::Status => {
                println!("{}", bridge::status()?);
            }
            BridgeCommands::Disconnect => {
                bridge::disconnect()?;
            }
        },
        Commands::Start { port, host } => {
            let config_path = cli
                .config
                .unwrap_or_else(|| cli.workspace.join("conductor.yaml"));
            let mut config = if config_path.exists() {
                ConductorConfig::load(&config_path)?
            } else {
                tracing::warn!(
                    "No config found at {}. Creating defaults.",
                    config_path.display()
                );
                ConductorConfig::default_for_workspace(&cli.workspace)
            };
            config.workspace = cli.workspace.clone();
            config.config_path = Some(config_path.clone());
            config.server.host = host;
            config.server.port = port;
            config.port = port;
            if !config_path.exists() {
                config.save(&config_path)?;
            }
            let db_path = cli.workspace.join(".conductor").join("conductor.db");
            let db = Database::connect(&db_path)
                .await
                .context("Failed to connect to database")?;
            let event_bus = EventBus::new(1024);
            tracing::info!(
                "Starting Conductor Rust backend v{}",
                env!("CARGO_PKG_VERSION")
            );
            conductor_server::serve(&config, db, event_bus).await?;
        }
        Commands::Init {
            path,
            force,
            project_id,
            display_name,
            repo,
            agent,
            model,
            reasoning_effort,
            ide,
            markdown_editor,
            default_branch,
            default_working_directory,
            dashboard_url,
            json,
        } => {
            let cwd = std::env::current_dir().context("Failed to resolve current directory")?;
            let options = ScaffoldWorkspaceOptions {
                force,
                project_id,
                display_name,
                repo,
                path: Some(path.clone()),
                agent,
                model,
                reasoning_effort,
                ide,
                markdown_editor,
                default_branch,
                default_working_directory,
                dashboard_url,
            };
            let resolved = resolve_scaffold_project(&cwd, &options)?;
            let board_exists = resolved.path.join("CONDUCTOR.md").exists();
            let config_exists = resolved.path.join("conductor.yaml").exists();
            let result = scaffold_workspace(&cwd, &options)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(
                        &serde_json::json!({"created": result.created, "boardPath": result.board_path, "configPath": result.config_path, "project": {"projectId": &result.project.project_id, "displayName": &result.project.display_name, "repo": &result.project.repo, "path": &result.project.path, "agent": &result.project.agent, "agentModel": &result.project.agent_model, "agentReasoningEffort": &result.project.agent_reasoning_effort, "ide": &result.project.ide, "markdownEditor": &result.project.markdown_editor, "defaultBranch": &result.project.default_branch, "defaultWorkingDirectory": &result.project.default_working_directory, "dashboardUrl": &result.project.dashboard_url}})
                    )?
                );
            } else {
                if !board_exists || options.force {
                    println!("✔  Created CONDUCTOR.md");
                } else {
                    println!("  CONDUCTOR.md already exists (use --force to overwrite)");
                }
                if !config_exists || options.force {
                    println!("✔  Created conductor.yaml");
                } else {
                    println!("  conductor.yaml already exists (use --force to overwrite)");
                }
                if result.created > 0 {
                    println!("\nDetected project defaults:\n  project id: {}\n  repo: {}\n  path: {}\n  default branch: {}\n  agent: {}\n\nNext steps:\n  1. co start\n  2. Open dashboard\n  3. Open CONDUCTOR.md\n\n  Tip: Running `npx conductor-oss@latest init` from a repo root now auto-detects origin + branch.\n", result.project.project_id, result.project.repo, result.project.path.display(), result.project.default_branch, result.project.agent);
                }
            }
        }
        Commands::BootstrapHome { path } => {
            let workspace = if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .context("Failed to resolve current directory")?
                    .join(path)
            };
            fs::create_dir_all(&workspace)
                .with_context(|| format!("failed to create {}", workspace.display()))?;
            let board_path = workspace.join("CONDUCTOR.md");
            if !board_path.exists() {
                fs::write(&board_path, build_conductor_board("home", "Conductor Home"))
                    .with_context(|| format!("failed to write {}", board_path.display()))?;
            }
            let config_path = workspace.join("conductor.yaml");
            if !config_path.exists() {
                let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig {
                    preferences: Some(ScaffoldPreferencesConfig {
                        onboarding_acknowledged: Some(false),
                        coding_agent: Some("claude-code".to_string()),
                        ide: Some("vscode".to_string()),
                        markdown_editor: Some("obsidian".to_string()),
                        ..ScaffoldPreferencesConfig::default()
                    }),
                    ..ConductorYamlScaffoldConfig::default()
                })?;
                fs::write(&config_path, yaml)
                    .with_context(|| format!("failed to write {}", config_path.display()))?;
            }
        }
        Commands::McpServer => {
            let config_path = cli
                .config
                .unwrap_or_else(|| cli.workspace.join("conductor.yaml"));
            let mut config = if config_path.exists() {
                ConductorConfig::load(&config_path)?
            } else {
                ConductorConfig::default_for_workspace(&cli.workspace)
            };
            config.workspace = cli.workspace.clone();
            config.config_path = Some(config_path.clone());
            let db_path = cli.workspace.join(".conductor").join("conductor.db");
            let db = Database::connect(&db_path)
                .await
                .context("Failed to connect to database")?;
            let state = conductor_server::state::AppState::new(config_path, config, db).await;
            state.discover_executors().await;
            let backend = Arc::new(conductor_server::mcp::AppStateMcpBackend::new(state));
            conductor_server::mcp::serve_stdio(backend).await?;
        }
        Commands::AcpServer => {
            let config_path = cli
                .config
                .unwrap_or_else(|| cli.workspace.join("conductor.yaml"));
            let mut config = if config_path.exists() {
                ConductorConfig::load(&config_path)?
            } else {
                ConductorConfig::default_for_workspace(&cli.workspace)
            };
            config.workspace = cli.workspace.clone();
            config.config_path = Some(config_path.clone());
            let db_path = cli.workspace.join(".conductor").join("conductor.db");
            let db = Database::connect(&db_path)
                .await
                .context("Failed to connect to database")?;
            let state = conductor_server::state::AppState::new(config_path, config, db).await;
            state.discover_executors().await;
            state.start_acp_dispatcher_watchdog();
            state.publish_snapshot().await;
            conductor_server::acp::serve_stdio(state).await?;
        }
        Commands::Projects => {
            let config_path = cli
                .config
                .unwrap_or_else(|| cli.workspace.join("conductor.yaml"));
            let config = ConductorConfig::load(&config_path)?;
            for (id, project) in config.projects.iter() {
                println!(
                    "  {} ({}) - {}",
                    project.name.clone().unwrap_or_else(|| id.clone()),
                    id,
                    project.path
                );
            }
            println!("\n{} project(s)", config.projects.len());
        }
        Commands::Status { port } => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()?;
            let response = client
                .get(format!("http://127.0.0.1:{port}/api/health"))
                .send()
                .await?;
            if response.status().is_success() {
                let payload: serde_json::Value = response.json().await?;
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                eprintln!("Backend returned {}", response.status());
            }
        }
        Commands::Spawn {
            project,
            prompt,
            agent,
            model,
            port,
        } => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()?;
            let response = client.post(format!("http://127.0.0.1:{}/api/spawn", port.unwrap_or(4747))).json(&serde_json::json!({"projectId": project, "prompt": prompt, "agent": agent, "model": model})).send().await?;
            let payload: serde_json::Value = response.json().await?;
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
    }
    Ok(())
}
