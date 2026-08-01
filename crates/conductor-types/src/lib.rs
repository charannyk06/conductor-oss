use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const API_STREAM_V1_CAPABILITY: &str = "api_stream_v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserToBridgeMessage {
    TerminalResize {
        cols: u32,
        rows: u32,
    },
    TerminalInput {
        data: String,
    },
    ApiRequest {
        id: String,
        method: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
    },
    ApiStreamRequest {
        id: String,
        method: String,
        path: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
    },
    ApiStreamCancel {
        id: String,
    },
    PreviewRequest {
        id: String,
        session_id: String,
        method: String,
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body_base64: Option<String>,
    },
    TerminalProxyStart {
        terminal_id: String,
        session_id: String,
    },
    FileBrowse {
        path: String,
    },
    Ping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeToBrowserMessage {
    TerminalOutput {
        data: String,
    },
    ApiResponse {
        id: String,
        status: u16,
        body: Value,
    },
    ApiStreamStart {
        id: String,
        status: u16,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    ApiStreamChunk {
        id: String,
        chunk_base64: String,
    },
    ApiStreamEnd {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PreviewResponse {
        id: String,
        status: u16,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body_base64: Option<String>,
    },
    FileTree {
        path: String,
        entries: Vec<FileEntry>,
    },
    BridgeStatus {
        hostname: String,
        os: String,
        connected: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        capabilities: Vec<String>,
    },
    Pong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: FileEntryKind,
}

pub type BrowserToBridge = BrowserToBridgeMessage;
pub type BridgeToBrowser = BridgeToBrowserMessage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub hostname: String,
    pub os: String,
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_message_serializes_in_contract_shape() {
        let msg = BrowserToBridgeMessage::ApiRequest {
            id: "req-1".to_string(),
            method: "POST".to_string(),
            path: "/api/test".to_string(),
            body: Some(json!({"hello":"world"})),
        };

        let value = serde_json::to_value(msg).expect("serialize");
        assert_eq!(
            value,
            json!({
                "type": "api_request",
                "id": "req-1",
                "method": "POST",
                "path": "/api/test",
                "body": { "hello": "world" }
            })
        );
    }

    #[test]
    fn bridge_message_roundtrips() {
        let msg = BridgeToBrowserMessage::FileTree {
            path: "/workspace".to_string(),
            entries: vec![
                FileEntry {
                    name: "src".to_string(),
                    kind: FileEntryKind::Dir,
                },
                FileEntry {
                    name: "README.md".to_string(),
                    kind: FileEntryKind::File,
                },
            ],
        };

        let encoded = serde_json::to_string(&msg).expect("serialize");
        let decoded: BridgeToBrowserMessage = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, msg);
    }

    #[test]
    fn bridge_status_serializes_optional_version() {
        let msg = BridgeToBrowserMessage::BridgeStatus {
            hostname: "Mac".to_string(),
            os: "darwin".to_string(),
            connected: true,
            version: Some("0.3.4".to_string()),
            capabilities: vec![API_STREAM_V1_CAPABILITY.to_string()],
        };

        let value = serde_json::to_value(msg).expect("serialize");
        assert_eq!(
            value,
            json!({
                "type": "bridge_status",
                "hostname": "Mac",
                "os": "darwin",
                "connected": true,
                "version": "0.3.4",
                "capabilities": ["api_stream_v1"]
            })
        );
    }

    #[test]
    fn bridge_stream_messages_roundtrip_in_contract_shape() {
        let request = BrowserToBridgeMessage::ApiStreamRequest {
            id: "stream-1".to_string(),
            method: "GET".to_string(),
            path: "/api/feed/stream".to_string(),
            headers: BTreeMap::from([
                ("accept".to_string(), "text/event-stream".to_string()),
                ("cache-control".to_string(), "no-cache".to_string()),
            ]),
            body: None,
        };
        let request_value = serde_json::to_value(request).expect("serialize stream request");
        assert_eq!(
            request_value,
            json!({
                "type": "api_stream_request",
                "id": "stream-1",
                "method": "GET",
                "path": "/api/feed/stream",
                "headers": {
                    "accept": "text/event-stream",
                    "cache-control": "no-cache"
                }
            })
        );

        let encoded = serde_json::to_string(&BridgeToBrowserMessage::ApiStreamStart {
            id: "stream-1".to_string(),
            status: 200,
            headers: BTreeMap::from([(
                "content-type".to_string(),
                "text/event-stream".to_string(),
            )]),
        })
        .expect("serialize stream start");
        let decoded: BridgeToBrowserMessage =
            serde_json::from_str(&encoded).expect("deserialize stream start");
        assert_eq!(
            decoded,
            BridgeToBrowserMessage::ApiStreamStart {
                id: "stream-1".to_string(),
                status: 200,
                headers: BTreeMap::from([(
                    "content-type".to_string(),
                    "text/event-stream".to_string(),
                )]),
            }
        );

        let cancel = serde_json::to_value(BrowserToBridgeMessage::ApiStreamCancel {
            id: "stream-1".to_string(),
        })
        .expect("serialize stream cancel");
        assert_eq!(
            cancel,
            json!({
                "type": "api_stream_cancel",
                "id": "stream-1",
            })
        );
    }

    #[test]
    fn legacy_api_messages_remain_backward_compatible() {
        let request: BrowserToBridgeMessage = serde_json::from_value(json!({
            "type": "api_request",
            "id": "req-1",
            "method": "POST",
            "path": "/api/test",
            "body": {"hello": "world"}
        }))
        .expect("deserialize legacy api request");
        assert_eq!(
            request,
            BrowserToBridgeMessage::ApiRequest {
                id: "req-1".to_string(),
                method: "POST".to_string(),
                path: "/api/test".to_string(),
                body: Some(json!({"hello":"world"})),
            }
        );

        let response: BridgeToBrowserMessage = serde_json::from_value(json!({
            "type": "api_response",
            "id": "req-1",
            "status": 202,
            "body": {"ok": true}
        }))
        .expect("deserialize legacy api response");
        assert_eq!(
            response,
            BridgeToBrowserMessage::ApiResponse {
                id: "req-1".to_string(),
                status: 202,
                body: json!({"ok": true}),
            }
        );

        let status: BridgeToBrowserMessage = serde_json::from_value(json!({
            "type": "bridge_status",
            "hostname": "Mac",
            "os": "darwin",
            "connected": true,
            "version": "0.3.4"
        }))
        .expect("deserialize legacy bridge status");
        assert_eq!(
            status,
            BridgeToBrowserMessage::BridgeStatus {
                hostname: "Mac".to_string(),
                os: "darwin".to_string(),
                connected: true,
                version: Some("0.3.4".to_string()),
                capabilities: Vec::new(),
            }
        );
    }
}
