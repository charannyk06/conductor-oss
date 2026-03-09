//! Markdown Kanban board parser and writer.
//!
//! Parses Obsidian Kanban plugin format:
//! ```markdown
//! ## Inbox
//! - [ ] Task title @tag #label
//! - [ ] Another task
//!
//! ## In Progress
//! - [x] Completed task
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::task::TaskState;

/// A parsed Kanban board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    pub columns: Vec<Column>,
    /// Raw settings block at the end (Obsidian Kanban plugin metadata).
    pub settings: Option<String>,
}

/// A column (lane) on the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub state: TaskState,
    pub cards: Vec<Card>,
}

/// A card (task) on the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub title: String,
    pub completed: bool,
    pub tags: Vec<String>,
    pub metadata: HashMap<String, String>,
    /// Raw line content for round-trip fidelity.
    pub raw: String,
}

/// Column name to TaskState mapping.
fn column_to_state(name: &str) -> TaskState {
    match name.to_lowercase().trim() {
        "inbox" | "backlog" => TaskState::Inbox,
        "ready" | "ready to dispatch" | "todo" => TaskState::Ready,
        "dispatching" => TaskState::Dispatching,
        "in progress" | "doing" | "active" => TaskState::InProgress,
        "needs input" | "waiting" | "blocked" => TaskState::NeedsInput,
        "errored" | "error" | "failed" => TaskState::Errored,
        "review" | "in review" | "pr review" => TaskState::Review,
        "merge" | "ready to merge" => TaskState::Merge,
        "done" | "complete" | "completed" => TaskState::Done,
        "cancelled" | "canceled" | "archived" => TaskState::Cancelled,
        _ => TaskState::Inbox,
    }
}

/// State to column name mapping (for writing).
fn state_to_column(state: &TaskState) -> &'static str {
    match state {
        TaskState::Inbox => "Inbox",
        TaskState::Ready => "Ready to Dispatch",
        TaskState::Dispatching => "Dispatching",
        TaskState::InProgress => "In Progress",
        TaskState::NeedsInput => "Needs Input",
        TaskState::Blocked => "Blocked",
        TaskState::Errored => "Errored",
        TaskState::Review => "Review",
        TaskState::Merge => "Merge",
        TaskState::Done => "Done",
        TaskState::Cancelled => "Cancelled",
    }
}

impl Board {
    /// Parse a markdown board from a file.
    pub fn from_file(path: &Path) -> Result<Self, std::io::Error> {
        let content = std::fs::read_to_string(path)?;
        Ok(Self::parse(&content))
    }

    /// Parse a markdown board from a string.
    pub fn parse(content: &str) -> Self {
        let mut columns: Vec<Column> = Vec::new();
        let mut current_column: Option<Column> = None;
        let mut settings: Option<String> = None;
        let mut in_settings = false;
        let mut settings_buf = String::new();

        for line in content.lines() {
            // Detect Obsidian Kanban settings block.
            if line.trim() == "%% kanban:settings" {
                in_settings = true;
                continue;
            }
            if in_settings {
                if line.trim() == "%%" {
                    settings = Some(settings_buf.clone());
                    in_settings = false;
                } else {
                    settings_buf.push_str(line);
                    settings_buf.push('\n');
                }
                continue;
            }

            // Column header (## Column Name).
            if let Some(header) = line.strip_prefix("## ") {
                if let Some(col) = current_column.take() {
                    columns.push(col);
                }
                let name = header.trim().to_string();
                let state = column_to_state(&name);
                current_column = Some(Column {
                    name,
                    state,
                    cards: Vec::new(),
                });
                continue;
            }

            // Card line (- [ ] or - [x]).
            if let Some(ref mut col) = current_column {
                let trimmed = line.trim();
                if trimmed.starts_with("- [ ] ") || trimmed.starts_with("- [x] ") {
                    let completed = trimmed.starts_with("- [x] ");
                    let content = &trimmed[6..];
                    let card = parse_card(content, completed, line);
                    col.cards.push(card);
                } else if let Some(content) = trimmed.strip_prefix("- ") {
                    // Plain list item (no checkbox).
                    let card = parse_card(content, false, line);
                    col.cards.push(card);
                }
            }
        }

        // Push last column.
        if let Some(col) = current_column {
            columns.push(col);
        }

        Board { columns, settings }
    }

