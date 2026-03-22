package main

import (
	"testing"

	"github.com/charannyk06/conductor-oss/bridge/dashboardurl"
)

func TestResolveDashboardURLUsesSavedDashboardTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CONDUCTOR_DASHBOARD_URL", "")
	t.Setenv("CONDUCTOR_PUBLIC_DASHBOARD_URL", "")

	store, err := dashboardurl.NewStore("")
	if err != nil {
		t.Fatalf("dashboardurl.NewStore returned error: %v", err)
	}

	if err := store.Save("https://preview.conductross.com"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	if got := resolveDashboardURL(); got != "https://preview.conductross.com" {
		t.Fatalf("resolveDashboardURL = %q, want %q", got, "https://preview.conductross.com")
	}
}
