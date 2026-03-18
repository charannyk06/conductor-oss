// ttyd binary protocol implementation for efficient terminal streaming
// Ref: https://github.com/tsl0922/ttyd
//
// Command bytes (first byte of WebSocket message):
// - '0' (0x30): OUTPUT (server->client) or INPUT (client->server)
// - '1' (0x31): SET_WINDOW_TITLE (server->client) or RESIZE_TERMINAL (client->server)
// - '2' (0x32): SET_PREFERENCES (server->client) or PAUSE (client->server)
// - '3' (0x33): RESUME (client->server)
// - '{' (0x7B): JSON_DATA / handshake (client->server)

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue as WsHeaderValue;

pub const CMD_OUTPUT: u8 = b'0';
pub const CMD_INPUT: u8 = b'0';
pub const CMD_SET_WINDOW_TITLE: u8 = b'1';
pub const CMD_RESIZE_TERMINAL: u8 = b'1';
pub const CMD_SET_PREFERENCES: u8 = b'2';
pub const CMD_PAUSE: u8 = b'2';
pub const CMD_RESUME: u8 = b'3';
pub const CMD_JSON_DATA: u8 = b'{';

pub fn upstream_ws_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}/ws")
}

pub fn connect_request(ws_url: &str) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
    let mut request = ws_url
        .into_client_request()
        .context("Failed to create ttyd WebSocket request")?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", WsHeaderValue::from_static("tty"));
    Ok(request)
}

pub fn encode_handshake(cols: u16, rows: u16) -> Vec<u8> {
    json!({
        "columns": cols,
        "rows": rows,
    })
    .to_string()
    .into_bytes()
}

/// Parse RESIZE_TERMINAL message: '1' + JSON{columns, rows}
pub fn parse_resize_message(payload: &[u8]) -> Option<(u16, u16)> {
    let json_str = std::str::from_utf8(payload).ok()?;
    let value: Value = serde_json::from_str(json_str).ok()?;

    let columns = value.get("columns")?.as_u64()? as u16;
    let rows = value.get("rows")?.as_u64()? as u16;

    Some((columns, rows))
}

/// Create OUTPUT message: '0' + raw_bytes
pub fn encode_output(data: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(1 + data.len());
    msg.push(CMD_OUTPUT);
    msg.extend_from_slice(data);
    msg
}

/// Create SET_WINDOW_TITLE message: '1' + UTF-8 title
pub fn encode_window_title(title: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(1 + title.len());
    msg.push(CMD_SET_WINDOW_TITLE);
    msg.extend_from_slice(title.as_bytes());
    msg
}

/// Create SET_PREFERENCES message: '2' + JSON preferences
pub fn encode_preferences(prefs: &Value) -> Vec<u8> {
    let json_str = prefs.to_string();
    let mut msg = Vec::with_capacity(1 + json_str.len());
    msg.push(CMD_SET_PREFERENCES);
    msg.extend_from_slice(json_str.as_bytes());
    msg
}

/// Create RESIZE_TERMINAL message: '1' + JSON{columns, rows}
pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    let resize_json = json!({
        "columns": cols,
        "rows": rows,
    });
    let json_str = resize_json.to_string();
    let mut msg = Vec::with_capacity(1 + json_str.len());
    msg.push(CMD_RESIZE_TERMINAL);
    msg.extend_from_slice(json_str.as_bytes());
    msg
}

/// Create PAUSE message (single byte)
pub fn encode_pause() -> Vec<u8> {
    vec![CMD_PAUSE]
}

/// Create RESUME message (single byte)
pub fn encode_resume() -> Vec<u8> {
    vec![CMD_RESUME]
}

/// Default terminal preferences sent to client.
///
/// NOTE: The frontend owns the terminal theme and font sizing via
/// `getTerminalTheme()` and `getSessionTerminalViewportOptions()`.
/// Sending `"theme"` or `"fontSize"` here would override the frontend's
/// carefully designed 16-color palette and responsive font sizing, so we
/// intentionally omit them.  Only send preferences that the frontend
/// cannot determine on its own.
pub fn default_preferences() -> Value {
    json!({
        "bellSound": "",
    })
}

/// Messages received from client
#[derive(Debug, Clone)]
pub enum ClientMessage {
    /// INPUT: keyboard/binary input from client
    Input(Vec<u8>),
    /// RESIZE_TERMINAL: terminal resize request
    Resize { columns: u16, rows: u16 },
    /// PAUSE: client wants to pause output (backpressure)
    Pause,
    /// RESUME: client ready to receive output again
    Resume,
    /// JSON_DATA: initial handshake with auth token
    Handshake(Value),
}

impl ClientMessage {
    /// Parse a WebSocket message (binary frame) according to ttyd protocol
    pub fn from_websocket_frame(data: &[u8]) -> Option<Self> {
        if data.is_empty() {
            return None;
        }

        let cmd = data[0];
        let payload = &data[1..];

        match cmd {
            CMD_INPUT => Some(ClientMessage::Input(payload.to_vec())),
            CMD_PAUSE => Some(ClientMessage::Pause),
            CMD_RESUME => Some(ClientMessage::Resume),
            CMD_RESIZE_TERMINAL => {
                let (cols, rows) = parse_resize_message(payload)?;
                Some(ClientMessage::Resize {
                    columns: cols,
                    rows,
                })
            }
            CMD_JSON_DATA => {
                // First message is JSON handshake
                let json_str = std::str::from_utf8(data).ok()?;
                let value: Value = serde_json::from_str(json_str).ok()?;
                Some(ClientMessage::Handshake(value))
            }
            _ => None,
        }
    }
}

// NOTE: Flow control config lives in the browser terminal facade.
// Server-side PAUSE/RESUME support is not yet implemented — see TODO in terminal.rs.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_resize_message() {
        let json = br#"{"columns":120,"rows":40}"#;
        let (cols, rows) = parse_resize_message(json).unwrap();
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_encode_output() {
        let output = encode_output(b"hello");
        assert_eq!(output[0], CMD_OUTPUT);
        assert_eq!(&output[1..], b"hello");
    }

    #[test]
    fn test_client_message_input() {
        let mut msg = vec![CMD_INPUT];
        msg.extend_from_slice(b"test");
        let parsed = ClientMessage::from_websocket_frame(&msg).unwrap();
        match parsed {
            ClientMessage::Input(data) => assert_eq!(data, b"test"),
            _ => panic!("Expected Input variant"),
        }
    }

    #[test]
    fn test_client_message_resize() {
        let msg = encode_resize(100, 30);
        let parsed = ClientMessage::from_websocket_frame(&msg).unwrap();
        match parsed {
            ClientMessage::Resize { columns, rows } => {
                assert_eq!(columns, 100);
                assert_eq!(rows, 30);
            }
            _ => panic!("Expected Resize variant"),
        }
    }
}
