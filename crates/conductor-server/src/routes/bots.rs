//! HTTP API for teammate bots, the human inbox, push subscriptions, and Slack events.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::bot_delivery::{
    handle_slack_request, parse_slack_event, verify_slack_signature, SLACK_SIGNING_SECRET_ENV,
};
use crate::state::bots::{bot_send_error_to_anyhow, BotInput, BotScheduleInput};
use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/bots", get(list_bots).post(create_bot))
        .route(
            "/api/bots/{bot_id}",
            get(get_bot).patch(update_bot).delete(delete_bot),
        )
        .route("/api/bots/{bot_id}/thread", post(ensure_bot_thread))
        .route("/api/bots/{bot_id}/thread/reset", post(reset_bot_thread))
        .route("/api/bots/{bot_id}/message", post(send_bot_message))
        .route("/api/bots/{bot_id}/schedules", post(create_schedule))
        .route(
            "/api/bots/{bot_id}/schedules/{schedule_id}",
            patch(update_schedule).delete(delete_schedule),
        )
        .route(
            "/api/bots/{bot_id}/schedules/{schedule_id}/run",
            post(run_schedule),
        )
        .route("/api/inbox", get(get_inbox))
        .route("/api/push/public-key", get(push_public_key))
        .route(
            "/api/push/subscriptions",
            post(add_push_subscription).delete(remove_push_subscription),
        )
        .route("/api/push/test", post(send_test_push))
        .route("/api/slack/events", post(receive_slack_event))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

fn failure(err: anyhow::Error) -> ApiResponse {
    let message = err.to_string();
    let status = if message.contains("not found") {
        StatusCode::NOT_FOUND
    } else if message.contains("busy") {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    };
    error(status, message)
}

async fn bot_payload(state: &Arc<AppState>, bot: &crate::state::bots::BotRecord) -> Value {
    json!({ "bot": state.serialize_bot(bot).await })
}

async fn list_bots(State(state): State<Arc<AppState>>) -> ApiResponse {
    let mut bots = Vec::new();
    for bot in state.list_bots().await {
        bots.push(state.serialize_bot(&bot).await);
    }
    ok(json!({ "bots": bots }))
}

async fn create_bot(State(state): State<Arc<AppState>>, Json(body): Json<BotInput>) -> ApiResponse {
    match state.create_bot(body).await {
        Ok(bot) => (StatusCode::CREATED, Json(bot_payload(&state, &bot).await)),
        Err(err) => failure(err),
    }
}

async fn get_bot(State(state): State<Arc<AppState>>, Path(bot_id): Path<String>) -> ApiResponse {
    match state.get_bot(&bot_id).await {
        Some(bot) => ok(bot_payload(&state, &bot).await),
        None => error(StatusCode::NOT_FOUND, format!("Bot {bot_id} not found")),
    }
}

async fn update_bot(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
    Json(body): Json<BotInput>,
) -> ApiResponse {
    match state.update_bot(&bot_id, body).await {
        Ok(bot) => ok(bot_payload(&state, &bot).await),
        Err(err) => failure(err),
    }
}

async fn delete_bot(State(state): State<Arc<AppState>>, Path(bot_id): Path<String>) -> ApiResponse {
    match state.delete_bot(&bot_id).await {
        Ok(()) => ok(json!({ "ok": true })),
        Err(err) => failure(err),
    }
}

async fn thread_response(state: Arc<AppState>, bot_id: String, force_new: bool) -> ApiResponse {
    match state.ensure_bot_thread(&bot_id, force_new).await {
        Ok((bot, thread)) => ok(json!({
            "bot": state.serialize_bot(&bot).await,
            "thread": state.serialize_dashboard_session(&thread).await,
        })),
        Err(err) => failure(err),
    }
}

async fn ensure_bot_thread(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
) -> ApiResponse {
    thread_response(state, bot_id, false).await
}

async fn reset_bot_thread(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
) -> ApiResponse {
    thread_response(state, bot_id, true).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageBody {
    message: String,
    #[serde(default)]
    attachments: Vec<String>,
}

async fn send_bot_message(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
    Json(body): Json<MessageBody>,
) -> ApiResponse {
    if body.message.trim().is_empty() && body.attachments.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "Message or attachments are required",
        );
    }
    match state
        .send_bot_message(
            &bot_id,
            body.message,
            body.attachments,
            "dispatcher_ui",
            None,
            true,
        )
        .await
    {
        Ok(thread_id) => ok(json!({ "ok": true, "threadId": thread_id })),
        Err(err) => failure(bot_send_error_to_anyhow(err)),
    }
}

