package daemon

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateSavedPairingBestEffortContinuesOnNetworkFailure(t *testing.T) {
	var stderr bytes.Buffer
	err := validateSavedPairingBestEffort(
		context.Background(),
		"http://127.0.0.1:1",
		"cached-refresh-token",
		&stderr,
		50*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("expected network validation failure to continue, got %v", err)
	}
	if !strings.Contains(stderr.String(), "continuing with cached pairing") {
		t.Fatalf("expected warning about cached pairing, got %q", stderr.String())
	}
}

func TestValidateSavedPairingBestEffortStopsOnRejectedPairing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
	}))
	defer server.Close()

	var stderr bytes.Buffer
	err := validateSavedPairingBestEffort(
		context.Background(),
		server.URL,
		"cached-refresh-token",
		&stderr,
		500*time.Millisecond,
	)
	if !errors.Is(err, ErrNotPaired) {
		t.Fatalf("expected ErrNotPaired, got %v", err)
	}
	if !strings.Contains(stderr.String(), "invalid or expired") {
		t.Fatalf("expected invalid pairing warning, got %q", stderr.String())
	}
}
