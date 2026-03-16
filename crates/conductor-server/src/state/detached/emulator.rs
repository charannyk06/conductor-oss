use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TerminalEmulatorState {
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub cwd: Option<PathBuf>,
    pub rows: u16,
    pub cols: u16,
    pub application_cursor_keys: bool,
    pub bracketed_paste: bool,
    pub mouse_tracking: MouseTrackingMode,
    pub unicode_width: UnicodeWidthMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub enum MouseTrackingMode {
    #[default]
    None,
    X10,
    VT200,
    UTF8,
    Sgr,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub enum UnicodeWidthMode {
    #[default]
    Legacy,
    Wcwidth,
}

#[allow(dead_code)]
impl TerminalEmulatorState {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            cwd: None,
            rows,
            cols,
            application_cursor_keys: false,
            bracketed_paste: false,
            mouse_tracking: MouseTrackingMode::None,
            unicode_width: UnicodeWidthMode::Wcwidth,
        }
    }

    pub fn set_size(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        self.cursor_row = self.cursor_row.min(rows.saturating_sub(1));
        self.cursor_col = self.cursor_col.min(cols.saturating_sub(1));
    }

    pub fn set_cursor_position(&mut self, row: u16, col: u16) {
        self.cursor_row = row.min(self.rows.saturating_sub(1));
        self.cursor_col = col.min(self.cols.saturating_sub(1));
    }

    pub fn move_cursor(&mut self, delta_row: i32, delta_col: i32) {
        let new_row = self.cursor_row as i32 + delta_row;
        let new_col = self.cursor_col as i32 + delta_col;
        let max_row = self.rows.saturating_sub(1) as i32;
        let max_col = self.cols.saturating_sub(1) as i32;
        self.cursor_row = new_row.clamp(0, max_row) as u16;
        self.cursor_col = new_col.clamp(0, max_col) as u16;
    }

    pub fn set_cwd(&mut self, cwd: PathBuf) {
        self.cwd = Some(cwd);
    }

    pub fn set_application_cursor_keys(&mut self, enabled: bool) {
        self.application_cursor_keys = enabled;
    }

    pub fn set_bracketed_paste(&mut self, enabled: bool) {
        self.bracketed_paste = enabled;
    }

    pub fn set_mouse_tracking(&mut self, mode: MouseTrackingMode) {
        self.mouse_tracking = mode;
    }

    pub fn set_cursor_visible(&mut self, visible: bool) {
        self.cursor_visible = visible;
    }
}

pub struct TerminalEmulator {
    state: TerminalEmulatorState,
    parse_buffer: VecDeque<u8>,
}

