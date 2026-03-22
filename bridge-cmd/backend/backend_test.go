package backend

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyLaunchEnvAddsUpdateMetadata(t *testing.T) {
	cmd := exec.Command("sh", "-c", "true")

	applyLaunchEnv(cmd, []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=conductor-oss",
		"CONDUCTOR_CLI_VERSION=0.2.8",
		"CONDUCTOR_CLI_INSTALL_MODE=global-npm",
	})

	if len(cmd.Env) == 0 {
		t.Fatal("expected launch env to be attached to the command")
	}

	got := strings.Join(cmd.Env, "\n")
	for _, want := range []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=conductor-oss",
		"CONDUCTOR_CLI_VERSION=0.2.8",
		"CONDUCTOR_CLI_INSTALL_MODE=global-npm",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected command env to contain %q, got %v", want, cmd.Env)
		}
	}
}

func TestResolveLaunchPlanCarriesCliUpdateMetadataForNodeScriptBinaries(t *testing.T) {
	tempDir := t.TempDir()
	binDir := filepath.Join(tempDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("create bin dir: %v", err)
	}

	conductorPath := filepath.Join(binDir, "conductor")
	if err := os.WriteFile(conductorPath, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatalf("write conductor script: %v", err)
	}

	manifestPath := filepath.Join(tempDir, "package.json")
	if err := os.WriteFile(manifestPath, []byte(`{"name":"conductor-oss","version":"1.2.3"}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	t.Setenv("HOME", tempDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	backendURL, err := url.Parse("http://127.0.0.1:4749")
	if err != nil {
		t.Fatalf("parse backend url: %v", err)
	}

	launch, err := resolveLaunchPlan("", backendURL)
	if err != nil {
		t.Fatalf("resolve launch plan: %v", err)
	}

	gotEnv := strings.Join(launch.env, "\n")
	for _, want := range []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=conductor-oss",
		"CONDUCTOR_CLI_VERSION=1.2.3",
		"CONDUCTOR_CLI_INSTALL_MODE=",
	} {
		if !strings.Contains(gotEnv, want) {
			t.Fatalf("expected launch env to contain %q, got %v", want, launch.env)
		}
	}
}
