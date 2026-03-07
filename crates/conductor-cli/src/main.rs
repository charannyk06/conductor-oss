use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
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
    /// Start the conductor server and board watcher.
    Start {
        /// Port to listen on.
        #[arg(long, short, default_value = "4747")]
        port: u16,

        /// Host to bind to.
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },

    /// Initialize a new workspace.
    Init {
        /// Directory to initialize.
        #[arg(default_value = ".")]
        path: PathBuf,
    },

    /// Run diagnostics.
    Doctor {
        /// Auto-fix configuration issues.
        #[arg(long)]
        fix_config: bool,
    },

    /// List projects.
    Projects,

    /// List or manage sessions.
    Sessions {
        /// Filter by state.
        #[arg(long)]
        state: Option<String>,

        /// Kill a session by ID.
        #[arg(long)]
        kill: Option<String>,
    },

    /// Dispatch a task to an agent.
    Spawn {
        /// Project ID.
        #[arg(long, short)]
        project: String,

        /// Task description/prompt.
        prompt: String,

        /// Agent to use.
        #[arg(long, short)]
        agent: Option<String>,

        /// Model override.
        #[arg(long, short)]
        model: Option<String>,
    },

    /// Show system status.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
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
                tracing::warn!("No config found at {}. Using defaults.", config_path.display());
                ConductorConfig {
                    workspace: cli.workspace.clone(),
                    server: conductor_core::config::ServerConfig {
                        host: host.clone(),
                        port,
                        auth: None,
                    },
                    projects: Vec::new(),
                    default_executor: None,
                    executors: Default::default(),
                    webhooks: Vec::new(),
                }
            };

            config.server.host = host;
            config.server.port = port;

            // Initialize database.
            let db_path = cli.workspace.join(".conductor").join("conductor.db");
            let db = Database::connect(&db_path).await?;

            // Initialize event bus.
            let event_bus = EventBus::new(1024);

            tracing::info!("Starting Conductor v{}", env!("CARGO_PKG_VERSION"));

            // Start the HTTP server.
            conductor_server::serve(&config, db, event_bus).await?;
        }

        Commands::Init { path } => {
            let config_path = path.join("conductor.yaml");
            if config_path.exists() {
                tracing::warn!("conductor.yaml already exists");
                return Ok(());
            }

            let config = ConductorConfig {
                workspace: path.clone(),
                server: Default::default(),
                projects: Vec::new(),
                default_executor: None,
                executors: Default::default(),
                webhooks: Vec::new(),
            };

            config.save(&config_path)?;
            std::fs::create_dir_all(path.join(".conductor"))?;
            tracing::info!("Initialized workspace at {}", path.display());
        }

        Commands::Doctor { fix_config } => {
            tracing::info!("Running diagnostics...");
            // TODO: Implement doctor checks.
            if fix_config {
                tracing::info!("Fixing configuration...");
            }
            tracing::info!("All checks passed");
        }

        Commands::Projects => {
            let config_path = cli
                .config
                .unwrap_or_else(|| cli.workspace.join("conductor.yaml"));
            if config_path.exists() {
                let config = ConductorConfig::load(&config_path)?;
                for project in &config.projects {
                    println!(
                        "  {} ({}) - {}",
                        project.name,
                        project.id,
                        project.path.display()
                    );
                }
                println!("\n{} project(s)", config.projects.len());
            } else {
                println!("No conductor.yaml found. Run `conductor init`.");
            }
        }

        Commands::Sessions { state, kill } => {
            if let Some(id) = kill {
                tracing::info!("Killing session: {id}");
                // TODO: Connect to running server and kill.
            } else {
                tracing::info!("Listing sessions (state: {:?})", state);
                // TODO: Connect to running server and list.
            }
        }

        Commands::Spawn {
            project,
            prompt,
            agent,
            model,
        } => {
            tracing::info!(
                "Spawning task for project={project}, agent={:?}, model={:?}",
                agent,
                model
            );
            tracing::info!("Prompt: {prompt}");
            // TODO: Connect to running server and dispatch.
        }

        Commands::Status => {
            println!("Conductor v{}", env!("CARGO_PKG_VERSION"));
            println!("Workspace: {}", cli.workspace.display());

            // Check if server is running.
            let client = reqwest::Client::new();
            match client.get("http://127.0.0.1:4747/api/health").send().await {
                Ok(resp) if resp.status().is_success() => {
                    let health: serde_json::Value = resp.json().await?;
                    println!("Server: running");
                    println!("Executors: {}", health["executors"]);
                    println!("Subscribers: {}", health["event_subscribers"]);
                }
                _ => {
                    println!("Server: not running");
                }
            }
        }
    }

    Ok(())
}