#[allow(dead_code)]
impl TerminalEmulator {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            state: TerminalEmulatorState::new(rows, cols),
            parse_buffer: VecDeque::new(),
        }
    }

    pub fn state(&self) -> &TerminalEmulatorState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut TerminalEmulatorState {
        &mut self.state
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.state.set_size(rows, cols);
    }

    /// Maximum parse buffer size (64 KB).  If the buffer exceeds this after
    /// extending with new data, we drain it to prevent memory exhaustion from
    /// pathological terminal output (e.g. malformed escape sequences).
    const MAX_PARSE_BUFFER: usize = 64 * 1024;

    pub fn process_output(&mut self, data: &[u8]) {
        self.parse_buffer.extend(data.iter().copied());

        // Safety valve: if malformed sequences cause the buffer to grow
        // unboundedly, drain it to prevent OOM.
        if self.parse_buffer.len() > Self::MAX_PARSE_BUFFER {
            self.parse_buffer.clear();
            return;
        }

        while let Some(parse_result) = self.parse_next_sequence() {
            match parse_result {
                Ok(Some(sequence)) => {
                    self.handle_sequence(sequence);
                }
                Ok(None) => break,
                Err(_) => {
                    self.parse_buffer.clear();
                    break;
                }
            }
        }
    }

    fn parse_next_sequence(&mut self) -> Option<Result<Option<TerminalSequence>, ()>> {
        if self.parse_buffer.is_empty() {
            return None;
        }

        let byte = self.parse_buffer[0];

        if byte == 0x1b {
            if self.parse_buffer.len() == 1 {
                return Some(Ok(None));
            }

            match self.parse_buffer[1] {
                b'[' => Some(self.parse_csi_sequence()),
                b']' => Some(self.parse_osc_sequence()),
                b'(' | b')' | b'*' | b'+' => {
                    if self.parse_buffer.len() >= 3 {
                        let _ = self.parse_buffer.drain(0..3);
                        Some(Ok(Some(TerminalSequence::None)))
                    } else {
                        Some(Ok(None))
                    }
                }
                _ => {
                    let drain = self.parse_buffer.len().min(2);
                    let _ = self.parse_buffer.drain(0..drain);
                    Some(Ok(Some(TerminalSequence::None)))
                }
            }
        } else if byte == b'\r' {
            self.parse_buffer.pop_front();
            self.state.set_cursor_position(self.state.cursor_row, 0);
            Some(Ok(Some(TerminalSequence::None)))
        } else if byte == b'\n' {
            self.parse_buffer.pop_front();
            self.state.set_cursor_position(
                self.state.cursor_row.saturating_add(1),
                self.state.cursor_col,
            );
            Some(Ok(Some(TerminalSequence::None)))
        } else if byte < 0x20 {
            self.parse_buffer.pop_front();
            Some(Ok(Some(TerminalSequence::None)))
        } else if byte == 0x7f {
            self.parse_buffer.pop_front();
            self.state.move_cursor(0, -1);
            Some(Ok(Some(TerminalSequence::None)))
        } else if (0x80..=0xBF).contains(&byte) {
            // UTF-8 continuation byte — skip without cursor movement
            self.parse_buffer.pop_front();
            Some(Ok(Some(TerminalSequence::None)))
        } else {
            self.parse_buffer.pop_front();
            self.state.move_cursor(0, 1);
            Some(Ok(Some(TerminalSequence::None)))
        }
    }

    fn parse_csi_sequence(&mut self) -> Result<Option<TerminalSequence>, ()> {
        let command_index = self
            .parse_buffer
            .iter()
            .enumerate()
            .skip(2)
            .find_map(|(index, &byte)| matches!(byte, b'@'..=b'~').then_some(index));
        let Some(command_index) = command_index else {
            return Ok(None);
        };
        let command = self.parse_buffer[command_index];
        let buf = self.parse_buffer.make_contiguous();
        let params_str = String::from_utf8_lossy(&buf[2..command_index]).to_string();
        let _ = self.parse_buffer.drain(0..=command_index);

        let sequence = match command {
            b'A' => TerminalSequence::CsiCUU(params_str.parse().unwrap_or(1_u16)),
            b'B' => TerminalSequence::CsiCUD(params_str.parse().unwrap_or(1_u16)),
            b'C' => TerminalSequence::CsiCUF(params_str.parse().unwrap_or(1_u16)),
            b'D' => TerminalSequence::CsiCUB(params_str.parse().unwrap_or(1_u16)),
            b'H' | b'f' => {
                let parts: Vec<&str> = params_str.split(';').collect();
                let row: u16 = parts
                    .first()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1_u16)
                    .saturating_sub(1_u16);
                let col: u16 = parts
                    .get(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1_u16)
                    .saturating_sub(1_u16);
                TerminalSequence::CsiCUP(row, col)
            }
            b'J' => TerminalSequence::CsiED(params_str.parse().unwrap_or(0_u16)),
            b'K' => TerminalSequence::CsiEL(params_str.parse().unwrap_or(0_u16)),
            b'r' => {
                let parts: Vec<&str> = params_str.split(';').collect();
                let top: u16 = parts
                    .first()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1_u16)
                    .saturating_sub(1_u16);
                let bottom: u16 = parts
                    .get(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(self.state.rows);
                TerminalSequence::CsiSTB(top, bottom)
            }
            b'h' => {
                if params_str.contains("?") {
                    self.parse_dec_private_mode(&params_str, true)
                } else {
                    TerminalSequence::Smux(params_str)
                }
            }
            b'l' => {
                if params_str.contains("?") {
                    self.parse_dec_private_mode(&params_str, false)
                } else {
                    TerminalSequence::Rmx(params_str)
                }
            }
            b'm' => TerminalSequence::Sgr(params_str),
            b'n' => TerminalSequence::Dsr(params_str.parse().unwrap_or(0_u16)),
            _ => TerminalSequence::None,
        };

        Ok(Some(sequence))
    }

    fn parse_dec_private_mode(&mut self, params: &str, enable: bool) -> TerminalSequence {
        let params = params.trim_start_matches('?');

        match params {
            "1" => {
                self.state.set_application_cursor_keys(enable);
                TerminalSequence::None
            }
            "2004" => {
                self.state.set_bracketed_paste(enable);
                TerminalSequence::None
            }
            "1000" | "1002" | "1003" => {
                let mode = match params {
                    "1000" => MouseTrackingMode::X10,
                    "1002" => MouseTrackingMode::VT200,
                    "1003" => MouseTrackingMode::UTF8,
                    _ => MouseTrackingMode::None,
                };
                self.state.set_mouse_tracking(if enable {
                    mode
                } else {
                    MouseTrackingMode::None
                });
                TerminalSequence::None
            }
            _ => TerminalSequence::None,
        }
    }

    fn parse_osc_sequence(&mut self) -> Result<Option<TerminalSequence>, ()> {
        let mut data_end = None;
        let mut sequence_end = None;

        for (index, &byte) in self.parse_buffer.iter().enumerate().skip(2) {
            if byte == 0x07 {
                data_end = Some(index);
                sequence_end = Some(index + 1);
                break;
            }
            if byte == 0x1b && self.parse_buffer.get(index + 1) == Some(&b'\\') {
                data_end = Some(index);
                sequence_end = Some(index + 2);
                break;
            }
        }

        let (Some(data_end), Some(sequence_end)) = (data_end, sequence_end) else {
            return Ok(None);
        };
        let buf = self.parse_buffer.make_contiguous();
        let data = buf[2..data_end].to_vec();
        self.parse_buffer.drain(0..sequence_end);

        if data.is_empty() {
            return Ok(Some(TerminalSequence::None));
        }

        let first_semicolon = data.iter().position(|&b| b == b';');

        match first_semicolon {
            Some(0) => Ok(Some(TerminalSequence::None)),
            Some(idx) => {
                let command = String::from_utf8_lossy(&data[..idx]).to_string();
                let param = String::from_utf8_lossy(&data[idx + 1..]).to_string();

                let sequence = match command.as_str() {
                    "0" | "2" => {
                        if !param.is_empty() {
                            TerminalSequence::OscTitle(param)
                        } else {
                            TerminalSequence::None
                        }
                    }
                    "7" | "9" | "633" | "1337" => {
                        if let Some(cwd) = parse_terminal_osc_cwd(command.as_str(), &param) {
                            self.state.set_cwd(cwd);
                        }
                        TerminalSequence::None
                    }
                    _ => TerminalSequence::None,
                };
                Ok(Some(sequence))
            }
            None => Ok(Some(TerminalSequence::None)),
        }
    }

    fn handle_sequence(&mut self, sequence: TerminalSequence) {
        match sequence {
            TerminalSequence::CsiCUP(row, col) => {
                self.state.set_cursor_position(row, col);
            }
            TerminalSequence::CsiCUU(n) => {
                self.state.move_cursor(-(n as i32), 0);
            }
            TerminalSequence::CsiCUD(n) => {
                self.state.move_cursor(n as i32, 0);
            }
            TerminalSequence::CsiCUF(n) => {
                self.state.move_cursor(0, n as i32);
            }
            TerminalSequence::CsiCUB(n) => {
                self.state.move_cursor(0, -(n as i32));
            }
            TerminalSequence::CsiED(mode) => {
                // ED 0 = erase below cursor, ED 1 = erase above cursor — don't move cursor
                // ED 2 = erase entire display — reset cursor to origin
                // ED 3 = erase scrollback — don't move cursor
                if mode == 2 {
                    self.state.cursor_row = 0;
                    self.state.cursor_col = 0;
                }
            }
            TerminalSequence::CsiEL(_) => {}
            TerminalSequence::CsiSTB(_, _) => {
                // DECSTBM sets scrolling region — don't modify terminal dimensions.
                // Cursor moves to origin per VT100 spec.
                self.state.cursor_row = 0;
                self.state.cursor_col = 0;
            }
            TerminalSequence::Smux(_) | TerminalSequence::Rmx(_) => {}
            TerminalSequence::Sgr(_) => {}
            TerminalSequence::Dsr(_) => {}
            TerminalSequence::OscTitle(_) => {}
            TerminalSequence::None => {}
        }
    }

    pub fn capture_state(&self) -> TerminalEmulatorSnapshot {
        TerminalEmulatorSnapshot {
            cursor_row: self.state.cursor_row,
            cursor_col: self.state.cursor_col,
            cursor_visible: self.state.cursor_visible,
            cwd: self.state.cwd.clone(),
            rows: self.state.rows,
            cols: self.state.cols,
            application_cursor_keys: self.state.application_cursor_keys,
            bracketed_paste: self.state.bracketed_paste,
            mouse_tracking: self.state.mouse_tracking,
            unicode_width: self.state.unicode_width,
        }
    }

    pub fn restore_from_snapshot(&mut self, snapshot: &TerminalEmulatorSnapshot) {
        self.state.cursor_row = snapshot.cursor_row;
        self.state.cursor_col = snapshot.cursor_col;
        self.state.cursor_visible = snapshot.cursor_visible;
        self.state.cwd = snapshot.cwd.clone();
        self.state.rows = snapshot.rows;
        self.state.cols = snapshot.cols;
        self.state.application_cursor_keys = snapshot.application_cursor_keys;
        self.state.bracketed_paste = snapshot.bracketed_paste;
        self.state.mouse_tracking = snapshot.mouse_tracking;
        self.state.unicode_width = snapshot.unicode_width;
    }
}

