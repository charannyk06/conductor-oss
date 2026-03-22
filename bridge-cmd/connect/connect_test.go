package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/charannyk06/conductor-oss/bridge/dashboardurl"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

func TestBuildClaimURL(t *testing.T) {
	t.Parallel()

	got, err := buildClaimURL("https://preview.conductross.com?foo=bar", "claim_123")
	if err != nil {
		t.Fatalf("buildClaimURL returned error: %v", err)
	}

	want := "https://preview.conductross.com/bridge/connect?claim=claim_123"
	if got != want {
		t.Fatalf("buildClaimURL = %q, want %q", got, want)
	}
}

func TestBuildReconnectURLIncludesRequestedDevice(t *testing.T) {
	t.Parallel()

	got, err := buildReconnectURL("https://preview.conductross.com", "device_123")
	if err != nil {
		t.Fatalf("buildReconnectURL returned error: %v", err)
	}

	want := "https://preview.conductross.com/bridge/connect?device=device_123"
	if got != want {
		t.Fatalf("buildReconnectURL = %q, want %q", got, want)
	}
}

func TestBuildReconnectURLWithoutDeviceFallsBackToBridgeConnect(t *testing.T) {
	t.Parallel()

	got, err := buildReconnectURL("https://preview.conductross.com", "")
	if err != nil {
		t.Fatalf("buildReconnectURL returned error: %v", err)
	}

	want := "https://preview.conductross.com/bridge/connect"
	if got != want {
		t.Fatalf("buildReconnectURL = %q, want %q", got, want)
	}
}

