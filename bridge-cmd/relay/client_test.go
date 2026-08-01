package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newIPv4TestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("sandbox blocks loopback listeners: %v", err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	return server
}

func readBridgeEnvelope(t *testing.T, conn *websocket.Conn) bridgeEnvelope {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket message: %v", err)
	}
	var env bridgeEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("decode bridge envelope %q: %v", string(data), err)
	}
	return env
}

func waitForBridgeEnvelope(t *testing.T, conn *websocket.Conn, predicate func(bridgeEnvelope) bool) bridgeEnvelope {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		env := readBridgeEnvelope(t, conn)
		if predicate(env) {
			return env
		}
	}
	t.Fatal("timed out waiting for bridge message")
	return bridgeEnvelope{}
}

func writeBridgeEnvelope(t *testing.T, conn *websocket.Conn, env bridgeEnvelope) {
	t.Helper()
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("encode bridge envelope: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}
}

func assertStreamCapability(t *testing.T, env bridgeEnvelope) {
	t.Helper()
	if env.Type != "bridge_status" {
		t.Fatalf("message type = %q, want bridge_status", env.Type)
	}
	if env.Hostname == "" || env.OS == "" {
		t.Fatalf("bridge_status missing host metadata: %+v", env)
	}
	if !env.Connected {
		t.Fatalf("bridge_status connected = false, want true")
	}
	for _, capability := range env.Capabilities {
		if capability == apiStreamV1Capability {
			return
		}
	}
	t.Fatalf("bridge_status capabilities = %v, want %q", env.Capabilities, apiStreamV1Capability)
}

func runSessionAsync(ctx context.Context, opts sessionOptions) <-chan struct {
	connected bool
	err       error
} {
	done := make(chan struct {
		connected bool
		err       error
	}, 1)
	go func() {
		connected, err := runSession(ctx, opts)
		done <- struct {
			connected bool
			err       error
		}{connected: connected, err: err}
	}()
	return done
}

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

func TestRunSessionReportsEstablishedConnectionAfterRelayDrops(t *testing.T) {
	t.Setenv(legacyTTYDMirrorEnv, "")

	serverErr := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()

		env := readBridgeEnvelope(t, conn)
		if env.Type != "bridge_status" {
			serverErr <- errors.New("expected bridge_status handshake")
			return
		}
		assertStreamCapability(t, env)
		serverErr <- nil
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connected, err := runSession(ctx, sessionOptions{
		relayURL:          server.URL,
		refreshToken:      "refresh-token",
		scope:             "device-123",
		hostname:          "test-host",
		osName:            "test-os",
		version:           "test-version",
		stderr:            io.Discard,
		heartbeatInterval: time.Hour,
	})
	select {
	case serverErr := <-serverErr:
		if serverErr != nil {
			t.Fatalf("relay test server failed: %v", serverErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay test server did not complete the handshake")
	}
	if !connected {
		t.Fatal("runSession reported an unestablished attempt after completing the relay handshake")
	}
	if err == nil {
		t.Fatal("runSession returned nil error after the relay dropped the connection")
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

func TestTerminalWebSocketReadErrorTreatsExpectedClosesAsEOF(t *testing.T) {
	t.Parallel()

	for _, code := range []int{
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	} {
		err := terminalWebSocketReadError("relay terminal", &websocket.CloseError{Code: code})
		if !errors.Is(err, io.EOF) {
			t.Fatalf("close code %d returned %v, want io.EOF", code, err)
		}
	}

	err := terminalWebSocketReadError(
		"relay terminal",
		&websocket.CloseError{Code: websocket.CloseAbnormalClosure},
	)
	if err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("abnormal close returned %v, want a diagnostic error", err)
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
	t.Setenv(bridgeInstallHostsEnv, "")

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

func TestDecodeBase64BoundedAllowsExactlyMaxDecodedBytes(t *testing.T) {
	t.Parallel()

	encoded := base64.StdEncoding.EncodeToString([]byte("abcd"))
	decoded, err := decodeBase64Bounded(encoded, 4, "payload")
	if err != nil {
		t.Fatalf("decodeBase64Bounded rejected exact max payload: %v", err)
	}
	if string(decoded) != "abcd" {
		t.Fatalf("decoded payload = %q", string(decoded))
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

func TestRunSessionStreamsHeldOpenSSEWithSanitizedHeaders(t *testing.T) {
	t.Setenv(legacyTTYDMirrorEnv, "")

	requestHeaders := make(chan http.Header, 1)
	releaseSecondChunk := make(chan struct{})
	backend := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/dispatcher/feed/stream" {
			http.NotFound(w, r)
			return
		}
		requestHeaders <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("Set-Cookie", "bridge-secret=1")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("backend response writer is not flushable")
		}
		if _, err := io.WriteString(w, "data: first\n\n"); err != nil {
			return
		}
		flusher.Flush()
		<-releaseSecondChunk
		_, _ = io.WriteString(w, "data: second\n\n")
		flusher.Flush()
	}))
	defer backend.Close()

	upgrader := websocket.Upgrader{}
	relay := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade relay websocket: %v", err)
		}
		defer conn.Close()

		assertStreamCapability(t, readBridgeEnvelope(t, conn))
		writeBridgeEnvelope(t, conn, bridgeEnvelope{
			Type:   "api_stream_request",
			ID:     "stream-1",
			Method: http.MethodGet,
			Path:   "/api/dispatcher/feed/stream",
			Headers: map[string]string{
				"accept":           "text/event-stream",
				"cache-control":    "no-cache",
				"authorization":    "Bearer should-not-forward",
				"cookie":           "secret=1",
				"x-forwarded-host": "evil.example",
				"connection":       "keep-alive",
			},
		})

		start := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_start" && env.ID == "stream-1"
		})
		if start.Status != http.StatusOK {
			t.Fatalf("stream start status = %d, want %d", start.Status, http.StatusOK)
		}
		if got := start.Headers["content-type"]; got != "text/event-stream" {
			t.Fatalf("start content-type = %q, want text/event-stream", got)
		}
		if got := start.Headers["cache-control"]; got != "no-cache, no-transform" {
			t.Fatalf("start cache-control = %q", got)
		}
		if got := start.Headers["x-accel-buffering"]; got != "no" {
			t.Fatalf("start x-accel-buffering = %q, want no", got)
		}
		if _, ok := start.Headers["set-cookie"]; ok {
			t.Fatal("start headers leaked set-cookie")
		}
		if _, ok := start.Headers["connection"]; ok {
			t.Fatal("start headers leaked connection")
		}

		firstChunk := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_chunk" && env.ID == "stream-1"
		})
		firstBytes, err := base64.StdEncoding.DecodeString(firstChunk.ChunkBase64)
		if err != nil {
			t.Fatalf("decode first stream chunk: %v", err)
		}
		if string(firstBytes) != "data: first\n\n" {
			t.Fatalf("first chunk = %q", string(firstBytes))
		}

		close(releaseSecondChunk)

		secondChunk := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_chunk" && env.ID == "stream-1"
		})
		secondBytes, err := base64.StdEncoding.DecodeString(secondChunk.ChunkBase64)
		if err != nil {
			t.Fatalf("decode second stream chunk: %v", err)
		}
		if string(secondBytes) != "data: second\n\n" {
			t.Fatalf("second chunk = %q", string(secondBytes))
		}

		end := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_end" && env.ID == "stream-1"
		})
		if end.Error != "" {
			t.Fatalf("stream end error = %q, want empty", end.Error)
		}
	}))
	defer relay.Close()

	done := runSessionAsync(context.Background(), sessionOptions{
		relayURL:          relay.URL,
		refreshToken:      "refresh-token",
		scope:             "device-123",
		hostname:          "test-host",
		osName:            "test-os",
		version:           "test-version",
		stderr:            io.Discard,
		heartbeatInterval: time.Hour,
		backendBaseURL:    backend.URL,
	})

	select {
	case headers := <-requestHeaders:
		if got := headers.Get("Accept"); got != "text/event-stream" {
			t.Fatalf("backend accept header = %q", got)
		}
		if got := headers.Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("backend cache-control header = %q", got)
		}
		if got := headers.Get("Authorization"); got != "" {
			t.Fatalf("backend authorization header leaked: %q", got)
		}
		if got := headers.Get("Cookie"); got != "" {
			t.Fatalf("backend cookie header leaked: %q", got)
		}
		if got := headers.Get("X-Forwarded-Host"); got != "" {
			t.Fatalf("backend x-forwarded-host leaked: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("backend did not receive streamed request")
	}

	select {
	case result := <-done:
		if !result.connected {
			t.Fatal("runSession reported disconnected attempt after streamed request")
		}
		if result.err == nil {
			t.Fatal("runSession returned nil error after relay closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runSession did not exit after relay closed")
	}
}

func TestRunSessionSendsHeartbeatWhileAPIStreamRemainsOpen(t *testing.T) {
	t.Setenv(legacyTTYDMirrorEnv, "")

	release := make(chan struct{})
	backend := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("backend response writer is not flushable")
		}
		_, _ = io.WriteString(w, "data: waiting\n\n")
		flusher.Flush()
		<-release
	}))
	defer backend.Close()

	upgrader := websocket.Upgrader{}
	relay := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade relay websocket: %v", err)
		}
		defer conn.Close()

		assertStreamCapability(t, readBridgeEnvelope(t, conn))
		writeBridgeEnvelope(t, conn, bridgeEnvelope{
			Type:   "api_stream_request",
			ID:     "stream-heartbeat",
			Method: http.MethodGet,
			Path:   "/api/dispatcher/feed/stream",
			Headers: map[string]string{
				"accept": "text/event-stream",
			},
		})

		waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_start" && env.ID == "stream-heartbeat"
		})
		waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_chunk" && env.ID == "stream-heartbeat"
		})
		heartbeat := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "bridge_status"
		})
		assertStreamCapability(t, heartbeat)

		close(release)
	}))
	defer relay.Close()

	done := runSessionAsync(context.Background(), sessionOptions{
		relayURL:          relay.URL,
		refreshToken:      "refresh-token",
		scope:             "device-123",
		hostname:          "test-host",
		osName:            "test-os",
		version:           "test-version",
		stderr:            io.Discard,
		heartbeatInterval: 40 * time.Millisecond,
		backendBaseURL:    backend.URL,
	})

	select {
	case result := <-done:
		if !result.connected {
			t.Fatal("runSession reported disconnected attempt after heartbeat stream")
		}
		if result.err == nil {
			t.Fatal("runSession returned nil error after relay closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runSession did not exit after heartbeat test")
	}
}

