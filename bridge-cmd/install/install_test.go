package install

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestBridgeBinaryName(t *testing.T) {
	if got := bridgeBinaryName("windows"); got != "conductor-bridge.exe" {
		t.Fatalf("bridgeBinaryName(windows) = %q, want %q", got, "conductor-bridge.exe")
	}
	if got := bridgeBinaryName("darwin"); got != "conductor-bridge" {
		t.Fatalf("bridgeBinaryName(darwin) = %q, want %q", got, "conductor-bridge")
	}
}

func TestBuildRestartCommandDarwin(t *testing.T) {
	cmd, err := buildRestartCommand("darwin", "/Users/test user")
	if err != nil {
		t.Fatalf("buildRestartCommand returned error: %v", err)
	}

	if cmd.name != "launchctl" {
		t.Fatalf("cmd.name = %q, want %q", cmd.name, "launchctl")
	}
	if got := strings.Join(cmd.args, " "); !strings.Contains(got, "kickstart -k gui/") || !strings.Contains(got, "/com.conductor.bridge") {
		t.Fatalf("darwin restart args = %q, want kickstart for the bridge service", got)
	}
	if strings.Contains(strings.Join(cmd.args, " "), "bootout") || strings.Contains(strings.Join(cmd.args, " "), "bootstrap") {
		t.Fatalf("darwin restart args should not bootout/bootstrap the current launchd job: %q", strings.Join(cmd.args, " "))
	}
}

func TestBuildRestartCommandLinuxUsesSystemdRunWhenAvailable(t *testing.T) {
	originalLookPath := lookPath
	lookPath = func(name string) (string, error) {
		if name == "systemd-run" {
			return "/usr/bin/systemd-run", nil
		}
		return "", errors.New("not found")
	}
	t.Cleanup(func() {
		lookPath = originalLookPath
	})

	cmd, err := buildRestartCommand("linux", "/home/test")
	if err != nil {
		t.Fatalf("buildRestartCommand returned error: %v", err)
	}

	if cmd.name != "systemd-run" {
		t.Fatalf("cmd.name = %q, want %q", cmd.name, "systemd-run")
	}

	got := strings.Join(cmd.args, " ")
	for _, want := range []string{
		"--user",
		"--collect",
		"--quiet",
		"--unit com.conductor.bridge-restart",
		"sh -c",
		"systemctl --user restart com.conductor.bridge",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("linux restart args %q do not contain %q", got, want)
		}
	}
}

func TestBuildRestartCommandLinuxFallsBackToSystemctl(t *testing.T) {
	originalLookPath := lookPath
	lookPath = func(name string) (string, error) {
		return "", errors.New("not found")
	}
	t.Cleanup(func() {
		lookPath = originalLookPath
	})

	cmd, err := buildRestartCommand("linux", "/home/test")
	if err != nil {
		t.Fatalf("buildRestartCommand returned error: %v", err)
	}

	if cmd.name != "systemctl" {
		t.Fatalf("cmd.name = %q, want %q", cmd.name, "systemctl")
	}
	if got := strings.Join(cmd.args, " "); got != "--user restart com.conductor.bridge.service" {
		t.Fatalf("cmd.args = %q, want %q", got, "--user restart com.conductor.bridge.service")
	}
}

func TestBuildRestartCommandWindows(t *testing.T) {
	cmd, err := buildRestartCommand("windows", `C:\Users\Test`)
	if err != nil {
		t.Fatalf("buildRestartCommand returned error: %v", err)
	}

	wantBase := filepath.Join(`C:\Users\Test`, ".conductor", "bin", "conductor-bridge")
	if !strings.HasSuffix(cmd.name, wantBase) && !strings.HasSuffix(cmd.name, wantBase+".exe") {
		t.Fatalf("cmd.name = %q, want conductor bridge binary path", cmd.name)
	}
	if got := strings.Join(cmd.args, " "); got != "daemon" {
		t.Fatalf("cmd.args = %q, want %q", got, "daemon")
	}
}