async fn create_schedule(
    State(state): State<Arc<AppState>>,
    Path(bot_id): Path<String>,
    Json(body): Json<BotScheduleInput>,
) -> ApiResponse {
    match state.create_bot_schedule(&bot_id, body).await {
        Ok(bot) => (StatusCode::CREATED, Json(bot_payload(&state, &bot).await)),
        Err(err) => failure(err),
    }
}

async fn update_schedule(
    State(state): State<Arc<AppState>>,
    Path((bot_id, schedule_id)): Path<(String, String)>,
    Json(body): Json<BotScheduleInput>,
) -> ApiResponse {
    match state.update_bot_schedule(&bot_id, &schedule_id, body).await {
        Ok(bot) => ok(bot_payload(&state, &bot).await),
        Err(err) => failure(err),
    }
}

async fn delete_schedule(
    State(state): State<Arc<AppState>>,
    Path((bot_id, schedule_id)): Path<(String, String)>,
) -> ApiResponse {
    match state.delete_bot_schedule(&bot_id, &schedule_id).await {
        Ok(bot) => ok(bot_payload(&state, &bot).await),
        Err(err) => failure(err),
    }
}

async fn run_schedule(
    State(state): State<Arc<AppState>>,
    Path((bot_id, schedule_id)): Path<(String, String)>,
) -> ApiResponse {
    match state.run_bot_schedule(&bot_id, &schedule_id, true).await {
        Ok(bot) => ok(bot_payload(&state, &bot).await),
        Err(err) => failure(err),
    }
}

async fn get_inbox(State(state): State<Arc<AppState>>) -> ApiResponse {
    let items = state.bot_inbox().await;
    ok(json!({ "count": items.len(), "items": items }))
}

async fn push_public_key(State(state): State<Arc<AppState>>) -> ApiResponse {
    match state.push_public_key().await {
        Ok(public_key) => ok(json!({ "publicKey": public_key, "enabled": true })),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PushKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
struct PushSubscriptionBody {
    endpoint: String,
    keys: Option<PushKeys>,
}

async fn add_push_subscription(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PushSubscriptionBody>,
) -> ApiResponse {
    let Some(keys) = body.keys else {
        return error(StatusCode::BAD_REQUEST, "Subscription keys are required");
    };
    match state
        .add_push_subscription(&body.endpoint, &keys.p256dh, &keys.auth)
        .await
    {
        Ok(()) => ok(json!({ "ok": true })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn remove_push_subscription(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PushSubscriptionBody>,
) -> ApiResponse {
    match state.remove_push_subscription(&body.endpoint).await {
        Ok(()) => ok(json!({ "ok": true })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn send_test_push(State(state): State<Arc<AppState>>) -> ApiResponse {
    let sent = state
        .send_push_notification(
            "Conductor notifications are on",
            "You'll hear from your bots when they need a decision.",
            "/bots?view=inbox",
            "conductor-test",
        )
        .await;
    ok(json!({ "ok": sent > 0, "sent": sent }))
}

/// Slack Events API endpoint. Public by necessity, so every request must carry a valid
/// signature made with `CONDUCTOR_SLACK_SIGNING_SECRET`.
async fn receive_slack_event(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResponse {
    let Some(secret) = std::env::var(SLACK_SIGNING_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return error(
            StatusCode::FORBIDDEN,
            format!("Slack is not configured. Set {SLACK_SIGNING_SECRET_ENV} on the server."),
        );
    };
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    if !verify_slack_signature(
        &body,
        header("x-slack-request-timestamp"),
        header("x-slack-signature"),
        &secret,
        chrono::Utc::now().timestamp(),
    ) {
        return error(StatusCode::UNAUTHORIZED, "Invalid Slack signature");
    }
    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(payload) => payload,
        Err(err) => {
            return error(
                StatusCode::BAD_REQUEST,
                format!("Invalid JSON payload: {err}"),
            )
        }
    };
    if payload.get("type").and_then(Value::as_str) == Some("url_verification") {
        return ok(json!({
            "challenge": payload.get("challenge").cloned().unwrap_or(Value::Null),
        }));
    }
    // Slack retries unless it gets a fast 2xx, so the turn starts in the background.
    if let Some(request) = parse_slack_event(&payload) {
        tokio::spawn(handle_slack_request(state, request));
    }
    ok(json!({ "ok": true }))
}
