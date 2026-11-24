//! HTTP API for the local credential vault. No route returns a password.

use axum::extract::Path;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};

use crate::routes::api_error::ApiError;
use crate::state::AppState;
use crate::vault::import::{parse_export, ImportSource};
use crate::vault::{CredentialSummary, KeyStorage, Vault, VaultError};

static VAULT: LazyLock<Vault> = LazyLock::new(Vault::default_location);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/vault/credentials",
            get(list_credentials).delete(clear_credentials),
        )
        .route("/api/vault/credentials/{id}", delete(delete_credential))
        .route("/api/vault/import", post(import_credentials))
}

fn vault_error(err: VaultError) -> ApiError {
    match err {
        VaultError::NotFound => ApiError::not_found(err.to_string()),
        other => ApiError::internal(other.to_string()),
    }
}

/// Run a vault operation off the async runtime; it does blocking file I/O.
async fn with_vault<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&Vault) -> Result<T, VaultError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || operation(&VAULT))
        .await
        .map_err(|err| ApiError::internal(format!("vault task failed: {err}")))?
        .map_err(vault_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialList {
    credentials: Vec<CredentialSummary>,
    /// Where the encryption key is kept; absent until something is saved.
    key_storage: Option<KeyStorage>,
}

async fn list_credentials() -> Result<Json<CredentialList>, ApiError> {
    let (credentials, key_storage) =
        with_vault(|vault| Ok((vault.list()?, vault.key_storage()?))).await?;
    Ok(Json(CredentialList {
        credentials,
        key_storage,
    }))
}

#[derive(Debug, Deserialize)]
struct ImportRequest {
    /// Which manager the file came from; inferred from the file when absent.
    source: Option<ImportSource>,
    /// The export file's text.
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResponse {
    source: ImportSource,
    imported: usize,
    updated: usize,
    unchanged: usize,
    skipped: usize,
}

async fn import_credentials(
    Json(request): Json<ImportRequest>,
) -> Result<Json<ImportResponse>, ApiError> {
    let (source, parsed) = parse_export(request.source, &request.content)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    let skipped = parsed.skipped;
    let report = with_vault(move |vault| vault.import(source, parsed.logins)).await?;
    Ok(Json(ImportResponse {
        source,
        imported: report.imported,
        updated: report.updated,
        unchanged: report.unchanged,
        skipped,
    }))
}

#[derive(Debug, Serialize)]
struct RemovedResponse {
    removed: usize,
}

async fn delete_credential(Path(id): Path<String>) -> Result<Json<RemovedResponse>, ApiError> {
    with_vault(move |vault| vault.delete(&id)).await?;
    Ok(Json(RemovedResponse { removed: 1 }))
}

async fn clear_credentials() -> Result<Json<RemovedResponse>, ApiError> {
    let removed = with_vault(|vault| vault.clear()).await?;
    Ok(Json(RemovedResponse { removed }))
}
