use std::collections::HashSet;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const ST: u8 = 0x9c;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Allow,
    Block,
    Sanitize,
}

#[derive(Debug, Clone)]
pub struct TerminalEscapeFilter {
    allowed_osc_commands: HashSet<u32>,
    blocked_osc_commands: HashSet<u32>,
    allow_title_changes: bool,
    allow_icon_changes: bool,
    #[allow(dead_code)]
    allow_hyperlinks: bool,
    mode: FilterMode,
}

impl TerminalEscapeFilter {
    pub fn new() -> Self {
        Self::strict()
    }

    pub fn permissive() -> Self {
        Self {
            allowed_osc_commands: [0, 1, 2, 7, 50, 133, 1337].into_iter().collect(),
            allow_title_changes: true,
            allow_icon_changes: true,
            allow_hyperlinks: true,
            mode: FilterMode::Allow,
            ..Self::default()
        }
    }

    pub fn strict() -> Self {
        Self {
            allowed_osc_commands: HashSet::new(),
            blocked_osc_commands: HashSet::new(),
            allow_title_changes: false,
            allow_icon_changes: false,
            allow_hyperlinks: false,
            mode: FilterMode::Block,
        }
    }

    pub fn sanitize() -> Self {
        Self {
            allowed_osc_commands: HashSet::new(),
            blocked_osc_commands: HashSet::new(),
            allow_title_changes: false,
            allow_icon_changes: false,
            allow_hyperlinks: true,
            mode: FilterMode::Sanitize,
        }
    }

    pub fn allow_osc_command(&mut self, command: u32) {
        self.allowed_osc_commands.insert(command);
    }

    pub fn block_osc_command(&mut self, command: u32) {
        self.blocked_osc_commands.insert(command);
    }

    pub fn filter(&self, data: &[u8]) -> Vec<u8> {
        match self.mode {
            FilterMode::Allow => data.to_vec(),
            FilterMode::Block => self.filter_block(data),
            FilterMode::Sanitize => self.filter_sanitize(data),
        }
    }

    fn filter_block(&self, data: &[u8]) -> Vec<u8> {
        let mut result = Vec::with_capacity(data.len());
        let mut i = 0;

        while i < data.len() {
            if data[i] == ESC && i + 1 < data.len() {
                let remaining = &data[i + 1..];

                if remaining.starts_with(b"[") {
                    if let Some(end) = Self::find_csi_end(remaining) {
                        let abs_end = i + 1 + end;
                        if Self::is_csi_allowed(remaining, end) {
                            result.extend_from_slice(&data[i..=abs_end]);
                        }
                        i = abs_end + 1;
                        continue;
                    }
                    // Incomplete CSI sequence — skip the ESC byte in Block
                    // mode so it is not passed through unfiltered.
                    i += 1;
                    continue;
                }

                if remaining.starts_with(b"]") {
                    if let Some(end) = Self::find_osc_end(remaining) {
                        let abs_end = i + 1 + end;
                        if self.is_osc_allowed(remaining) {
                            result.extend_from_slice(&data[i..=abs_end]);
                        }
                        i = abs_end + 1;
                        continue;
                    }
                    // Incomplete OSC sequence — skip the ESC byte in Block mode.
                    i += 1;
                    continue;
                }

                if (remaining.starts_with(b"(")
                    || remaining.starts_with(b")")
                    || remaining.starts_with(b"*")
                    || remaining.starts_with(b"+"))
                    && remaining.len() >= 3
                {
                    result.extend_from_slice(&data[i..i + 3]);
                    i += 3;
                    continue;
                }
            }

            result.push(data[i]);
            i += 1;
        }

        result
    }

    fn filter_sanitize(&self, data: &[u8]) -> Vec<u8> {
        let blocked = self.filter_block(data);
        let mut result = Vec::with_capacity(blocked.len());

        for chunk in blocked.split(|&b| b == BEL) {
            result.extend_from_slice(chunk);
            result.push(BEL);
        }

        if !result.is_empty() && result.last() == Some(&BEL) {
            result.pop();
        }

        result
    }

    fn find_csi_end(data: &[u8]) -> Option<usize> {
        for (i, &byte) in data.iter().enumerate().skip(1) {
            if (b'@'..=b'~').contains(&byte) {
                return Some(i);
            }
        }
        None
    }

    fn find_osc_end(data: &[u8]) -> Option<usize> {
        for (i, &byte) in data.iter().enumerate().skip(1) {
            if byte == BEL {
                return Some(i);
            }

            if byte == ST {
                return Some(i);
            }

            if byte == ESC && data.get(i + 1) == Some(&b'\\') {
                return Some(i + 1);
            }
        }

        None
    }

    fn is_csi_allowed(data: &[u8], end: usize) -> bool {
        if end < 2 {
            return false;
        }

        let params = &data[1..end];

        if params.starts_with(b"?") || params.starts_with(b">") || params.starts_with(b"!") {
            let private_params = &params[1..];
            if private_params.starts_with(b"1049")
                || private_params.starts_with(b"2004")
                || private_params.starts_with(b"1000")
                || private_params.starts_with(b"1002")
                || private_params.starts_with(b"1003")
                || private_params.starts_with(b"1006")
                || private_params.starts_with(b"1015")
            {
                return true;
            }
            return false;
        }

        true
    }

    fn is_osc_allowed(&self, data: &[u8]) -> bool {
        let end = data.len().min(256);
        let slice = &data[1..end];

        let Some(semicolon_pos) = slice.iter().position(|&b| b == b';') else {
            return true;
        };

        let command_str = String::from_utf8_lossy(&slice[..semicolon_pos]);
        let command: u32 = command_str.parse().unwrap_or(0);

        if !self.blocked_osc_commands.is_empty() && self.blocked_osc_commands.contains(&command) {
            return false;
        }

        if !self.allowed_osc_commands.is_empty() && !self.allowed_osc_commands.contains(&command) {
            return false;
        }

        match command {
            0..=2 => self.allow_title_changes,
            4 => true,
            7 => true,
            50 => self.allow_icon_changes,
            133 | 1337 => true,
            _ => matches!(self.mode, FilterMode::Allow),
        }
    }

    pub fn is_osc_link(command: u32, params: &str) -> bool {
        command == 8 && params.contains("file://")
    }
}

impl Default for TerminalEscapeFilter {
    fn default() -> Self {
        Self::strict()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_strips_title_changes() {
        let filter = TerminalEscapeFilter::strict();

        let input = b"\x1b]0;Malicious Title\x07test";
        let output = filter.filter(input);

        assert!(!output
            .windows(b"Malicious".len())
            .any(|window| window == b"Malicious"));
    }

    #[test]
    fn test_permissive_allows_safe_sequences() {
        let filter = TerminalEscapeFilter::permissive();

        let input = b"\x1b[31mmuted red\x1b[0m";
        let output = filter.filter(input);

        assert_eq!(output, input);
    }

    #[test]
    fn test_osc_link_detection() {
        assert!(TerminalEscapeFilter::is_osc_link(8, ";file:///etc/passwd"));
        assert!(TerminalEscapeFilter::is_osc_link(
            8,
            ";;file:///tmp/script.sh"
        ));
        assert!(!TerminalEscapeFilter::is_osc_link(0, ";Title"));
    }
}