fn parse_terminal_osc_cwd(command: &str, param: &str) -> Option<PathBuf> {
    let raw_path = match command {
        "7" => {
            let value = param.strip_prefix("file://")?;
            &value[value.find('/')?..]
        }
        "1337" => param.strip_prefix("CurrentDir=")?,
        "633" => param.strip_prefix("P;Cwd=")?,
        "9" => param.strip_prefix("9;")?,
        _ => return None,
    };
    let decoded = decode_terminal_osc_path(raw_path);
    let normalized = decoded.trim().trim_matches('"').trim_matches('\'');
    if normalized.is_empty() {
        None
    } else {
        Some(PathBuf::from(normalized))
    }
}

fn decode_terminal_osc_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum TerminalSequence {
    CsiCUP(u16, u16),
    CsiCUU(u16),
    CsiCUD(u16),
    CsiCUF(u16),
    CsiCUB(u16),
    CsiED(u16),
    CsiEL(u16),
    CsiSTB(u16, u16),
    Smux(String),
    Rmx(String),
    Sgr(String),
    Dsr(u16),
    OscTitle(String),
    None,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalEmulatorSnapshot {
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub cwd: Option<PathBuf>,
    pub rows: u16,
    pub cols: u16,
    pub application_cursor_keys: bool,
    pub bracketed_paste: bool,
    pub mouse_tracking: MouseTrackingMode,
    pub unicode_width: UnicodeWidthMode,
}

impl Default for TerminalEmulatorSnapshot {
    fn default() -> Self {
        Self {
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            cwd: None,
            rows: 24,
            cols: 80,
            application_cursor_keys: false,
            bracketed_paste: false,
            mouse_tracking: MouseTrackingMode::None,
            unicode_width: UnicodeWidthMode::Wcwidth,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emulator_initial_state() {
        let emulator = TerminalEmulator::new(24, 80);
        let state = emulator.state();

        assert_eq!(state.cursor_row, 0);
        assert_eq!(state.cursor_col, 0);
        assert!(state.cursor_visible);
        assert_eq!(state.rows, 24);
        assert_eq!(state.cols, 80);
    }

    #[test]
    fn test_cursor_movement() {
        let mut emulator = TerminalEmulator::new(24, 80);
        emulator.state_mut().set_cursor_position(5, 10);

        let state = emulator.state();
        assert_eq!(state.cursor_row, 5);
        assert_eq!(state.cursor_col, 10);
    }

    #[test]
    fn test_resize() {
        let mut emulator = TerminalEmulator::new(24, 80);
        emulator.resize(40, 120);

        let state = emulator.state();
        assert_eq!(state.rows, 40);
        assert_eq!(state.cols, 120);
    }

    #[test]
    fn test_cwd_tracking() {
        let mut emulator = TerminalEmulator::new(24, 80);
        emulator
            .state_mut()
            .set_cwd(PathBuf::from("/home/user/project"));

        let state = emulator.state();
        assert_eq!(state.cwd, Some(PathBuf::from("/home/user/project")));
    }
}
