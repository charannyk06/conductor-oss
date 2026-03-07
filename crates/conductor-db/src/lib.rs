pub mod migrations;
pub mod repo;

use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

/// Database connection pool wrapper.
#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Connect to a SQLite database file. Creates it if it doesn't exist.
    pub async fn connect(path: &Path) -> Result<Self> {
        // Ensure parent directory exists.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let db_url = format!("sqlite:{}?mode=rwc", path.display());
        let options = SqliteConnectOptions::from_str(&db_url)?
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(30))
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        let db = Self { pool };
        db.run_migrations().await?;

        tracing::info!("Database connected: {}", path.display());
        Ok(db)
    }

    /// Connect to an in-memory database (for testing).
    pub async fn in_memory() -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;

        let db = Self { pool };
        db.run_migrations().await?;
        Ok(db)
    }

    /// Run all pending migrations.
    async fn run_migrations(&self) -> Result<()> {
        migrations::run(&self.pool).await
    }

    /// Get a reference to the connection pool.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}