func TestRunReusesActivePairingAcrossDashboardTargetsAndPersistsRequestedDashboard(t *testing.T) {
	tokenStore, dashboardStore := newBridgeTestStores(t)

	if err := tokenStore.Save("refresh-active"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if err := dashboardStore.Save("https://conductross.com"); err != nil {
		t.Fatalf("dashboard Save returned error: %v", err)
	}

	withDefaultHTTPClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/devices/auth" {
			t.Fatalf("unexpected relay path %q", r.URL.Path)
		}

		if got := r.Header.Get("Authorization"); got != "Bearer refresh-active" {
			t.Fatalf("Authorization = %q, want %q", got, "Bearer refresh-active")
		}

		return jsonHTTPResponse(http.StatusOK, map[string]string{
			"device_id":   "device-123",
			"device_name": "Preview Mac",
		}), nil
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := Run(context.Background(), Options{
		RelayURL:      "https://relay.example.com",
		DashboardURL:  "https://preview.conductross.com",
		Store:         tokenStore,
		Stdout:        &stdout,
		Stderr:        &stderr,
		OpenBrowser:   false,
		StartupDaemon: false,
	}); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	if got, err := dashboardStore.Load(); err != nil {
		t.Fatalf("dashboard Load returned error: %v", err)
	} else if got != "https://preview.conductross.com" {
		t.Fatalf("dashboard Load = %q, want %q", got, "https://preview.conductross.com")
	}

	if got, err := tokenStore.LoadForDashboard("https://preview.conductross.com"); err != nil {
		t.Fatalf("LoadForDashboard returned error: %v", err)
	} else if got != "refresh-active" {
		t.Fatalf("LoadForDashboard = %q, want %q", got, "refresh-active")
	}

	assertStringContains(t, stdout.String(), "Target dashboard: https://preview.conductross.com")
	assertStringContains(t, stdout.String(), "Switching saved dashboard target from https://conductross.com to https://preview.conductross.com")
	assertStringContains(t, stdout.String(), "Reusing the current active bridge pairing for this device.")
	assertStringContains(t, stdout.String(), "No refresh token rotation is needed for this dashboard switch.")
	assertStringContains(t, stdout.String(), "Open this URL to finish pairing: https://preview.conductross.com/bridge/connect?device=device-123")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunReusesSavedDashboardCacheWhenActivePairingIsInvalid(t *testing.T) {
	tokenStore, dashboardStore := newBridgeTestStores(t)

	if err := tokenStore.Save("refresh-old"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if err := tokenStore.SaveForDashboard("https://preview.conductross.com", "refresh-preview"); err != nil {
		t.Fatalf("SaveForDashboard returned error: %v", err)
	}
	if err := dashboardStore.Save("https://conductross.com"); err != nil {
		t.Fatalf("dashboard Save returned error: %v", err)
	}

	withDefaultHTTPClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/devices/auth" {
			t.Fatalf("unexpected relay path %q", r.URL.Path)
		}

		switch r.Header.Get("Authorization") {
		case "Bearer refresh-old":
			return jsonHTTPResponse(http.StatusUnauthorized, map[string]string{"error": "expired"}), nil
		case "Bearer refresh-preview":
			return jsonHTTPResponse(http.StatusOK, map[string]string{
				"device_id":   "device-preview",
				"device_name": "Preview Mac",
			}), nil
		default:
			t.Fatalf("unexpected Authorization header %q", r.Header.Get("Authorization"))
			return nil, nil
		}
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := Run(context.Background(), Options{
		RelayURL:      "https://relay.example.com",
		DashboardURL:  "https://preview.conductross.com",
		Store:         tokenStore,
		Stdout:        &stdout,
		Stderr:        &stderr,
		OpenBrowser:   false,
		StartupDaemon: false,
	}); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	if got, err := tokenStore.Load(); err != nil {
		t.Fatalf("Load returned error: %v", err)
	} else if got != "refresh-preview" {
		t.Fatalf("Load = %q, want %q", got, "refresh-preview")
	}

	if got, err := dashboardStore.Load(); err != nil {
		t.Fatalf("dashboard Load returned error: %v", err)
	} else if got != "https://preview.conductross.com" {
		t.Fatalf("dashboard Load = %q, want %q", got, "https://preview.conductross.com")
	}

	assertStringContains(t, stdout.String(), "Reusing the saved pairing cached for https://preview.conductross.com.")
	assertStringContains(t, stdout.String(), "That pairing is now the active bridge token for the daemon.")
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunCreatesNewPairingWhenSavedPairingsAreInvalidAndWarnsAboutRotation(t *testing.T) {
	tokenStore, dashboardStore := newBridgeTestStores(t)

	if err := tokenStore.Save("refresh-old"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if err := tokenStore.SaveForDashboard("https://preview.conductross.com", "refresh-stale"); err != nil {
		t.Fatalf("SaveForDashboard returned error: %v", err)
	}
	if err := dashboardStore.Save("https://conductross.com"); err != nil {
		t.Fatalf("dashboard Save returned error: %v", err)
	}

	withDefaultHTTPClient(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/devices/auth":
			return jsonHTTPResponse(http.StatusUnauthorized, map[string]string{"error": "expired"}), nil
		case "/api/devices/claims":
			return jsonHTTPResponse(http.StatusOK, map[string]any{
				"claim_token": "claim-123",
				"poll_token":  "poll-123",
				"expires_in":  300,
			}), nil
		case "/api/devices/claims/poll/poll-123":
			return jsonHTTPResponse(http.StatusOK, map[string]any{
				"status":        "paired",
				"refresh_token": "refresh-new",
				"device_id":     "device-456",
				"device_name":   "Preview Mac",
			}), nil
		default:
			t.Fatalf("unexpected relay path %q", r.URL.Path)
			return nil, nil
		}
	})

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := Run(context.Background(), Options{
		RelayURL:      "https://relay.example.com",
		DashboardURL:  "https://preview.conductross.com",
		Store:         tokenStore,
		Stdout:        &stdout,
		Stderr:        &stderr,
		OpenBrowser:   false,
		StartupDaemon: false,
	}); err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	if got, err := tokenStore.Load(); err != nil {
		t.Fatalf("Load returned error: %v", err)
	} else if got != "refresh-new" {
		t.Fatalf("Load = %q, want %q", got, "refresh-new")
	}

	if got, err := tokenStore.LoadForDashboard("https://preview.conductross.com"); err != nil {
		t.Fatalf("LoadForDashboard returned error: %v", err)
	} else if got != "refresh-new" {
		t.Fatalf("LoadForDashboard = %q, want %q", got, "refresh-new")
	}

	assertStringContains(t, stdout.String(), "Creating a new pairing for https://preview.conductross.com. The relay will rotate the previous refresh token for this device.")
	assertStringContains(t, stdout.String(), `Device paired: "Preview Mac"`)
	assertStringContains(t, stderr.String(), "Saved pairing cached for https://preview.conductross.com is invalid or expired.")
	assertStringContains(t, stderr.String(), "The active pairing saved for https://conductross.com is invalid or expired.")
}

func newBridgeTestStores(t *testing.T) (*token.Store, *dashboardurl.Store) {
	t.Helper()

	t.Setenv("HOME", t.TempDir())

	tokenStore, err := token.NewStore("")
	if err != nil {
		t.Fatalf("token.NewStore returned error: %v", err)
	}

	dashboardStore, err := dashboardurl.NewStore("")
	if err != nil {
		t.Fatalf("dashboardurl.NewStore returned error: %v", err)
	}

	return tokenStore, dashboardStore
}

func assertStringContains(t *testing.T, got string, wantSubstring string) {
	t.Helper()

	if !strings.Contains(got, wantSubstring) {
		t.Fatalf("expected %q to contain %q", got, wantSubstring)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return fn(r)
}

func withDefaultHTTPClient(t *testing.T, fn roundTripFunc) {
	t.Helper()

	originalClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fn}
	t.Cleanup(func() {
		http.DefaultClient = originalClient
	})
}

func jsonHTTPResponse(statusCode int, payload any) *http.Response {
	body, _ := json.Marshal(payload)
	return &http.Response{
		StatusCode: statusCode,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(bytes.NewReader(body)),
	}
}