func TestEnsureLocalBackendForProxyHonorsCancellationWhileWaiting(t *testing.T) {
	<-backendEnsureGate
	defer func() { backendEnsureGate <- struct{}{} }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	err := ensureLocalBackendForProxy(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ensure error = %v, want context.Canceled", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("cancelled ensure waited too long: %s", elapsed)
	}
}

func TestRunSessionAPIStreamCancelIsPerIDAndCleansUp(t *testing.T) {
	t.Setenv(legacyTTYDMirrorEnv, "")

	a1Cancelled := make(chan struct{}, 1)
	a2Cancelled := make(chan struct{}, 1)
	releaseB := make(chan struct{})
	backend := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("backend response writer is not flushable")
		}
		switch r.URL.Query().Get("target") {
		case "a1":
			_, _ = io.WriteString(w, "data: a1\n\n")
			flusher.Flush()
			<-r.Context().Done()
			a1Cancelled <- struct{}{}
		case "a2":
			_, _ = io.WriteString(w, "data: a2\n\n")
			flusher.Flush()
			<-r.Context().Done()
			a2Cancelled <- struct{}{}
		case "b":
			_, _ = io.WriteString(w, "data: b1\n\n")
			flusher.Flush()
			<-releaseB
			_, _ = io.WriteString(w, "data: b2\n\n")
			flusher.Flush()
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	defer func() {
		select {
		case <-releaseB:
		default:
			close(releaseB)
		}
	}()

	upgrader := websocket.Upgrader{}
	relay := newIPv4TestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade relay websocket: %v", err)
		}
		defer conn.Close()

		assertStreamCapability(t, readBridgeEnvelope(t, conn))
		writeBridgeEnvelope(t, conn, bridgeEnvelope{
			Type:   "api_stream_request",
			ID:     "stream-a",
			Method: http.MethodGet,
			Path:   "/api/dispatcher/feed/stream?target=a1",
		})
		writeBridgeEnvelope(t, conn, bridgeEnvelope{
			Type:   "api_stream_request",
			ID:     "stream-b",
			Method: http.MethodGet,
			Path:   "/api/dispatcher/feed/stream?target=b",
		})

		started := map[string]bool{}
		for len(started) < 2 {
			env := readBridgeEnvelope(t, conn)
			if env.Type == "api_stream_start" && (env.ID == "stream-a" || env.ID == "stream-b") {
				started[env.ID] = true
			}
		}

		writeBridgeEnvelope(t, conn, bridgeEnvelope{Type: "api_stream_cancel", ID: "stream-a"})
		select {
		case <-a1Cancelled:
		case <-time.After(5 * time.Second):
			t.Fatal("first stream-a request was not cancelled")
		}

		writeBridgeEnvelope(t, conn, bridgeEnvelope{
			Type:   "api_stream_request",
			ID:     "stream-a",
			Method: http.MethodGet,
			Path:   "/api/dispatcher/feed/stream?target=a2",
		})
		waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_start" && env.ID == "stream-a"
		})

		writeBridgeEnvelope(t, conn, bridgeEnvelope{Type: "api_stream_cancel", ID: "stream-a"})
		select {
		case <-a2Cancelled:
		case <-time.After(5 * time.Second):
			t.Fatal("replacement stream-a request was not cancelled")
		}

		close(releaseB)
		finalChunk := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			if env.Type != "api_stream_chunk" || env.ID != "stream-b" {
				return false
			}
			decoded, err := base64.StdEncoding.DecodeString(env.ChunkBase64)
			return err == nil && string(decoded) == "data: b2\n\n"
		})
		decoded, err := base64.StdEncoding.DecodeString(finalChunk.ChunkBase64)
		if err != nil {
			t.Fatalf("decode stream-b chunk: %v", err)
		}
		if string(decoded) != "data: b2\n\n" {
			t.Fatalf("stream-b final chunk = %q", string(decoded))
		}
		end := waitForBridgeEnvelope(t, conn, func(env bridgeEnvelope) bool {
			return env.Type == "api_stream_end" && env.ID == "stream-b"
		})
		if end.Error != "" {
			t.Fatalf("stream-b end error = %q, want empty", end.Error)
		}
		if err := conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "test complete"),
			time.Now().Add(time.Second),
		); err != nil {
			t.Fatalf("close relay websocket: %v", err)
		}
	}))
	defer relay.Close()

	done := runSessionAsync(context.Background(), sessionOptions{
		relayURL:          relay.URL,
		refreshToken:      "refresh-token",
		scope:             "device-123",
		hostname:          "test-host",
		osName:            "test-os",
		version:           "test-version",
		stderr:            io.Discard,
		heartbeatInterval: time.Hour,
		backendBaseURL:    backend.URL,
	})

	select {
	case result := <-done:
		if !result.connected {
			t.Fatal("runSession reported disconnected attempt after cancel test")
		}
		if result.err == nil {
			t.Fatal("runSession returned nil error after relay closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runSession did not exit after cancel test")
	}
}

