//! Workspace preset management for automated environment setup
//!
//! Similar to Superset's `.superset/config.json` but integrated into
//! Conductor's YAML configuration system.

use anyhow::{anyhow, Result};
use glob::Pattern;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Workspace preset for automated setup/teardown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspacePreset {
    /// Unique identifier for the preset
    pub id: String,

    /// Human-readable name
    pub name: String,

    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// File pattern to auto-detect this preset (e.g., "package.json", "*.py")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detect_pattern: Option<String>,

    /// Commands to run when creating a workspace
    #[serde(default)]
    pub setup: Vec<SetupCommand>,

    /// Commands to run when deleting a workspace
    #[serde(default)]
    pub teardown: Vec<String>,

    /// Environment variables to set
    #[serde(default)]
    pub env: HashMap<String, String>,

    /// Shell to use (defaults to system shell)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,

    /// Timeout for setup commands in seconds (default: 300)
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    300
}

/// A setup command with optional condition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupCommand {
    /// Command to execute
    pub command: String,

    /// Optional description shown in UI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Optional condition - only run if this file exists
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_exists: Option<String>,

    /// Optional condition - only run if this file does NOT exist
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unless_exists: Option<String>,

    /// Whether to continue on failure (default: false)
    #[serde(default)]
    pub continue_on_error: bool,

    /// Timeout override for this specific command
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

