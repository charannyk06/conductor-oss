package connect

import "testing"

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
