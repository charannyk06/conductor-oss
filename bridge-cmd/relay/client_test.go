package relay

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestRelayAuthHeadersUsesAuthorizationBearer(t *testing.T) {
	t.Parallel()

	headers := relayAuthHeaders("  refresh-token  ")
	if got := headers.Get("Authorization"); got != "Bearer refresh-token" {
		t.Fatalf("Authorization = %q, want %q", got, "Bearer refresh-token")
	}
}

func TestWebsocketEndpointOmitsTokenQuery(t *testing.T) {
	t.Parallel()

	endpoint, err := websocketEndpoint("https://relay.example.com/base/", "device-123")
	if err != nil {
		t.Fatalf("websocketEndpoint returned error: %v", err)
	}
	if endpoint != "wss://relay.example.com/bridge/device-123" {
		t.Fatalf("endpoint = %q", endpoint)
	}
}

func TestTerminalBridgeEndpointOmitsTokenQuery(t *testing.T) {
	t.Parallel()

	endpoint, err := terminalBridgeEndpoint("https://relay.example.com/base/", "terminal-123")
	if err != nil {
		t.Fatalf("terminalBridgeEndpoint returned error: %v", err)
	}
	if endpoint != "wss://relay.example.com/terminal/terminal-123/bridge" {
		t.Fatalf("endpoint = %q", endpoint)
	}
}

func TestShouldRetryTerminalAttach(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "transport errors are retried",
			err:  &terminalAttachError{err: errors.New("request terminal token: connect: connection refused")},
			want: true,
		},
		{
			name: "conflict responses are retried",
			err:  &terminalAttachError{status: http.StatusConflict, err: errors.New("session is not running")},
			want: true,
		},
		{
			name: "bad gateway responses are retried",
			err:  &terminalAttachError{status: http.StatusBadGateway, err: errors.New("failed to attach live terminal")},
			want: true,
		},
		{
			name: "not found responses are not retried",
			err:  &terminalAttachError{status: http.StatusNotFound, err: errors.New("session not found")},
			want: false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldRetryTerminalAttach(tc.err); got != tc.want {
				t.Fatalf("shouldRetryTerminalAttach(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestResolveTerminalTokenPayloadPrefersNativeWSURL(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"wsUrl":"/api/sessions/session-123/terminal/ws?token=abc"}`)
	wsURL, protocol, err := resolveTerminalTokenPayload(payload, http.StatusOK)
	if err != nil {
		t.Fatalf("resolveTerminalTokenPayload returned error: %v", err)
	}
	if protocol != backendTerminalProtocolNative {
		t.Fatalf("protocol = %q, want %q", protocol, backendTerminalProtocolNative)
	}
	want := "ws://127.0.0.1:4749/api/sessions/session-123/terminal/ws?token=abc"
	if wsURL != want {
		t.Fatalf("wsURL = %q, want %q", wsURL, want)
	}
}

func TestResolveTerminalTokenPayloadAcceptsLegacyTTYDURL(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"ttydWsUrl":"ws://127.0.0.1:7681/ws"}`)
	wsURL, protocol, err := resolveTerminalTokenPayload(payload, http.StatusOK)
	if err != nil {
		t.Fatalf("resolveTerminalTokenPayload returned error: %v", err)
	}
	if protocol != backendTerminalProtocolTTYD {
		t.Fatalf("protocol = %q, want %q", protocol, backendTerminalProtocolTTYD)
	}
	if wsURL != "ws://127.0.0.1:7681/ws" {
		t.Fatalf("wsURL = %q, want %q", wsURL, "ws://127.0.0.1:7681/ws")
	}
}

func TestTtydInstallHintForGOOS(t *testing.T) {
	t.Parallel()

	windowsHint := ttydInstallHintForGOOS("windows")
	if strings.Contains(windowsHint, "brew install ttyd") {
		t.Fatalf("Windows ttyd hint should not mention Homebrew: %q", windowsHint)
	}
	if !strings.Contains(windowsHint, "optional on Windows") {
		t.Fatalf("Windows ttyd hint = %q, want optional Windows guidance", windowsHint)
	}

	darwinHint := ttydInstallHintForGOOS("darwin")
	if !strings.Contains(darwinHint, "brew install ttyd") {
		t.Fatalf("Darwin ttyd hint = %q, want Homebrew guidance", darwinHint)
	}
}