impl WorkspacePreset {
    /// Create a new preset
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: None,
            detect_pattern: None,
            setup: Vec::new(),
            teardown: Vec::new(),
            env: HashMap::new(),
            shell: None,
            timeout_seconds: default_timeout(),
        }
    }

    /// Check if this preset matches a given project directory
    pub fn matches(&self, project_path: &Path) -> bool {
        let Some(pattern_str) = &self.detect_pattern else {
            return false;
        };

        let pattern = match Pattern::new(pattern_str) {
            Ok(p) => p,
            Err(_) => return false,
        };

        // Check if any file in the project root matches the pattern
        if let Ok(entries) = std::fs::read_dir(project_path) {
            for entry in entries.flatten() {
                if let Some(filename) = entry.file_name().to_str() {
                    if pattern.matches(filename) {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Get built-in presets for common project types
    pub fn built_in_presets() -> Vec<Self> {
        vec![
            Self::nodejs_preset(),
            Self::python_preset(),
            Self::rust_preset(),
            Self::go_preset(),
            Self::ruby_preset(),
        ]
    }

    /// Node.js/JavaScript preset
    fn nodejs_preset() -> Self {
        Self {
            id: "nodejs".to_string(),
            name: "Node.js Project".to_string(),
            description: Some("Setup for Node.js projects with npm/yarn/pnpm".to_string()),
            detect_pattern: Some("package.json".to_string()),
            setup: vec![
                SetupCommand {
                    command: "npm install".to_string(),
                    description: Some("Installing dependencies".to_string()),
                    if_exists: Some("package.json".to_string()),
                    unless_exists: None,
                    continue_on_error: false,
                    timeout_seconds: None,
                },
                SetupCommand {
                    command: "cp .env.example .env 2>/dev/null || true".to_string(),
                    description: Some("Copying environment file".to_string()),
                    if_exists: Some(".env.example".to_string()),
                    unless_exists: Some(".env".to_string()),
                    continue_on_error: true,
                    timeout_seconds: None,
                },
            ],
            teardown: vec!["rm -rf node_modules".to_string()],
            env: {
                let mut env = HashMap::new();
                env.insert("NODE_ENV".to_string(), "development".to_string());
                env
            },
            shell: None,
            timeout_seconds: 300,
        }
    }

    /// Python preset
    fn python_preset() -> Self {
        Self {
            id: "python".to_string(),
            name: "Python Project".to_string(),
            description: Some("Setup for Python projects with venv".to_string()),
            detect_pattern: Some("requirements.txt".to_string()),
            setup: vec![
                SetupCommand {
                    command: "python3 -m venv .venv".to_string(),
                    description: Some("Creating virtual environment".to_string()),
                    if_exists: None,
                    unless_exists: Some(".venv".to_string()),
                    continue_on_error: false,
                    timeout_seconds: Some(60),
                },
                SetupCommand {
                    command: ".venv/bin/pip install -r requirements.txt".to_string(),
                    description: Some("Installing dependencies".to_string()),
                    if_exists: Some("requirements.txt".to_string()),
                    unless_exists: None,
                    continue_on_error: false,
                    timeout_seconds: Some(300),
                },
            ],
            teardown: vec!["rm -rf .venv".to_string()],
            env: {
                let mut env = HashMap::new();
                env.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
                env
            },
            shell: None,
            timeout_seconds: 300,
        }
    }

    /// Rust preset
    fn rust_preset() -> Self {
        Self {
            id: "rust".to_string(),
            name: "Rust Project".to_string(),
            description: Some("Setup for Rust projects with Cargo".to_string()),
            detect_pattern: Some("Cargo.toml".to_string()),
            setup: vec![SetupCommand {
                command: "cargo fetch".to_string(),
                description: Some("Fetching dependencies".to_string()),
                if_exists: Some("Cargo.toml".to_string()),
                unless_exists: None,
                continue_on_error: false,
                timeout_seconds: Some(300),
            }],
            teardown: vec!["cargo clean".to_string()],
            env: HashMap::new(),
            shell: None,
            timeout_seconds: 300,
        }
    }

    /// Go preset
    fn go_preset() -> Self {
        Self {
            id: "go".to_string(),
            name: "Go Project".to_string(),
            description: Some("Setup for Go projects".to_string()),
            detect_pattern: Some("go.mod".to_string()),
            setup: vec![SetupCommand {
                command: "go mod download".to_string(),
                description: Some("Downloading modules".to_string()),
                if_exists: Some("go.mod".to_string()),
                unless_exists: None,
                continue_on_error: false,
                timeout_seconds: Some(300),
            }],
            teardown: vec![],
            env: HashMap::new(),
            shell: None,
            timeout_seconds: 300,
        }
    }

    /// Ruby preset
    fn ruby_preset() -> Self {
        Self {
            id: "ruby".to_string(),
            name: "Ruby Project".to_string(),
            description: Some("Setup for Ruby projects with Bundler".to_string()),
            detect_pattern: Some("Gemfile".to_string()),
            setup: vec![SetupCommand {
                command: "bundle install".to_string(),
                description: Some("Installing gems".to_string()),
                if_exists: Some("Gemfile".to_string()),
                unless_exists: None,
                continue_on_error: false,
                timeout_seconds: Some(300),
            }],
            teardown: vec![],
            env: HashMap::new(),
            shell: None,
            timeout_seconds: 300,
        }
    }
}

/// Registry of workspace presets
pub struct PresetRegistry {
    presets: Vec<WorkspacePreset>,
}

impl PresetRegistry {
    /// Create a new registry with built-in presets
    pub fn with_built_ins() -> Self {
        Self {
            presets: WorkspacePreset::built_in_presets(),
        }
    }

    /// Add a custom preset
    pub fn add_preset(&mut self, preset: WorkspacePreset) {
        self.presets.push(preset);
    }

    /// Detect the best preset for a project
    pub fn detect_for_project(&self, project_path: &Path) -> Option<&WorkspacePreset> {
        self.presets.iter().find(|p| p.matches(project_path))
    }

    /// Get a preset by ID
    pub fn get(&self, id: &str) -> Option<&WorkspacePreset> {
        self.presets.iter().find(|p| p.id == id)
    }

    /// List all presets
    pub fn list(&self) -> &[WorkspacePreset] {
        &self.presets
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_preset_detection() {
        let preset = WorkspacePreset::nodejs_preset();
        let temp = TempDir::new().unwrap();

        // Should not match empty directory
        assert!(!preset.matches(temp.path()));

        // Create package.json
        std::fs::write(temp.path().join("package.json"), "{}").unwrap();

        // Should now match
        assert!(preset.matches(temp.path()));
    }

    #[test]
    fn test_registry_detection() {
        let registry = PresetRegistry::with_built_ins();
        let temp = TempDir::new().unwrap();

        // Create Cargo.toml
        std::fs::write(temp.path().join("Cargo.toml"), "[package]").unwrap();

        let detected = registry.detect_for_project(temp.path());
        assert!(detected.is_some());
        assert_eq!(detected.unwrap().id, "rust");
    }

    #[test]
    fn test_built_in_presets() {
        let presets = WorkspacePreset::built_in_presets();
        assert_eq!(presets.len(), 5);

        let ids: Vec<_> = presets.iter().map(|p| p.id.clone()).collect();
        assert!(ids.contains(&"nodejs".to_string()));
        assert!(ids.contains(&"python".to_string()));
        assert!(ids.contains(&"rust".to_string()));
        assert!(ids.contains(&"go".to_string()));
        assert!(ids.contains(&"ruby".to_string()));
    }
}