func TestSendAPIStreamFailureResponseSynthesizesErrorLifecycle(t *testing.T) {
	var messages []bridgeEnvelope
	err := sendAPIStreamFailureResponse(func(env bridgeEnvelope) error {
		messages = append(messages, env)
		return nil
	}, "stream-fail", http.StatusBadGateway, "backend unavailable")
	if err != nil {
		t.Fatalf("send failure lifecycle: %v", err)
	}
	if len(messages) != 3 {
		t.Fatalf("failure lifecycle message count = %d, want 3", len(messages))
	}
	start, chunk, end := messages[0], messages[1], messages[2]
	if start.Type != "api_stream_start" || start.ID != "stream-fail" || start.Status != http.StatusBadGateway {
		t.Fatalf("unexpected failure start: %+v", start)
	}
	if got := start.Headers["content-type"]; got != "application/json" {
		t.Fatalf("failure start content-type = %q", got)
	}
	if chunk.Type != "api_stream_chunk" || chunk.ID != "stream-fail" {
		t.Fatalf("unexpected failure chunk: %+v", chunk)
	}
	body, err := base64.StdEncoding.DecodeString(chunk.ChunkBase64)
	if err != nil {
		t.Fatalf("decode failure chunk: %v", err)
	}
	if !strings.Contains(string(body), `"error":`) {
		t.Fatalf("failure chunk body = %q, want JSON error", string(body))
	}
	if end.Type != "api_stream_end" || end.ID != "stream-fail" || end.Error != "" {
		t.Fatalf("unexpected failure end: %+v", end)
	}
}
