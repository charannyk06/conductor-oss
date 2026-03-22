package backend

import (
	"os/exec"
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