    /// Write the board back to markdown format.
    pub fn to_markdown(&self) -> String {
        let mut output = String::new();

        for column in &self.columns {
            output.push_str(&format!("## {}\n\n", column.name));
            for card in &column.cards {
                let checkbox = if card.completed { "[x]" } else { "[ ]" };
                let tags = if card.tags.is_empty() {
                    String::new()
                } else {
                    format!(
                        " {}",
                        card.tags
                            .iter()
                            .map(|t| format!("@{t}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                };
                let meta = if card.metadata.is_empty() {
                    String::new()
                } else {
                    let mut pairs: Vec<_> = card
                        .metadata
                        .iter()
                        .map(|(k, v)| format!("{k}:{v}"))
                        .collect();
                    pairs.sort();
                    format!(" {}", pairs.join(" "))
                };
                output.push_str(&format!("- {} {}{}{}\n", checkbox, card.title, tags, meta));
            }
            output.push('\n');
        }

        // Write back settings block if present.
        if let Some(ref settings) = self.settings {
            output.push_str("%% kanban:settings\n");
            output.push_str(settings);
            output.push_str("%%\n");
        }

        output
    }

    /// Write to a file.
    pub fn write_to_file(&self, path: &Path) -> Result<(), std::io::Error> {
        std::fs::write(path, self.to_markdown())
    }

    /// Get all cards across all columns.
    pub fn all_cards(&self) -> Vec<(&Column, &Card)> {
        self.columns
            .iter()
            .flat_map(|col| col.cards.iter().map(move |card| (col, card)))
            .collect()
    }

    /// Find cards that are in a dispatchable state (Ready column).
    pub fn dispatchable_cards(&self) -> Vec<&Card> {
        self.columns
            .iter()
            .filter(|col| col.state == TaskState::Ready)
            .flat_map(|col| col.cards.iter())
            .collect()
    }

    /// Move a card from one column to another by title.
    pub fn move_card(&mut self, title: &str, to_state: TaskState) {
        // Find and remove the card.
        let mut found_card: Option<Card> = None;
        for col in &mut self.columns {
            if let Some(pos) = col.cards.iter().position(|c| c.title == title) {
                found_card = Some(col.cards.remove(pos));
                break;
            }
        }

        if let Some(mut card) = found_card {
            // Mark completed if moving to Done.
            if to_state == TaskState::Done {
                card.completed = true;
            }

            // Find or create target column.
            let target_name = state_to_column(&to_state);
            if let Some(col) = self.columns.iter_mut().find(|c| c.state == to_state) {
                col.cards.push(card);
            } else {
                // Create new column.
                self.columns.push(Column {
                    name: target_name.to_string(),
                    state: to_state,
                    cards: vec![card],
                });
            }
        }
    }

    /// Add a new card to a specific column.
    pub fn add_card(&mut self, state: TaskState, card: Card) {
        let target_name = state_to_column(&state);
        if let Some(col) = self.columns.iter_mut().find(|c| c.state == state) {
            col.cards.push(card);
        } else {
            self.columns.push(Column {
                name: target_name.to_string(),
                state,
                cards: vec![card],
            });
        }
    }
}

/// Parse a card's content, extracting tags and metadata.
fn parse_card(content: &str, completed: bool, raw: &str) -> Card {
    let mut title = String::new();
    let mut tags = Vec::new();
    let mut metadata = HashMap::new();

    for word in content.split_whitespace() {
        if let Some(tag) = word.strip_prefix('@').or_else(|| word.strip_prefix('#')) {
            tags.push(tag.to_string());
        } else if word.contains(':') && word.len() > 2 {
            let parts: Vec<&str> = word.splitn(2, ':').collect();
            if parts.len() == 2 {
                metadata.insert(parts[0].to_string(), parts[1].to_string());
            } else {
                title.push_str(word);
                title.push(' ');
            }
        } else {
            title.push_str(word);
            title.push(' ');
        }
    }

    Card {
        title: title.trim().to_string(),
        completed,
        tags,
        metadata,
        raw: raw.to_string(),
    }
}

impl Card {
    /// Create a new card with just a title.
    pub fn new(title: &str) -> Self {
        Self {
            title: title.to_string(),
            completed: false,
            tags: Vec::new(),
            metadata: HashMap::new(),
            raw: format!("- [ ] {title}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_board() {
        let content = r#"## Inbox
- [ ] Build login page
- [ ] Fix navbar bug @urgent

## In Progress
- [ ] Implement auth flow

## Done
- [x] Setup project
"#;
        let board = Board::parse(content);
        assert_eq!(board.columns.len(), 3);
        assert_eq!(board.columns[0].name, "Inbox");
        assert_eq!(board.columns[0].cards.len(), 2);
        assert_eq!(board.columns[0].cards[0].title, "Build login page");
        assert_eq!(board.columns[0].cards[1].tags, vec!["urgent"]);
        assert_eq!(board.columns[1].state, TaskState::InProgress);
        assert_eq!(board.columns[2].cards[0].completed, true);
    }

    #[test]
    fn test_parse_obsidian_settings() {
        let content = r#"## Inbox
- [ ] Task 1

%% kanban:settings
{"kanban-plugin":"basic"}
%%
"#;
        let board = Board::parse(content);
        assert_eq!(board.columns.len(), 1);
        assert!(board.settings.is_some());
    }

    #[test]
    fn test_roundtrip() {
        let content = r#"## Inbox

- [ ] Task 1
- [ ] Task 2 @urgent

## Done

- [x] Task 3

"#;
        let board = Board::parse(content);
        let output = board.to_markdown();
        let reparsed = Board::parse(&output);
        assert_eq!(reparsed.columns.len(), 2);
        assert_eq!(reparsed.columns[0].cards.len(), 2);
    }

    #[test]
    fn test_move_card() {
        let content = r#"## Inbox
- [ ] Task A

## In Progress

## Done
"#;
        let mut board = Board::parse(content);
        board.move_card("Task A", TaskState::InProgress);
        assert_eq!(board.columns[0].cards.len(), 0);
        assert_eq!(board.columns[1].cards.len(), 1);
        assert_eq!(board.columns[1].cards[0].title, "Task A");
    }

    #[test]
    fn test_metadata_roundtrip() {
        let content = r#"## Inbox
- [ ] Build feature model:gpt-5 reasoningEffort:high
"#;
        let board = Board::parse(content);
        assert_eq!(board.columns[0].cards[0].title, "Build feature");
        assert_eq!(
            board.columns[0].cards[0].metadata.get("model").map(|s| s.as_str()),
            Some("gpt-5")
        );
        assert_eq!(
            board.columns[0].cards[0].metadata.get("reasoningEffort").map(|s| s.as_str()),
            Some("high")
        );

        let output = board.to_markdown();
        let reparsed = Board::parse(&output);
        assert_eq!(
            reparsed.columns[0].cards[0].metadata.get("model").map(|s| s.as_str()),
            Some("gpt-5")
        );
        assert_eq!(
            reparsed.columns[0].cards[0].metadata.get("reasoningEffort").map(|s| s.as_str()),
            Some("high")
        );
    }

    #[test]
    fn test_dispatchable_cards() {
        let content = r#"## Inbox
- [ ] Not ready

## Ready to Dispatch
- [ ] Ready task 1
- [ ] Ready task 2

## In Progress
- [ ] Working
"#;
        let board = Board::parse(content);
        let ready = board.dispatchable_cards();
        assert_eq!(ready.len(), 2);
    }
}
