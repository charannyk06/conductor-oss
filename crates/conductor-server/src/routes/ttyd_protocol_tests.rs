#[cfg(test)]
mod tests {
    use crate::routes::ttyd_protocol::*;
    use serde_json::json;

    #[test]
    fn test_encode_output() {
        let data = b"hello world";
        let frame = encode_output(data);

        assert_eq!(frame[0], CMD_OUTPUT);
        assert_eq!(&frame[1..], data);
    }

    #[test]
    fn test_encode_window_title() {
        let title = "bash (localhost)";
        let frame = encode_window_title(title);

        assert_eq!(frame[0], CMD_SET_WINDOW_TITLE);
        assert_eq!(std::str::from_utf8(&frame[1..]).unwrap(), title);
    }

    #[test]
    fn test_encode_preferences() {
        let prefs = json!({
            "fontSize": 16,
            "theme": "xterm"
        });
        let frame = encode_preferences(&prefs);

        assert_eq!(frame[0], CMD_SET_PREFERENCES);
        let json_str = std::str::from_utf8(&frame[1..]).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["fontSize"], 16);
        assert_eq!(parsed["theme"], "xterm");
    }

    #[test]
    fn test_encode_resize() {
        let frame = encode_resize(120, 40);

        assert_eq!(frame[0], CMD_RESIZE_TERMINAL);
        let (cols, rows) = parse_resize_message(&frame[1..]).unwrap();
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_encode_pause_resume() {
        let pause = encode_pause();
        assert_eq!(pause, vec![CMD_PAUSE]);

        let resume = encode_resume();
        assert_eq!(resume, vec![CMD_RESUME]);
    }

    #[test]
    fn test_parse_input_message() {
        let mut msg = vec![CMD_INPUT];
        msg.extend_from_slice(b"hello");

        match ClientMessage::from_websocket_frame(&msg).unwrap() {
            ClientMessage::Input(data) => {
                assert_eq!(data, b"hello");
            }
            _ => panic!("Expected Input variant"),
        }
    }

    #[test]
    fn test_parse_resize_message() {
        let mut msg = vec![CMD_RESIZE_TERMINAL];
        msg.extend_from_slice(br#"{"columns":100,"rows":30}"#);

        match ClientMessage::from_websocket_frame(&msg).unwrap() {
            ClientMessage::Resize { columns, rows } => {
                assert_eq!(columns, 100);
                assert_eq!(rows, 30);
            }
            _ => panic!("Expected Resize variant"),
        }
    }

    #[test]
    fn test_parse_pause() {
        let msg = vec![CMD_PAUSE];

        match ClientMessage::from_websocket_frame(&msg).unwrap() {
            ClientMessage::Pause => {},
            _ => panic!("Expected Pause variant"),
        }
    }

    #[test]
    fn test_parse_resume() {
        let msg = vec![CMD_RESUME];

        match ClientMessage::from_websocket_frame(&msg).unwrap() {
            ClientMessage::Resume => {},
            _ => panic!("Expected Resume variant"),
        }
    }

    #[test]
    fn test_flow_control_defaults() {
        let fc = FlowControlConfig::default();

        assert_eq!(fc.write_threshold, 100_000);
        assert_eq!(fc.high_water, 10);
        assert_eq!(fc.low_water, 4);
    }

    #[test]
    fn test_parse_invalid_message() {
        let msg = vec![]; // Empty message
        assert!(ClientMessage::from_websocket_frame(&msg).is_none());
    }

    #[test]
    fn test_parse_unknown_command() {
        let msg = vec![0xFF]; // Unknown command
        assert!(ClientMessage::from_websocket_frame(&msg).is_none());
    }

    #[test]
    fn test_malformed_resize_json() {
        let mut msg = vec![CMD_RESIZE_TERMINAL];
        msg.extend_from_slice(b"not json");

        assert!(ClientMessage::from_websocket_frame(&msg).is_none());
    }

    #[test]
    fn test_utf8_output() {
        let utf8_data = "Hello 世界 🚀".as_bytes();
        let frame = encode_output(utf8_data);

        assert_eq!(frame[0], CMD_OUTPUT);
        assert_eq!(&frame[1..], utf8_data);
        // Verify it round-trips
        assert_eq!(std::str::from_utf8(&frame[1..]).unwrap(), "Hello 世界 🚀");
    }

    #[test]
    fn test_binary_input() {
        // Binary data (not valid UTF-8)
        let binary_data = vec![0xFF, 0xFE, 0xFD];
        let mut msg = vec![CMD_INPUT];
        msg.extend_from_slice(&binary_data);

        match ClientMessage::from_websocket_frame(&msg).unwrap() {
            ClientMessage::Input(data) => {
                assert_eq!(data, binary_data);
            }
            _ => panic!("Expected Input variant"),
        }
    }
}
