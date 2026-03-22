package token

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPathForDashboardNormalizesURLVariants(t *testing.T) {
	t.Parallel()

	store, err := NewStore(filepath.Join(t.TempDir(), "bridge-refresh-token"))
	if err != nil {
		t.Fatalf("NewStore returned error: %v", err)
	}

	firstPath, err := store.PathForDashboard("https://Preview.Conductross.com/")
	if err != nil {
		t.Fatalf("PathForDashboard returned error: %v", err)
	}

	secondPath, err := store.PathForDashboard("https://preview.conductross.com?foo=bar#fragment")
	if err != nil {
		t.Fatalf("PathForDashboard returned error: %v", err)
	}

	if firstPath != secondPath {
		t.Fatalf("PathForDashboard produced different cache paths: %q vs %q", firstPath, secondPath)
	}

	if !strings.HasPrefix(firstPath, store.CacheDir()+string(filepath.Separator)) {
		t.Fatalf("PathForDashboard path = %q, want prefix %q", firstPath, store.CacheDir())
	}

	base := filepath.Base(firstPath)
	if strings.Contains(base, "://") {
		t.Fatalf("dashboard cache filename should be filesystem-safe, got %q", base)
	}
}

func TestSaveAndLoadForDashboard(t *testing.T) {
	t.Parallel()

	store, err := NewStore(filepath.Join(t.TempDir(), "bridge-refresh-token"))
	if err != nil {
		t.Fatalf("NewStore returned error: %v", err)
	}

	if err := store.SaveForDashboard("https://preview.conductross.com/", "refresh-preview"); err != nil {
		t.Fatalf("SaveForDashboard returned error: %v", err)
	}

	got, err := store.LoadForDashboard("https://preview.conductross.com")
	if err != nil {
		t.Fatalf("LoadForDashboard returned error: %v", err)
	}

	if got != "refresh-preview" {
		t.Fatalf("LoadForDashboard = %q, want %q", got, "refresh-preview")
	}
}
