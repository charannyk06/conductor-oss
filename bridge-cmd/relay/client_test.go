package relay

import (
	"errors"
	"net/http"
	"testing"
)

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
