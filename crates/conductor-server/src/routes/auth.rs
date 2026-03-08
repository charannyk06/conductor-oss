use axum::extract::Json;
use axum::http::{header::SET_COOKIE, HeaderMap, HeaderValue, StatusCode};
use axum::routing::post;
use axum::Router;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use std::sync::Arc;

use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;
const BUILTIN_REMOTE_ACCESS_TOKEN_ENV: &str = "CONDUCTOR_REMOTE_ACCESS_TOKEN";
const BUILTIN_REMOTE_SESSION_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
const BUILTIN_REMOTE_SESSION_COOKIE: &str = "conductor_session";
const BUILTIN_REMOTE_SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 7;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/api/auth/session",
        post(create_session).delete(delete_session),
    )
}

#[derive(Debug, Deserialize)]
struct SessionRequestBody {
    token: Option<String>,
}

async fn create_session(
    headers: HeaderMap,
    Json(body): Json<SessionRequestBody>,
) -> (StatusCode, HeaderMap, axum::Json<serde_json::Value>) {
    if !is_builtin_remote_auth_enabled() {
        return (
            StatusCode::NOT_FOUND,
            HeaderMap::new(),
            axum::Json(json!({ "error": "Built-in remote auth is not enabled" })),
        );
    }

    let token = body.token.unwrap_or_default();
    if !is_valid_builtin_access_token(&token) {
        return (
            StatusCode::FORBIDDEN,
            HeaderMap::new(),
            axum::Json(json!({ "error": "Invalid access token" })),
        );
    }

    let cookie_value = match create_builtin_remote_session_value() {
        Ok(value) => value,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                HeaderMap::new(),
                axum::Json(json!({ "error": err.to_string() })),
            )
        }
    };

    let mut response_headers = HeaderMap::new();
    if let Ok(cookie_header) = HeaderValue::from_str(&build_cookie(
        &cookie_value,
        is_secure(&headers),
        BUILTIN_REMOTE_SESSION_TTL_SECONDS,
    )) {
        response_headers.insert(SET_COOKIE, cookie_header);
    }
    (
        StatusCode::OK,
        response_headers,
        axum::Json(json!({ "ok": true })),
    )
}

async fn delete_session(
    headers: HeaderMap,
) -> (StatusCode, HeaderMap, axum::Json<serde_json::Value>) {
    let mut response_headers = HeaderMap::new();
    if let Ok(cookie_header) = HeaderValue::from_str(&build_cookie("", is_secure(&headers), 0)) {
        response_headers.insert(SET_COOKIE, cookie_header);
    }
    (
        StatusCode::OK,
        response_headers,
        axum::Json(json!({ "ok": true })),
    )
}

fn access_token() -> Option<String> {
    std::env::var(BUILTIN_REMOTE_ACCESS_TOKEN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn session_secret() -> Option<String> {
    std::env::var(BUILTIN_REMOTE_SESSION_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_builtin_remote_auth_enabled() -> bool {
    access_token().is_some() && session_secret().is_some()
}

fn is_valid_builtin_access_token(candidate: &str) -> bool {
    match access_token() {
        Some(configured) if !candidate.trim().is_empty() => {
            constant_time_equal(configured.as_bytes(), candidate.trim().as_bytes())
        }
        _ => false,
    }
}

fn create_builtin_remote_session_value() -> anyhow::Result<String> {
    let secret = session_secret()
        .ok_or_else(|| anyhow::anyhow!("Built-in remote session secret is not configured"))?;
    let expires_at =
        chrono::Utc::now().timestamp_millis() + BUILTIN_REMOTE_SESSION_TTL_SECONDS * 1000;
    let payload = expires_at.to_string();
    let signature = sign_payload(&payload, &secret)?;
    Ok(format!("{payload}.{signature}"))
}

fn sign_payload(payload: &str, secret: &str) -> anyhow::Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut mismatch = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        mismatch |= a ^ b;
    }
    mismatch == 0
}

fn build_cookie(value: &str, secure: bool, max_age: i64) -> String {
    let same_site = if secure { "Strict" } else { "Lax" };
    let mut cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite={}; Max-Age={}",
        BUILTIN_REMOTE_SESSION_COOKIE, value, same_site, max_age
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Check if the request came via HTTPS by inspecting the X-Forwarded-Proto header.
/// IMPORTANT: This trusts the header without validation. The backend MUST be behind a
/// trusted reverse proxy that sets this header when remote auth is enabled.
fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}
