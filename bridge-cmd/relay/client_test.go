package relay

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
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

func TestNormalizePreviewURLAllowsLoopbackDevServers(t *testing.T) {
	t.Parallel()

	cases := []string{
		"http://localhost:3000",
		"http://127.0.0.1:3000/app",
		"http://[::1]:3000",
	}
	for _, raw := range cases {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			if _, err := normalizePreviewURL(raw); err != nil {
				t.Fatalf("normalizePreviewURL(%q) returned error: %v", raw, err)
			}
		})
	}
}

func TestNormalizePreviewURLRewritesUnspecifiedHost(t *testing.T) {
	t.Parallel()

	parsed, err := normalizePreviewURL("http://0.0.0.0:3000")
	if err != nil {
		t.Fatalf("normalizePreviewURL returned error: %v", err)
	}
	if parsed.Host != "127.0.0.1:3000" {
		t.Fatalf("Host = %q, want 127.0.0.1:3000", parsed.Host)
	}
}

func TestNormalizePreviewURLRejectsNonLoopbackHosts(t *testing.T) {
	t.Parallel()

	cases := []string{
		"https://example.com",
		"http://192.168.1.10",
		"file:///tmp/app.html",
		"http://localhost.evil.com:3000",
		"http://127.0.0.1.evil.com",
		"http://notlocalhost.test",
	}
	for _, raw := range cases {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			if _, err := normalizePreviewURL(raw); err == nil {
				t.Fatalf("normalizePreviewURL(%q) succeeded, want error", raw)
			}
		})
	}
}

func TestBuildLocalBackendURLRejectsAbsoluteOrAuthorityPaths(t *testing.T) {
	t.Parallel()

	valid, err := buildLocalBackendURL("/api/sessions?limit=1")
	if err != nil {
		t.Fatalf("buildLocalBackendURL returned error for valid path: %v", err)
	}
	if got := valid.String(); got != "http://127.0.0.1:4749/api/sessions?limit=1" {
		t.Fatalf("backend URL = %q", got)
	}

	validWithURLQuery, err := buildLocalBackendURL("/api/proxy?url=http%3A%2F%2Fexample.com%2Fapp")
	if err != nil {
		t.Fatalf("buildLocalBackendURL rejected a URL-shaped query value: %v", err)
	}
	if got := validWithURLQuery.String(); got != "http://127.0.0.1:4749/api/proxy?url=http%3A%2F%2Fexample.com%2Fapp" {
		t.Fatalf("backend URL with query = %q", got)
	}

	cases := []string{
		"@evil.com/api",
		"//evil.com/api",
		"http://evil.com/api",
		"?next=http://evil.com",
		"/api/sessions\r\nHost: evil.com",
	}
	for _, raw := range cases {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			if _, err := buildLocalBackendURL(raw); err == nil {
				t.Fatalf("buildLocalBackendURL(%q) succeeded, want error", raw)
			}
		})
	}
}

func TestResolveTerminalTokenPayloadRejectsRemoteWebsocketHost(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"wsUrl":"wss://evil.example/ws"}`)
	if _, _, err := resolveTerminalTokenPayload(payload, http.StatusOK); err == nil {
		t.Fatal("resolveTerminalTokenPayload accepted a remote websocket host")
	}
}

func TestDecodeBridgeInstallScriptURLRestrictsRepairSources(t *testing.T) {
	t.Parallel()

	valid, err := decodeBridgeInstallScriptURL(map[string]interface{}{
		"installScriptUrl": "https://app.conductross.com/bridge/install.sh",
	})
	if err != nil {
		t.Fatalf("decodeBridgeInstallScriptURL returned error for official URL: %v", err)
	}
	if valid != "https://app.conductross.com/bridge/install.sh" {
		t.Fatalf("install URL = %q", valid)
	}

	cases := []string{
		"http://app.conductross.com/bridge/install.sh",
		"https://evil.example/bridge/install.sh",
		"https://app.conductross.com/other.sh",
		"https://user:pass@app.conductross.com/bridge/install.sh",
		"https://localhost.evil.com/bridge/install.sh",
	}
	for _, raw := range cases {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			_, err := decodeBridgeInstallScriptURL(map[string]interface{}{"installScriptUrl": raw})
			if err == nil {
				t.Fatalf("decodeBridgeInstallScriptURL(%q) succeeded, want error", raw)
			}
		})
	}
}

func TestBrowseFilesRestrictsToAllowedRoots(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "project")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nested, "README.md"), []byte("demo"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	t.Setenv(bridgeFileRootsEnv, root)

	entries, err := browseFiles(nested)
	if err != nil {
		t.Fatalf("browseFiles returned error for allowed root: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries length = %d, want 1", len(entries))
	}

	outside := string(filepath.Separator) + "etc"
	if _, err := browseFiles(outside); err == nil {
		t.Fatalf("browseFiles(%q) succeeded, want root restriction error", outside)
	}
}
