// ttyd WebSocket binary protocol constants and frame helpers.
//
// The protocol uses a 1-byte type prefix on every binary WebSocket message.
//
// Client -> Server:
//   0x30 ('0') INPUT   - raw terminal input bytes
//   0x31 ('1') RESIZE  - JSON {"columns":N,"rows":N}
//   0x32 ('2') PAUSE   - pause PTY output
//   0x33 ('3') RESUME  - resume PTY output
//   0x7B ('{') JSON    - initial handshake with auth + dimensions
//
// Server -> Client:
//   0x30 ('0') OUTPUT  - raw PTY output bytes
//   0x31 ('1') TITLE   - window title string
//   0x32 ('2') PREFS   - JSON terminal preferences

// -- Client -> Server message types ------------------------------------------

/// Raw terminal input bytes (keystrokes).
pub const CLIENT_INPUT: u8 = 0x30;

/// Resize request: JSON payload `{"columns":N,"rows":N}`.
pub const CLIENT_RESIZE: u8 = 0x31;

/// Pause PTY output (flow control).
pub const CLIENT_PAUSE: u8 = 0x32;

/// Resume PTY output (flow control).
pub const CLIENT_RESUME: u8 = 0x33;

/// JSON handshake message (first byte is `{`).
pub const CLIENT_JSON: u8 = 0x7B;

// -- Server -> Client message types -------------------------------------------

/// Raw PTY output bytes.
pub const SERVER_OUTPUT: u8 = 0x30;

/// Window title update.
pub const SERVER_TITLE: u8 = 0x31;

/// Terminal preferences (JSON).
pub const SERVER_PREFS: u8 = 0x32;

/// Default maximum buffer size during PAUSE (64 KB).
pub const DEFAULT_PAUSE_BUFFER_CAPACITY: usize = 64 * 1024;

/// Encode a server OUTPUT frame: `[0x30] [payload]`.
pub fn encode_output(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + payload.len());
    frame.push(SERVER_OUTPUT);
    frame.extend_from_slice(payload);
    frame
}

/// Encode a server TITLE frame: `[0x31] [title_utf8]`.
pub fn encode_title(title: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + title.len());
    frame.push(SERVER_TITLE);
    frame.extend_from_slice(title.as_bytes());
    frame
}

/// Encode a server PREFS frame: `[0x32] [json_utf8]`.
pub fn encode_prefs(json: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + json.len());
    frame.push(SERVER_PREFS);
    frame.extend_from_slice(json.as_bytes());
    frame
}

/// Parsed client message.
#[derive(Debug, Clone)]
pub enum ClientMessage {
    /// Raw terminal input bytes.
    Input(Vec<u8>),
    /// Resize request.
    Resize { columns: u16, rows: u16 },
    /// Pause PTY output.
    Pause,
    /// Resume PTY output.
    Resume,
    /// JSON handshake with optional auth and initial dimensions.
    Handshake(HandshakePayload),
}

/// Initial JSON handshake from the client.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct HandshakePayload {
    #[serde(default)]
    pub columns: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub token: Option<String>,
}

/// Resize payload sent by the client.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ResizePayload {
    pub columns: u16,
    pub rows: u16,
}

/// Parse a binary WebSocket message from the client.
pub fn parse_client_message(data: &[u8]) -> Option<ClientMessage> {
    if data.is_empty() {
        return None;
    }

    let msg_type = data[0];
    let payload = &data[1..];

    match msg_type {
        CLIENT_INPUT => Some(ClientMessage::Input(payload.to_vec())),
        CLIENT_RESIZE => {
            let resize: ResizePayload = serde_json::from_slice(payload).ok()?;
            Some(ClientMessage::Resize {
                columns: resize.columns,
                rows: resize.rows,
            })
        }
        CLIENT_PAUSE => Some(ClientMessage::Pause),
        CLIENT_RESUME => Some(ClientMessage::Resume),
        CLIENT_JSON => {
            // The entire message (including the '{' prefix) is JSON.
            let handshake: HandshakePayload = serde_json::from_slice(data).ok()?;
            Some(ClientMessage::Handshake(handshake))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_output() {
        let frame = encode_output(b"hello");
        assert_eq!(frame[0], SERVER_OUTPUT);
        assert_eq!(&frame[1..], b"hello");
    }

    #[test]
    fn test_encode_title() {
        let frame = encode_title("my-title");
        assert_eq!(frame[0], SERVER_TITLE);
        assert_eq!(&frame[1..], b"my-title");
    }

    #[test]
    fn test_encode_prefs() {
        let json = r#"{"fontSize":14}"#;
        let frame = encode_prefs(json);
        assert_eq!(frame[0], SERVER_PREFS);
        assert_eq!(&frame[1..], json.as_bytes());
    }

    #[test]
    fn test_parse_input() {
        let data = [CLIENT_INPUT, b'h', b'i'];
        let msg = parse_client_message(&data).unwrap();
        match msg {
            ClientMessage::Input(bytes) => assert_eq!(bytes, b"hi"),
            _ => panic!("expected Input"),
        }
    }

    #[test]
    fn test_parse_resize() {
        let json = r#"{"columns":120,"rows":40}"#;
        let mut data = vec![CLIENT_RESIZE];
        data.extend_from_slice(json.as_bytes());
        let msg = parse_client_message(&data).unwrap();
        match msg {
            ClientMessage::Resize { columns, rows } => {
                assert_eq!(columns, 120);
                assert_eq!(rows, 40);
            }
            _ => panic!("expected Resize"),
        }
    }

    #[test]
    fn test_parse_pause_resume() {
        assert!(matches!(
            parse_client_message(&[CLIENT_PAUSE]),
            Some(ClientMessage::Pause)
        ));
        assert!(matches!(
            parse_client_message(&[CLIENT_RESUME]),
            Some(ClientMessage::Resume)
        ));
    }

    #[test]
    fn test_parse_handshake() {
        let json = r#"{"columns":80,"rows":24,"token":"abc"}"#;
        let msg = parse_client_message(json.as_bytes()).unwrap();
        match msg {
            ClientMessage::Handshake(h) => {
                assert_eq!(h.columns, Some(80));
                assert_eq!(h.rows, Some(24));
                assert_eq!(h.token.as_deref(), Some("abc"));
            }
            _ => panic!("expected Handshake"),
        }
    }

    #[test]
    fn test_parse_empty() {
        assert!(parse_client_message(&[]).is_none());
    }
}
