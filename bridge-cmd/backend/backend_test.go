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

func TestInferCliPackageManifestSupportsBunGlobalInstallationLayout(t *testing.T) {
	tempDir := t.TempDir()
	workspace := filepath.Join(tempDir, ".bun", "install", "global", "node_modules", "conductor-oss")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("create bun package workspace: %v", err)
	}

	manifestPath := filepath.Join(workspace, "package.json")
	if err := os.WriteFile(manifestPath, []byte(`{"name":"conductor-oss","version":"9.9.9"}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	t.Setenv("HOME", tempDir)
	t.Setenv("BUN_INSTALL", filepath.Join(tempDir, ".bun"))

	conductorPath := filepath.Join(tempDir, ".bun", "bin", "conductor")
	if err := os.MkdirAll(filepath.Dir(conductorPath), 0o755); err != nil {
		t.Fatalf("create bun bin dir: %v", err)
	}
	if err := os.WriteFile(conductorPath, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatalf("write bun shim path: %v", err)
	}

	gotName, gotVersion, gotRoot := inferCliPackageManifest(conductorPath)
	if gotName != "conductor-oss" {
		t.Fatalf("expected package name conductor-oss, got %q", gotName)
	}
	if gotVersion != "9.9.9" {
		t.Fatalf("expected package version 9.9.9, got %q", gotVersion)
	}
	if gotRoot != workspace {
		t.Fatalf("expected package root %q, got %q", workspace, gotRoot)
	}
}

func TestInferCliPackageManifestSupportsStandardGlobalBinLayout(t *testing.T) {
	tempDir := t.TempDir()
	workspace := filepath.Join(tempDir, "usr", "local", "lib", "node_modules", "conductor-oss")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("create package workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte(`{"name":"conductor-oss","version":"4.5.6"}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	conductorPath := filepath.Join(tempDir, "usr", "local", "bin", "conductor")
	if err := os.MkdirAll(filepath.Dir(conductorPath), 0o755); err != nil {
		t.Fatalf("create global bin dir: %v", err)
	}
	if err := os.WriteFile(conductorPath, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatalf("write global script path: %v", err)
	}

	gotName, gotVersion, gotRoot := inferCliPackageManifest(conductorPath)
	if gotName != "conductor-oss" {
		t.Fatalf("expected package name conductor-oss, got %q", gotName)
	}
	if gotVersion != "4.5.6" {
		t.Fatalf("expected package version 4.5.6, got %q", gotVersion)
	}
	expectedRoot, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		expectedRoot = workspace
	}
	if gotRoot != expectedRoot {
		t.Fatalf("expected package root %q, got %q", expectedRoot, gotRoot)
	}
}

func TestInferCliUpdateEnvFallsBackToBunPackageMetadataWhenEnvMissing(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("CONDUCTOR_CLI_PACKAGE_NAME", "")
	t.Setenv("CONDUCTOR_CLI_VERSION", "")
	t.Setenv("CONDUCTOR_CLI_INSTALL_MODE", "")

	workspace := filepath.Join(tempDir, ".bun", "install", "global", "node_modules", "conductor-oss")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("create bun package workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte(`{"name":"conductor-oss","version":"1.2.3"}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	t.Setenv("HOME", tempDir)
	t.Setenv("BUN_INSTALL", filepath.Join(tempDir, ".bun"))

	conductorPath := filepath.Join(tempDir, ".bun", "bin", "conductor")
	if err := os.MkdirAll(filepath.Dir(conductorPath), 0o755); err != nil {
		t.Fatalf("create bun bin dir: %v", err)
	}
	if err := os.WriteFile(conductorPath, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatalf("write bun shim path: %v", err)
	}

	gotEnv := inferCliUpdateEnv(conductorPath)
	got := strings.Join(gotEnv, "\n")
	for _, want := range []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=conductor-oss",
		"CONDUCTOR_CLI_VERSION=1.2.3",
		"CONDUCTOR_CLI_INSTALL_MODE=global-bun",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected launch env to contain %q, got %v", want, gotEnv)
		}
	}
}

func TestInferCliUpdateEnvFallsBackToGlobalBinPackageMetadataWhenEnvMissing(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("CONDUCTOR_CLI_PACKAGE_NAME", "")
	t.Setenv("CONDUCTOR_CLI_VERSION", "")
	t.Setenv("CONDUCTOR_CLI_INSTALL_MODE", "")

	workspace := filepath.Join(tempDir, "usr", "local", "lib", "node_modules", "conductor-oss")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("create package workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "package.json"), []byte(`{"name":"conductor-oss","version":"5.6.7"}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	conductorPath := filepath.Join(tempDir, "usr", "local", "bin", "conductor")
	if err := os.MkdirAll(filepath.Dir(conductorPath), 0o755); err != nil {
		t.Fatalf("create global bin dir: %v", err)
	}
	if err := os.WriteFile(conductorPath, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatalf("write global script path: %v", err)
	}

	gotEnv := inferCliUpdateEnv(conductorPath)
	got := strings.Join(gotEnv, "\n")
	for _, want := range []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=conductor-oss",
		"CONDUCTOR_CLI_VERSION=5.6.7",
		"CONDUCTOR_CLI_INSTALL_MODE=global-npm",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected launch env to contain %q, got %v", want, gotEnv)
		}
	}
}
