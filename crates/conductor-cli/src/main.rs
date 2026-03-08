use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

use conductor_core::config::ConductorConfig;
use conductor_core::event::EventBus;
use conductor_db::Database;

#[derive(Parser)]
#[command(name = "conductor", version, about = "AI agent orchestrator")]
struct Cli {
    /// Workspace directory.
    #[arg(long, default_value = ".")]
    workspace: PathBuf,

    /// Config file path.
    #[arg(long, short)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the Rust Conductor backend.
    Start {
        #[arg(long, short, default_value = "4747")]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },
    /// Initialize a new workspace.
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// List configured projects.
    Projects,
    /// Show backend status.
    Status {
        #[arg(long, short, default_value = "4747")]
        port: u16,
    },
    /// Spawn a task through the Rust backend.
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
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
        Commands::Init { path } => {
            let config_path = path.join("conductor.yaml");
            if config_path.exists() {
                tracing::warn!("conductor.yaml already exists");
                return Ok(());
            }
            let config = ConductorConfig::default_for_workspace(&path);
            config.save(&config_path)?;
            std::fs::create_dir_all(path.join(".conductor"))?;
            tracing::info!("Initialized workspace at {}", path.display());
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
                    project.path,
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
            let response = client
                .post(format!(
                    "http://127.0.0.1:{}/api/spawn",
                    port.unwrap_or(4747)
                ))
                .json(&serde_json::json!({
                    "projectId": project,
                    "prompt": prompt,
                    "agent": agent,
                    "model": model,
                }))
                .send()
                .await?;
            let payload: serde_json::Value = response.json().await?;
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
    }

    Ok(())
}
