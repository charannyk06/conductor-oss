use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

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
}
