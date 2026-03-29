use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

use crate::dispatcher_task_lifecycle::{
    create_dispatcher_task, handoff_dispatcher_task, update_dispatcher_task,
    DispatcherTaskCreateInput, DispatcherTaskMutationContext, DispatcherTaskUpdateInput,
};
use crate::state::{
    build_normalized_chat_feed, is_project_dispatcher_session, AppState,
    CreateDispatcherThreadOptions, DispatcherBindingLookup, OpenClawDispatcherConfigPatch,
    SessionRecord, UpsertDispatcherBindingInput,
};

type ApiResponse = (StatusCode, Json<Value>);

const DEFAULT_FEED_WINDOW_LIMIT: usize = 120;
const MAX_FEED_WINDOW_LIMIT: usize = 240;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/projects/{project_id}/dispatchers",
            get(list_dispatchers),
        )
        .route(
            "/api/projects/{project_id}/dispatcher",
            get(get_dispatcher)
                .post(create_dispatcher)
                .delete(delete_dispatcher),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/bindings",
            get(get_dispatcher_bindings).post(upsert_dispatcher_binding),
        )
        .route("/api/projects/{project_id}/dispatcher/feed", get(get_feed))
        .route(
            "/api/projects/{project_id}/dispatcher/feed/stream",
            get(feed_stream),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/preferences",
            patch(update_dispatcher_preferences),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/integration",
            patch(update_dispatcher_integration),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/tasks",
            post(create_dispatcher_task_route),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/tasks/{task_lookup}",
            patch(update_dispatcher_task_route),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/tasks/{task_lookup}/handoff",
            post(handoff_dispatcher_task_route),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/send",
            post(send_to_dispatcher),
        )
        .route(
            "/api/projects/{project_id}/dispatcher/interrupt",
            post(interrupt_dispatcher),
        )
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn created(value: Value) -> ApiResponse {
    (StatusCode::CREATED, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatcherQuery {
    bridge_id: Option<String>,
    thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeedQuery {
    limit: Option<usize>,
    #[serde(rename = "bridgeId")]
    bridge_id: Option<String>,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDispatcherBody {
    bridge_id: Option<String>,
    force_new: bool,
    agent: Option<String>,
    dispatcher_agent: Option<String>,
    implementation_agent: Option<String>,
    openclaw_gateway_url: Option<String>,
    openclaw_gateway_token: Option<String>,
    openclaw_gateway_scopes: Option<String>,
    openclaw_session_key: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    implementation_model: Option<String>,
    implementation_reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDispatcherPreferencesBody {
    implementation_agent: Option<String>,
    implementation_model: Option<String>,
    implementation_reasoning_effort: Option<String>,
    /// OpenClaw gateway WebSocket URL (for agent=openclaw)
    openclaw_gateway_url: Option<String>,
    /// Optional gateway bearer token. Empty string clears the stored token.
    openclaw_gateway_token: Option<String>,
    /// Optional gateway scopes passed through to the OpenClaw runtime.
    openclaw_gateway_scopes: Option<String>,
    /// Optional explicit session key override for the OpenClaw runtime.
    openclaw_session_key: Option<String>,
}

/// PATCH body for OpenClaw (or any orchestrator) binding to this dispatcher thread.
/// Omit a key to leave it unchanged; JSON `null` clears; string sets.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDispatcherIntegrationBody {
    #[serde(default)]
    openclaw_thread_id: Option<Value>,
    #[serde(default)]
    openclaw_session_id: Option<Value>,
}

fn integration_value_to_binding(value: Option<Value>) -> Result<Option<Option<String>>, String> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s))),
        Some(_) => Err("expected string or null".to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendBody {
    message: String,
    attachments: Option<Vec<String>>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatcherBindingQuery {
    binding_id: Option<String>,
    provider: Option<String>,
    thread_id: Option<String>,
    session_id: Option<String>,
    channel_id: Option<String>,
    bridge_id: Option<String>,
    dispatcher_thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertDispatcherBindingBody {
    binding_id: Option<String>,
    provider: String,
    thread_id: Option<String>,
    session_id: Option<String>,
    channel_id: Option<String>,
    bridge_id: Option<String>,
    dispatcher_thread_id: Option<String>,
    #[serde(default)]
    create_dispatcher: bool,
    #[serde(default)]
    force_new_dispatcher: bool,
    dispatcher_agent: Option<String>,
    implementation_agent: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    implementation_model: Option<String>,
    implementation_reasoning_effort: Option<String>,
    title: Option<String>,
    metadata: Option<std::collections::HashMap<String, Value>>,
}

fn resolve_feed_window_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_FEED_WINDOW_LIMIT)
        .clamp(1, MAX_FEED_WINDOW_LIMIT)
}

fn trimmed_query_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn binding_query_lookup(query: &DispatcherBindingQuery) -> DispatcherBindingLookup {
    DispatcherBindingLookup {
        binding_id: query.binding_id.clone(),
        provider: query.provider.clone(),
        thread_id: query.thread_id.clone(),
        session_id: query.session_id.clone(),
        channel_id: query.channel_id.clone(),
        bridge_id: query.bridge_id.clone(),
        dispatcher_thread_id: query.dispatcher_thread_id.clone(),
    }
}

async fn serialize_dispatcher_binding(
    state: &Arc<AppState>,
    project_id: &str,
    binding: crate::state::DispatcherBindingRecord,
) -> Value {
    let dispatcher_thread = match binding.dispatcher_thread_id.as_deref() {
        Some(thread_id) => match state.get_dispatcher_thread(thread_id).await {
            Some(thread) => serialize_dispatcher(state, &thread).await,
            None => Value::Null,
        },
        None => Value::Null,
    };
    let dispatcher_query = binding
        .dispatcher_thread_id
        .as_deref()
        .map(|thread_id| format!("threadId={thread_id}"));
    let base_path = format!("/api/projects/{project_id}/dispatcher");
    let tasks_endpoint = dispatcher_query
        .as_ref()
        .map(|query| format!("{base_path}/tasks?{query}"))
        .unwrap_or_else(|| format!("{base_path}/tasks"));

    json!({
        "id": binding.id,
        "projectId": binding.project_id,
        "provider": binding.provider,
        "threadId": binding.thread_id,
        "sessionId": binding.session_id,
        "channelId": binding.channel_id,
        "bridgeId": binding.bridge_id,
        "dispatcherThreadId": binding.dispatcher_thread_id,
        "title": binding.title,
        "metadata": binding.metadata,
        "createdAt": binding.created_at,
        "updatedAt": binding.updated_at,
        "dispatcherThread": dispatcher_thread,
        "dispatcherEndpoints": {
            "dispatcher": dispatcher_query.as_ref().map(|query| format!("{base_path}?{query}")),
            "feed": dispatcher_query.as_ref().map(|query| format!("{base_path}/feed?{query}")),
            "stream": dispatcher_query.as_ref().map(|query| format!("{base_path}/feed/stream?{query}")),
            "send": dispatcher_query.as_ref().map(|query| format!("{base_path}/send?{query}")),
            "interrupt": dispatcher_query.as_ref().map(|query| format!("{base_path}/interrupt?{query}")),
            "tasks": tasks_endpoint,
        },
    })
}

fn dispatcher_matches_scope(
    dispatcher: &SessionRecord,
    project_id: &str,
    bridge_id: Option<&str>,
) -> bool {
    if dispatcher.project_id != project_id || !is_project_dispatcher_session(dispatcher) {
        return false;
    }

    match bridge_id {
        Some(expected) => dispatcher.bridge_id.as_deref() == Some(expected),
        None => dispatcher.bridge_id.is_none(),
    }
}

async fn resolve_project_dispatcher(
    state: &Arc<AppState>,
    project_id: &str,
    bridge_id: Option<&str>,
    thread_id: Option<&str>,
) -> Option<SessionRecord> {
    if let Some(thread_id) = trimmed_query_value(thread_id) {
        return state
            .get_dispatcher_thread(thread_id)
            .await
            .filter(|dispatcher| dispatcher_matches_scope(dispatcher, project_id, bridge_id));
    }

    state
        .latest_project_dispatcher_thread(project_id, bridge_id, None)
        .await
}

async fn list_dispatchers(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let threads = state
        .project_dispatcher_threads(&project_id, bridge_id)
        .await;
    let active_thread_id = state
        .latest_project_dispatcher_thread(&project_id, bridge_id, None)
        .await
        .map(|dispatcher| dispatcher.id);
    let mut payload = Vec::with_capacity(threads.len());
    for thread in threads {
        payload.push(serialize_dispatcher(&state, &thread).await);
    }

    ok(json!({
        "threads": payload,
        "activeThreadId": active_thread_id,
    }))
}

async fn serialize_dispatcher(state: &Arc<AppState>, dispatcher: &SessionRecord) -> Value {
    state.serialize_dashboard_session(dispatcher).await
}

async fn get_dispatcher(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    match resolve_project_dispatcher(&state, &project_id, bridge_id, query.thread_id.as_deref())
        .await
    {
        Some(dispatcher) => ok(json!({
            "thread": serialize_dispatcher(&state, &dispatcher).await,
        })),
        None => ok(json!({ "thread": Value::Null })),
    }
}

async fn create_dispatcher(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
    Json(body): Json<CreateDispatcherBody>,
) -> ApiResponse {
    match state
        .create_project_dispatcher_thread(
            &project_id,
            CreateDispatcherThreadOptions {
                bridge_id: body.bridge_id.or(query.bridge_id),
                dispatcher_agent: body.dispatcher_agent.or(body.agent),
                implementation_agent: body.implementation_agent,
                openclaw_config: OpenClawDispatcherConfigPatch {
                    gateway_url: body.openclaw_gateway_url,
                    gateway_token: body.openclaw_gateway_token,
                    gateway_scopes: body.openclaw_gateway_scopes,
                    session_key: body.openclaw_session_key,
                },
                dispatcher_model: body.model,
                dispatcher_reasoning_effort: body.reasoning_effort,
                implementation_model: body.implementation_model,
                implementation_reasoning_effort: body.implementation_reasoning_effort,
                force_new: body.force_new,
            },
        )
        .await
    {
        Ok(dispatcher) => created(json!({
            "thread": serialize_dispatcher(&state, &dispatcher).await,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn delete_dispatcher(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let dispatcher = match resolve_project_dispatcher(
        &state,
        &project_id,
        bridge_id,
        query.thread_id.as_deref(),
    )
    .await
    {
        Some(dispatcher) => dispatcher,
        None => {
            return error(
                StatusCode::NOT_FOUND,
                format!("Dispatcher thread for project {project_id} not found"),
            );
        }
    };

    match state.delete_dispatcher_thread(&dispatcher.id).await {
        Ok(()) => ok(json!({ "deletedThreadId": dispatcher.id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

fn lookup_has_binding_target(lookup: &DispatcherBindingLookup) -> bool {
    lookup.binding_id.is_some()
        || lookup.thread_id.is_some()
        || lookup.session_id.is_some()
        || lookup.channel_id.is_some()
        || lookup.dispatcher_thread_id.is_some()
}

async fn get_dispatcher_bindings(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherBindingQuery>,
) -> ApiResponse {
    let lookup = binding_query_lookup(&query);
    if lookup_has_binding_target(&lookup) {
        match state.get_dispatcher_binding(&project_id, &lookup).await {
            Some(binding) => ok(json!({
                "binding": serialize_dispatcher_binding(&state, &project_id, binding).await,
            })),
            None => ok(json!({ "binding": Value::Null })),
        }
    } else {
        let bindings = state
            .list_dispatcher_bindings(&project_id, Some(&lookup))
            .await;
        let mut payload = Vec::with_capacity(bindings.len());
        for binding in bindings {
            payload.push(serialize_dispatcher_binding(&state, &project_id, binding).await);
        }
        ok(json!({ "bindings": payload }))
    }
}

async fn upsert_dispatcher_binding(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherBindingQuery>,
    Json(body): Json<UpsertDispatcherBindingBody>,
) -> ApiResponse {
    let input = UpsertDispatcherBindingInput {
        binding_id: body.binding_id.or(query.binding_id),
        provider: body.provider,
        thread_id: body.thread_id.or(query.thread_id),
        session_id: body.session_id.or(query.session_id),
        channel_id: body.channel_id.or(query.channel_id),
        bridge_id: body.bridge_id.or(query.bridge_id),
        dispatcher_thread_id: body.dispatcher_thread_id.or(query.dispatcher_thread_id),
        create_dispatcher: body.create_dispatcher,
        force_new_dispatcher: body.force_new_dispatcher,
        dispatcher_agent: body.dispatcher_agent,
        implementation_agent: body.implementation_agent,
        dispatcher_model: body.model,
        dispatcher_reasoning_effort: body.reasoning_effort,
        implementation_model: body.implementation_model,
        implementation_reasoning_effort: body.implementation_reasoning_effort,
        title: body.title,
        metadata: body.metadata.unwrap_or_default(),
    };

    match state.upsert_dispatcher_binding(&project_id, input).await {
        Ok(binding) => created(json!({
            "binding": serialize_dispatcher_binding(&state, &project_id, binding).await,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn update_dispatcher_integration(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
    Json(body): Json<UpdateDispatcherIntegrationBody>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let dispatcher = match resolve_project_dispatcher(
        &state,
        &project_id,
        bridge_id,
        query.thread_id.as_deref(),
    )
    .await
    {
        Some(dispatcher) => dispatcher,
        None => {
            return error(
                StatusCode::NOT_FOUND,
                format!("Dispatcher thread for project {project_id} not found"),
            );
        }
    };

    let openclaw_thread_id = match integration_value_to_binding(body.openclaw_thread_id) {
        Ok(v) => v,
        Err(msg) => return error(StatusCode::BAD_REQUEST, msg.to_string()),
    };
    let openclaw_session_id = match integration_value_to_binding(body.openclaw_session_id) {
        Ok(v) => v,
        Err(msg) => return error(StatusCode::BAD_REQUEST, msg.to_string()),
    };

    match state
        .update_dispatcher_integration_binding(
            &dispatcher.id,
            openclaw_thread_id,
            openclaw_session_id,
        )
        .await
    {
        Ok(dispatcher) => ok(json!({
            "thread": serialize_dispatcher(&state, &dispatcher).await,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn update_dispatcher_preferences(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
    Json(body): Json<UpdateDispatcherPreferencesBody>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let dispatcher = match resolve_project_dispatcher(
        &state,
        &project_id,
        bridge_id,
        query.thread_id.as_deref(),
    )
    .await
    {
        Some(dispatcher) => dispatcher,
        None => {
            return error(
                StatusCode::NOT_FOUND,
                format!("Dispatcher thread for project {project_id} not found"),
            );
        }
    };

    match state
        .update_dispatcher_preferences(
            &dispatcher.id,
            body.implementation_agent,
            body.implementation_model,
            body.implementation_reasoning_effort,
            OpenClawDispatcherConfigPatch {
                gateway_url: body.openclaw_gateway_url,
                gateway_token: body.openclaw_gateway_token,
                gateway_scopes: body.openclaw_gateway_scopes,
                session_key: body.openclaw_session_key,
            },
        )
        .await
    {
        Ok(dispatcher) => ok(json!({
            "thread": serialize_dispatcher(&state, &dispatcher).await,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn dispatcher_task_context(
    state: &Arc<AppState>,
    project_id: &str,
    query: &DispatcherQuery,
) -> DispatcherTaskMutationContext {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let dispatcher =
        resolve_project_dispatcher(state, project_id, bridge_id, query.thread_id.as_deref()).await;
    DispatcherTaskMutationContext {
        activity_source: "dispatcher",
        caller_session: dispatcher.clone(),
        dispatcher_thread_id: dispatcher.map(|thread| thread.id),
    }
}

async fn create_dispatcher_task_route(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
    Json(mut body): Json<DispatcherTaskCreateInput>,
) -> ApiResponse {
    let context = dispatcher_task_context(&state, &project_id, &query).await;
    body.project = Some(project_id);
    match create_dispatcher_task(&state, context, body).await {
        Ok(result) => created(result.response_payload()),
        Err(err) => error(dispatcher_task_status(&err), err.to_string()),
    }
}

async fn update_dispatcher_task_route(
    State(state): State<Arc<AppState>>,
    Path((project_id, task_lookup)): Path<(String, String)>,
    Query(query): Query<DispatcherQuery>,
    Json(mut body): Json<DispatcherTaskUpdateInput>,
) -> ApiResponse {
    let context = dispatcher_task_context(&state, &project_id, &query).await;
    body.project = Some(project_id);
    body.task = Some(task_lookup);
    match update_dispatcher_task(&state, context, body).await {
        Ok(result) => ok(result.response_payload()),
        Err(err) => error(dispatcher_task_status(&err), err.to_string()),
    }
}

async fn handoff_dispatcher_task_route(
    State(state): State<Arc<AppState>>,
    Path((project_id, task_lookup)): Path<(String, String)>,
    Query(query): Query<DispatcherQuery>,
    Json(mut body): Json<DispatcherTaskUpdateInput>,
) -> ApiResponse {
    let context = dispatcher_task_context(&state, &project_id, &query).await;
    body.project = Some(project_id);
    body.task = Some(task_lookup);
    match handoff_dispatcher_task(&state, context, body).await {
        Ok(result) => ok(result.response_payload()),
        Err(err) => error(dispatcher_task_status(&err), err.to_string()),
    }
}

fn dispatcher_task_status(error: &anyhow::Error) -> StatusCode {
    let message = error.to_string();
    if message.starts_with("Unknown project:") || message.contains("not found in project") {
        return StatusCode::NOT_FOUND;
    }
    if message.contains("title is required")
        || message.contains("project is required")
        || message.contains("task is required")
        || message.contains("launch-ready")
    {
        return StatusCode::BAD_REQUEST;
    }
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn dispatcher_feed_payload(
    state: &AppState,
    dispatcher: &SessionRecord,
    window_limit: usize,
) -> Value {
    if let Some(payload) = state
        .cached_dispatcher_feed_payload(&dispatcher.id, window_limit)
        .await
    {
        return payload;
    }

    let parser_state = dispatcher
        .metadata
        .get("parserState")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|kind| {
            json!({
                "kind": kind,
                "message": dispatcher.metadata.get("parserStateMessage").cloned().unwrap_or_default(),
                "command": dispatcher.metadata.get("parserStateCommand").cloned(),
            })
        });

    let all_entries = build_normalized_chat_feed(dispatcher);
    let total_entries = all_entries.len();
    let entries = if total_entries > window_limit {
        all_entries
            .into_iter()
            .skip(total_entries - window_limit)
            .collect::<Vec<_>>()
    } else {
        all_entries
    };

    let payload = json!({
        "entries": entries,
        "totalEntries": total_entries,
        "windowLimit": window_limit,
        "truncated": total_entries > window_limit,
        "sessionStatus": dispatcher.status,
        "approvalState": dispatcher.metadata.get("acpPlanApprovalState").cloned(),
        "parserState": parser_state,
        "runtimeStatus": Value::Null,
        "source": if dispatcher.output.is_empty() { "conversation-only" } else { "runtime-output" },
        "integration": dispatcher_integration_payload(dispatcher, &dispatcher.project_id),
    });

    state
        .store_dispatcher_feed_payload(&dispatcher.id, window_limit, payload.clone())
        .await;
    payload
}

fn dispatcher_integration_payload(dispatcher: &SessionRecord, project_id: &str) -> Value {
    let meta = &dispatcher.metadata;
    json!({
        "projectId": project_id,
        "threadId": dispatcher.id,
        "bridgeId": dispatcher.bridge_id,
        "openclaw": {
            "threadId": meta.get("openclawThreadId").cloned(),
            "sessionId": meta.get("openclawSessionId").cloned(),
            "gatewayUrl": meta.get("openclawGatewayUrl").cloned(),
            "gatewayTokenConfigured": meta.get("openclawGatewayTokenConfigured").cloned(),
            "gatewayScopes": meta.get("openclawGatewayScopes").cloned(),
            "sessionKey": meta.get("openclawSessionKey").cloned(),
        },
        "heartbeat": {
            "state": meta.get("acpHeartbeatState").cloned(),
            "nextAt": meta.get("acpNextHeartbeatAt").cloned(),
        },
        "memory": {
            "projectPath": meta.get("acpProjectMemoryPath").cloned(),
            "sessionPath": meta.get("acpSessionMemoryPath").cloned(),
        },
    })
}

fn streaming_tail_patch(previous_entries: &[Value], next_entries: &[Value]) -> Option<Value> {
    if previous_entries.len() != next_entries.len() || previous_entries.is_empty() {
        return None;
    }

    let shared_prefix_len = previous_entries.len().saturating_sub(1);
    if !previous_entries
        .iter()
        .take(shared_prefix_len)
        .zip(next_entries.iter().take(shared_prefix_len))
        .all(|(left, right)| left == right)
    {
        return None;
    }

    let previous_last = previous_entries.last()?;
    let next_last = next_entries.last()?;
    if previous_last == next_last {
        return None;
    }

    let entry_id = next_last.get("id").and_then(Value::as_str)?.to_string();
    if previous_last.get("id").and_then(Value::as_str) != Some(entry_id.as_str()) {
        return None;
    }
    if previous_last.get("kind") != next_last.get("kind")
        || previous_last.get("source") != next_last.get("source")
    {
        return None;
    }

    let previous_streaming = previous_last
        .get("streaming")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next_streaming = next_last
        .get("streaming")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !previous_streaming && !next_streaming {
        return None;
    }

    let text_delta = match (
        previous_last.get("text").and_then(Value::as_str),
        next_last.get("text").and_then(Value::as_str),
    ) {
        (Some(previous_text), Some(next_text)) => {
            next_text.strip_prefix(previous_text).map(str::to_string)
        }
        _ => None,
    };

    Some(json!({
        "type": "patch",
        "entryId": entry_id,
        "entry": next_last,
        "textDelta": text_delta,
    }))
}

fn build_feed_delta_event(previous: &Value, next: &Value) -> Value {
    let previous_entries = previous
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_entries = next
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let can_append = previous_entries.len() <= next_entries.len()
        && previous_entries
            .iter()
            .zip(next_entries.iter())
            .all(|(left, right)| left == right);

    if can_append {
        return json!({
            "type": "append",
            "entries": next_entries.into_iter().skip(previous_entries.len()).collect::<Vec<_>>(),
            "totalEntries": next.get("totalEntries").cloned().unwrap_or(Value::Null),
            "windowLimit": next.get("windowLimit").cloned().unwrap_or(Value::Null),
            "truncated": next.get("truncated").cloned().unwrap_or(Value::Null),
            "sessionStatus": next.get("sessionStatus").cloned().unwrap_or(Value::Null),
            "approvalState": next.get("approvalState").cloned().unwrap_or(Value::Null),
            "parserState": next.get("parserState").cloned().unwrap_or(Value::Null),
            "runtimeStatus": next.get("runtimeStatus").cloned().unwrap_or(Value::Null),
            "source": next.get("source").cloned().unwrap_or(Value::Null),
            "error": next.get("error").cloned().unwrap_or(Value::Null),
            "integration": next.get("integration").cloned().unwrap_or(Value::Null),
        });
    }

    if let Some(mut patch) = streaming_tail_patch(&previous_entries, &next_entries) {
        patch["totalEntries"] = next.get("totalEntries").cloned().unwrap_or(Value::Null);
        patch["windowLimit"] = next.get("windowLimit").cloned().unwrap_or(Value::Null);
        patch["truncated"] = next.get("truncated").cloned().unwrap_or(Value::Null);
        patch["sessionStatus"] = next.get("sessionStatus").cloned().unwrap_or(Value::Null);
        patch["approvalState"] = next.get("approvalState").cloned().unwrap_or(Value::Null);
        patch["parserState"] = next.get("parserState").cloned().unwrap_or(Value::Null);
        patch["runtimeStatus"] = next.get("runtimeStatus").cloned().unwrap_or(Value::Null);
        patch["source"] = next.get("source").cloned().unwrap_or(Value::Null);
        patch["error"] = next.get("error").cloned().unwrap_or(Value::Null);
        patch["integration"] = next.get("integration").cloned().unwrap_or(Value::Null);
        return patch;
    }

    json!({
        "type": "replace",
        "payload": next,
    })
}

async fn get_feed(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<FeedQuery>,
) -> ApiResponse {
    let window_limit = resolve_feed_window_limit(query.limit);
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    match resolve_project_dispatcher(&state, &project_id, bridge_id, query.thread_id.as_deref())
        .await
    {
        Some(dispatcher) => ok(dispatcher_feed_payload(&state, &dispatcher, window_limit).await),
        None => error(
            StatusCode::NOT_FOUND,
            format!("Dispatcher thread for project {project_id} not found"),
        ),
    }
}

async fn feed_stream(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<FeedQuery>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let window_limit = resolve_feed_window_limit(query.limit);
    let bridge_id = query.bridge_id.clone();
    let thread_id = query.thread_id.clone();
    let initial_dispatcher = resolve_project_dispatcher(
        &state,
        &project_id,
        bridge_id.as_deref(),
        thread_id.as_deref(),
    )
    .await;
    let initial_payload = match initial_dispatcher.as_ref() {
        Some(dispatcher) => dispatcher_feed_payload(&state, dispatcher, window_limit).await,
        None => json!({
            "entries": [],
            "totalEntries": 0,
            "windowLimit": window_limit,
            "truncated": false,
            "sessionStatus": Value::Null,
            "approvalState": Value::Null,
            "parserState": Value::Null,
            "runtimeStatus": Value::Null,
            "integration": Value::Null,
            "error": format!("Dispatcher thread for project {project_id} not found"),
        }),
    };
    let initial_thread_id = initial_dispatcher
        .as_ref()
        .map(|dispatcher| dispatcher.id.clone());
    let initial_stream = stream::iter(vec![Ok(
        SseEvent::default().data(initial_payload.to_string())
    )]);

    let feed_state = Arc::new(Mutex::new((initial_thread_id, initial_payload.clone())));
    let updates = BroadcastStream::new(state.dispatcher_updates.subscribe())
        .then(move |result| {
            let state = state.clone();
            let project_id = project_id.clone();
            let bridge_id = bridge_id.clone();
            let thread_id = thread_id.clone();
            let feed_state = feed_state.clone();
            async move {
                match result {
                    Ok(updated_id) => {
                        let dispatcher = resolve_project_dispatcher(
                            &state,
                            &project_id,
                            bridge_id.as_deref(),
                            thread_id.as_deref(),
                        )
                        .await?;
                        if dispatcher.id != updated_id {
                            let current_id = feed_state.lock().await.0.clone();
                            if current_id.as_deref() != Some(dispatcher.id.as_str()) {
                                return None;
                            }
                        }
                        let next_payload =
                            dispatcher_feed_payload(&state, &dispatcher, window_limit).await;
                        let mut feed_state = feed_state.lock().await;
                        let delta = build_feed_delta_event(&feed_state.1, &next_payload);
                        feed_state.0 = Some(dispatcher.id.clone());
                        feed_state.1 = next_payload;
                        Some(Ok(SseEvent::default().data(delta.to_string())))
                    }
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                        count,
                    )) => Some(Ok(SseEvent::default().event("refresh").data(
                        json!({ "type": "refresh", "reason": "lagged", "missed": count })
                            .to_string(),
                    ))),
                }
            }
        })
        .filter_map(|item| item);

    Sse::new(initial_stream.chain(updates)).keep_alive(KeepAlive::default())
}

async fn send_to_dispatcher(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
    Json(body): Json<SendBody>,
) -> ApiResponse {
    let attachments = body.attachments.unwrap_or_default();
    if body.message.trim().is_empty() && attachments.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "Message or attachments are required",
        );
    }

    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let requested_thread_id = trimmed_query_value(query.thread_id.as_deref());
    let dispatcher =
        match resolve_project_dispatcher(&state, &project_id, bridge_id, requested_thread_id).await
        {
            Some(dispatcher) => dispatcher,
            None => {
                if requested_thread_id.is_some() {
                    return error(
                        StatusCode::NOT_FOUND,
                        format!("Dispatcher thread for project {project_id} not found"),
                    );
                }
                match state
                    .create_project_dispatcher_thread(
                        &project_id,
                        CreateDispatcherThreadOptions {
                            bridge_id: query.bridge_id.clone(),
                            dispatcher_agent: None,
                            implementation_agent: None,
                            openclaw_config: OpenClawDispatcherConfigPatch::default(),
                            dispatcher_model: body.model.clone(),
                            dispatcher_reasoning_effort: body.reasoning_effort.clone(),
                            implementation_model: body.model.clone(),
                            implementation_reasoning_effort: body.reasoning_effort.clone(),
                            force_new: false,
                        },
                    )
                    .await
                {
                    Ok(dispatcher) => dispatcher,
                    Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
                }
            }
        };

    match state
        .send_to_dispatcher_thread(
            &dispatcher.id,
            crate::state::DispatcherTurnRequest::plain(
                body.message,
                attachments,
                body.model,
                body.reasoning_effort,
                "dispatcher_ui",
            ),
        )
        .await
    {
        Ok(()) => ok(json!({ "ok": true, "threadId": dispatcher.id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn interrupt_dispatcher(
    State(state): State<Arc<AppState>>,
    Path(project_id): Path<String>,
    Query(query): Query<DispatcherQuery>,
) -> ApiResponse {
    let bridge_id = trimmed_query_value(query.bridge_id.as_deref());
    let dispatcher = match resolve_project_dispatcher(
        &state,
        &project_id,
        bridge_id,
        query.thread_id.as_deref(),
    )
    .await
    {
        Some(dispatcher) => dispatcher,
        None => {
            return error(
                StatusCode::NOT_FOUND,
                format!("Dispatcher thread for project {project_id} not found"),
            );
        }
    };

    match state.interrupt_dispatcher(&dispatcher.id).await {
        Ok(()) => ok(json!({ "ok": true, "threadId": dispatcher.id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{dispatcher_matches_scope, trimmed_query_value};
    use crate::state::{SessionRecord, SessionStatus};
    use serde_json::Value;

    fn build_dispatcher(id: &str) -> SessionRecord {
        let mut session = SessionRecord::new(
            id.to_string(),
            "alpha".to_string(),
            None,
            None,
            None,
            "codex".to_string(),
            None,
            None,
            "prompt".to_string(),
            None,
        );
        session.status = SessionStatus::Idle;
        session
            .metadata
            .insert("sessionKind".to_string(), "project_dispatcher".to_string());
        session
    }

    #[test]
    fn trimmed_query_value_normalizes_blank_strings() {
        assert_eq!(trimmed_query_value(None), None);
        assert_eq!(trimmed_query_value(Some("   ")), None);
        assert_eq!(trimmed_query_value(Some(" thread-1 ")), Some("thread-1"));
    }

    #[test]
    fn dispatcher_matches_scope_checks_project_kind_and_bridge() {
        let mut dispatcher = build_dispatcher("dispatcher-1");
        dispatcher.bridge_id = Some("bridge-1".to_string());
        assert!(dispatcher_matches_scope(
            &dispatcher,
            "alpha",
            Some("bridge-1")
        ));
        assert!(!dispatcher_matches_scope(
            &dispatcher,
            "beta",
            Some("bridge-1")
        ));
        assert!(!dispatcher_matches_scope(
            &dispatcher,
            "alpha",
            Some("bridge-2")
        ));

        dispatcher.metadata.remove("sessionKind");
        assert!(!dispatcher_matches_scope(
            &dispatcher,
            "alpha",
            Some("bridge-1")
        ));
    }

    #[test]
    fn integration_value_maps_json_null_to_clear() {
        assert_eq!(
            super::integration_value_to_binding(Some(Value::Null)).unwrap(),
            Some(None)
        );
        assert_eq!(
            super::integration_value_to_binding(Some(Value::String("t1".to_string()))).unwrap(),
            Some(Some("t1".to_string()))
        );
        assert_eq!(super::integration_value_to_binding(None).unwrap(), None);
    }

    #[test]
    fn feed_delta_patch_updates_last_streaming_entry() {
        let previous = serde_json::json!({
            "entries": [
                { "id": "1", "kind": "user", "text": "ship it", "source": "chat", "streaming": false },
                { "id": "2", "kind": "assistant", "text": "Working", "source": "runtime", "streaming": true }
            ],
            "totalEntries": 2,
            "windowLimit": 120,
            "truncated": false,
            "sessionStatus": "working",
            "integration": Value::Null,
        });
        let next = serde_json::json!({
            "entries": [
                { "id": "1", "kind": "user", "text": "ship it", "source": "chat", "streaming": false },
                { "id": "2", "kind": "assistant", "text": "Working on it", "source": "runtime", "streaming": true }
            ],
            "totalEntries": 2,
            "windowLimit": 120,
            "truncated": false,
            "sessionStatus": "working",
            "integration": Value::Null,
        });

        let delta = super::build_feed_delta_event(&previous, &next);

        assert_eq!(
            delta.get("type").and_then(|value| value.as_str()),
            Some("patch")
        );
        assert_eq!(
            delta.get("entryId").and_then(|value| value.as_str()),
            Some("2")
        );
        assert_eq!(
            delta.get("textDelta").and_then(|value| value.as_str()),
            Some(" on it")
        );
    }
}
