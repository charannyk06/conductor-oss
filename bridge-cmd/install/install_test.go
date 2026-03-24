package install

import (
	"errors"
	"strings"
	"testing"
)

func TestBuildRestartCommandDarwin(t *testing.T) {
	cmd, err := buildRestartCommand("darwin", "/Users/test user")
	if err != nil {
		t.Fatalf("buildRestartCommand returned error: %v", err)
	}

	if cmd.name != "sh" {
		t.Fatalf("cmd.name = %q, want %q", cmd.name, "sh")
	}
	if len(cmd.args) != 2 {
		t.Fatalf("len(cmd.args) = %d, want 2", len(cmd.args))
	}

	script := cmd.args[1]
	for _, want := range []string{
		"launchctl bootout",
		"launchctl bootstrap",
		"launchctl kickstart -k",
		"com.conductor.bridge.plist",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("darwin restart script %q does not contain %q", script, want)
		}
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

	if cmd.name != "cmd" {
		t.Fatalf("cmd.name = %q, want %q", cmd.name, "cmd")
	}
	if len(cmd.args) != 2 {
		t.Fatalf("len(cmd.args) = %d, want 2", len(cmd.args))
	}

	script := cmd.args[1]
	for _, want := range []string{
		"taskkill /F /IM conductor-bridge.exe /T",
		"taskkill /F /IM conductor-bridge /T",
		"timeout /t 1 /nobreak",
		"start \"\" /B",
		"daemon",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("windows restart script %q does not contain %q", script, want)
		}
	}
}
