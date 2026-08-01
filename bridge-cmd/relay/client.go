package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/backend"
	"github.com/charannyk06/conductor-oss/bridge/install"
	"github.com/gorilla/websocket"
)

const (
	defaultScope                   = "conductor-bridge-control"
	defaultHeartbeatInterval       = 30 * time.Second
	maxReconnectBackoff            = 30 * time.Second
	terminalAttachMaxAttempts      = 12
	apiStreamV1Capability          = "api_stream_v1"
	ttydPortRangeStart             = 7681
	ttydPortRangeEnd               = 8699
	bridgeProxyMetaKey             = "$bridgeProxy"
	bridgeRequestMetaKey           = "$bridgeRequest"
	bridgeInstallPath              = "/_bridge/install"
	bridgeServiceRestartPath       = "/_bridge/service/restart"
	maxPreviewResponseBytes        = 10 * 1024 * 1024
	maxPreviewRequestBodyBytes     = 10 * 1024 * 1024
	maxProxyRequestBodyBytes       = 10 * 1024 * 1024
	maxBackendResponseBytes        = 10 * 1024 * 1024
	maxAPIStreamChunkBytes         = 48 * 1024
	maxTerminalTokenResponseBytes  = 64 * 1024
	maxBridgeInstallScriptBytes    = 512 * 1024
	maxFileBrowseEntries           = 2000
	maxBridgeWebSocketMessageBytes = 10 * 1024 * 1024
	legacyTTYDMirrorEnv            = "CONDUCTOR_ENABLE_LEGACY_TTYD_MIRROR"
	bridgeInstallHostsEnv          = "CONDUCTOR_BRIDGE_INSTALL_HOSTS"
	bridgeFileRootsEnv             = "CONDUCTOR_BRIDGE_FILE_ROOTS"
)

type Options struct {
	RelayURL          string
	RefreshToken      string
	Scope             string
	Hostname          string
	OS                string
	Stderr            io.Writer
	HeartbeatInterval time.Duration
}

type bridgeEnvelope struct {
	Type string `json:"type"`

	// terminal_input / terminal_output
	Data string `json:"data,omitempty"`

	// api_request / api_response
	ID          string            `json:"id,omitempty"`
	Method      string            `json:"method,omitempty"`
	Path        string            `json:"path,omitempty"`
	URL         string            `json:"url,omitempty"`
	Status      int               `json:"status,omitempty"`
	Body        interface{}       `json:"body,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	BodyBase64  string            `json:"body_base64,omitempty"`
	ChunkBase64 string            `json:"chunk_base64,omitempty"`

	// terminal_proxy_start
	TerminalID string `json:"terminal_id,omitempty"`
	SessionID  string `json:"session_id,omitempty"`

	// file_browse / file_tree
	Entries []any  `json:"entries,omitempty"`
	Error   string `json:"error,omitempty"`

	// terminal_resize
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`

	// bridge_status
	Hostname     string   `json:"hostname,omitempty"`
	OS           string   `json:"os,omitempty"`
	Connected    bool     `json:"connected,omitempty"`
	Version      string   `json:"version,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type backendHealthPayload struct {
	Version string `json:"version"`
}

type terminalAttachError struct {
	status int
	err    error
}

type backendTerminalProtocol string

const (
	backendTerminalProtocolNative backendTerminalProtocol = "native"
	backendTerminalProtocolTTYD   backendTerminalProtocol = "ttyd"
)

type terminalTokenPayload struct {
	WSURL     string `json:"wsUrl"`
	TtydWSURL string `json:"ttydWsUrl"`
	Error     string `json:"error"`
}

type nativeTerminalClientMessage struct {
	Type string `json:"type"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
	Data string `json:"data,omitempty"`
}

type relayResizePayload struct {
	Columns int `json:"columns"`
	Rows    int `json:"rows"`
}

func (e *terminalAttachError) Error() string {
	if e == nil {
		return "terminal attach failed"
	}
	if e.err != nil {
		return e.err.Error()
	}
	if e.status > 0 {
		return fmt.Sprintf("terminal attach failed with status %d", e.status)
	}
	return "terminal attach failed"
}

func (e *terminalAttachError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

func Run(ctx context.Context, opts Options) error {
	if strings.TrimSpace(opts.RelayURL) == "" {
		return fmt.Errorf("relay URL is required")
	}
	if strings.TrimSpace(opts.RefreshToken) == "" {
		return fmt.Errorf("refresh token is required")
	}

	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	scope := strings.TrimSpace(opts.Scope)
	if scope == "" {
		scope = defaultScope
	}
	hostname := strings.TrimSpace(opts.Hostname)
	if hostname == "" {
		if value, err := os.Hostname(); err == nil && strings.TrimSpace(value) != "" {
			hostname = value
		} else {
			hostname = "unknown"
		}
	}
	osName := strings.TrimSpace(opts.OS)
	if osName == "" {
		osName = "unknown"
	}
	heartbeat := opts.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeatInterval
	}
	version := resolveLocalConductorVersion()

	backoff := time.Second
	for {
		connected, err := runSession(ctx, sessionOptions{
			relayURL:          opts.RelayURL,
			refreshToken:      opts.RefreshToken,
			scope:             scope,
			hostname:          hostname,
			osName:            osName,
			version:           version,
			stderr:            stderr,
			heartbeatInterval: heartbeat,
			backendBaseURL:    "http://127.0.0.1:4749",
		})
		if ctx.Err() != nil {
			return nil
		}
		if connected {
			backoff = time.Second
		}
		if err != nil {
			fmt.Fprintf(stderr, "relay connection lost: %v\n", err)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}

		if backoff < maxReconnectBackoff {
			backoff *= 2
			if backoff > maxReconnectBackoff {
				backoff = maxReconnectBackoff
			}
		}
	}
}

type sessionOptions struct {
	relayURL          string
	refreshToken      string
	scope             string
	hostname          string
	osName            string
	version           string
	stderr            io.Writer
	heartbeatInterval time.Duration
	backendBaseURL    string
}

var backendEnsureGate = func() chan struct{} {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return gate
}()

type apiStreamHandle struct {
	cancel context.CancelFunc
}

type apiStreamRegistry struct {
	mu      sync.Mutex
	handles map[string]*apiStreamHandle
}

func (r *apiStreamRegistry) register(id string, handle *apiStreamHandle) *apiStreamHandle {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.handles == nil {
		r.handles = make(map[string]*apiStreamHandle)
	}
	previous := r.handles[id]
	r.handles[id] = handle
	return previous
}

func (r *apiStreamRegistry) cancel(id string) {
	var handle *apiStreamHandle
	r.mu.Lock()
	if r.handles != nil {
		handle = r.handles[id]
		delete(r.handles, id)
	}
	r.mu.Unlock()
	if handle != nil {
		handle.cancel()
	}
}

func (r *apiStreamRegistry) removeIfMatch(id string, handle *apiStreamHandle) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.handles == nil {
		return
	}
	if current := r.handles[id]; current == handle {
		delete(r.handles, id)
	}
}

func (r *apiStreamRegistry) cancelAll() {
	r.mu.Lock()
	if len(r.handles) == 0 {
		r.mu.Unlock()
		return
	}
	handles := make([]*apiStreamHandle, 0, len(r.handles))
	for id, handle := range r.handles {
		delete(r.handles, id)
		handles = append(handles, handle)
	}
	r.mu.Unlock()
	for _, handle := range handles {
		if handle != nil {
			handle.cancel()
		}
	}
}

func legacyTTYDMirrorEnabled() bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(legacyTTYDMirrorEnv)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func decodeBase64Bounded(encoded string, maxBytes int, label string) ([]byte, error) {
	trimmed := strings.TrimSpace(encoded)
	if trimmed == "" {
		return nil, fmt.Errorf("missing %s", label)
	}
	if len(trimmed) > base64.StdEncoding.EncodedLen(maxBytes) {
		return nil, fmt.Errorf("%s exceeds %d bytes", label, maxBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", label, err)
	}
	if len(decoded) > maxBytes {
		return nil, fmt.Errorf("%s exceeds %d bytes", label, maxBytes)
	}
	return decoded, nil
}

func readAllBounded(reader io.Reader, maxBytes int, label string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(maxBytes)+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	if len(data) > maxBytes {
		return nil, fmt.Errorf("%s exceeded %d bytes", label, maxBytes)
	}
	return data, nil
}

func sanitizeHeaderValue(value string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(value)
}

func sanitizeProxyRequestHeaders(headers map[string]string) (http.Header, error) {
	sanitized := http.Header{}
	for name, value := range headers {
		lower := strings.ToLower(strings.TrimSpace(name))
		switch lower {
		case "", "authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "forwarded", "proxy-authorization", "proxy-authenticate":
			continue
		}
		if strings.ContainsAny(lower, "\r\n") {
			return nil, fmt.Errorf("invalid proxy request header name")
		}
		sanitized.Set(lower, sanitizeHeaderValue(value))
	}
	return sanitized, nil
}

func sanitizeProxyResponseHeaders(headers http.Header) map[string]string {
	sanitized := map[string]string{}
	for name, values := range headers {
		if len(values) == 0 {
			continue
		}
		lower := strings.ToLower(strings.TrimSpace(name))
		switch lower {
		case "", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade", "proxy-authenticate", "proxy-authentication-info", "proxy-authorization", "te", "trailers", "set-cookie", "set-cookie2":
			continue
		}
		value := sanitizeHeaderValue(values[len(values)-1])
		if strings.ContainsAny(value, "\r\n") {
			continue
		}
		sanitized[lower] = value
	}
	return sanitized
}

func encodeProxyRequestBody(body interface{}) ([]byte, string, error) {
	if body == nil {
		return nil, "", nil
	}
	if rawBody, rawContentType, ok, err := decodeProxyRequestBody(body); ok {
		if err != nil {
			return nil, "", err
		}
		if rawContentType != "" {
			return rawBody, rawContentType, nil
		}
		return rawBody, "application/octet-stream", nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, "", fmt.Errorf("encode backend request body: %w", err)
	}
	return bodyBytes, "application/json", nil
}

func normalizeHTTPMethod(method string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(method))
	if normalized == "" {
		normalized = http.MethodGet
	}
	switch normalized {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return normalized, nil
	default:
		return "", fmt.Errorf("HTTP method %q is not allowed", method)
	}
}

func buildLocalBackendURL(rawPath string) (*url.URL, error) {
	return buildLocalBackendURLWithBase("http://127.0.0.1:4749", rawPath)
}

func buildLocalBackendURLWithBase(baseURL, rawPath string) (*url.URL, error) {
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		trimmed = "/"
	}
	if strings.ContainsAny(trimmed, "\r\n") {
		return nil, fmt.Errorf("backend path contains invalid characters")
	}
	if !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") {
		return nil, fmt.Errorf("backend path must be a slash-prefixed relative path")
	}
	parsed, err := url.ParseRequestURI(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse backend path: %w", err)
	}
	if parsed.Path == "" || !strings.HasPrefix(parsed.Path, "/") || parsed.Scheme != "" || parsed.Host != "" || parsed.User != nil {
		return nil, fmt.Errorf("backend path must not include a scheme or host")
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("parse backend base url: %w", err)
	}
	return base.ResolveReference(&url.URL{
		Path:     parsed.Path,
		RawQuery: parsed.RawQuery,
	}), nil
}

func requireLoopbackDialTarget(ctx context.Context, address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	host = strings.Trim(host, "[]")
	if parsedIP := net.ParseIP(host); parsedIP != nil {
		if parsedIP.IsLoopback() || parsedIP.IsUnspecified() {
			return nil
		}
		return fmt.Errorf("non-loopback preview address %q is not allowed", host)
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("resolve preview host %q: %w", host, err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("preview host %q did not resolve", host)
	}
	for _, resolved := range ips {
		if !resolved.IP.IsLoopback() && !resolved.IP.IsUnspecified() {
			return fmt.Errorf("preview host %q resolved to non-loopback address %s", host, resolved.IP.String())
		}
	}
	return nil
}

func loopbackOnlyHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if err := requireLoopbackDialTarget(ctx, address); err != nil {
				return nil, err
			}
			return dialer.DialContext(ctx, network, address)
		},
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// findFreePort asks the OS for a free port in the ttyd range.
func findFreePort() (int, error) {
	for port := ttydPortRangeStart; port <= ttydPortRangeEnd; port++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			l.Close()
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free port found in range %d-%d", ttydPortRangeStart, ttydPortRangeEnd)
}

// findTtyd looks for the ttyd binary.
func findTtyd() (string, error) {
	path, err := exec.LookPath("ttyd")
	if err == nil {
		return path, nil
	}
	// Try common install locations
	for _, loc := range []string{
		"/usr/local/bin/ttyd",
		"/usr/bin/ttyd",
		"/opt/homebrew/bin/ttyd",
		filepath.Join(os.Getenv("HOME"), ".local/bin/ttyd"),
	} {
		if _, err := os.Stat(loc); err == nil {
			return loc, nil
		}
	}
	return "", fmt.Errorf("ttyd not found in PATH or common locations; %s", ttydInstallHintForGOOS(runtime.GOOS))
}

func ttydInstallHintForGOOS(goos string) string {
	switch goos {
	case "darwin":
		return "install with Homebrew: brew install ttyd"
	case "linux":
		return "install ttyd with your system package manager or from https://github.com/tsl0922/ttyd"
	case "windows":
		return "ttyd is optional on Windows; install a Windows ttyd build or continue without the legacy direct terminal mirror"
	default:
		return "ttyd is optional; install it for the legacy direct terminal mirror if needed"
	}
}

func runSession(ctx context.Context, opts sessionOptions) (bool, error) {
	var cmd *exec.Cmd
	var ttydConn *websocket.Conn

	stopTtyd := func() {
		if ttydConn != nil {
			_ = ttydConn.Close()
			ttydConn = nil
		}
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		cmd = nil
	}

	// 1. ttyd is optional for the initial bridge connection. If it is missing,
	// keep the device online and fall back to API + session-terminal proxy flows.
	if legacyTTYDMirrorEnabled() {
		if ttydPath, err := findTtyd(); err == nil {
			port, err := findFreePort()
			if err != nil {
				fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", err)
			} else {
				// findTtyd only returns an existing ttyd binary path. Legacy mirror is disabled by default.
				// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
				cmd = exec.Command(ttydPath, []string{
					"-p", fmt.Sprintf("%d", port),
					"-i", "127.0.0.1",
					"-W", // accept any origin (relay->bridge->browser)
					"bash",
				}...)
				cmd.Env = os.Environ()
				ttydOut, pipeErr := cmd.StdoutPipe()
				if pipeErr != nil {
					fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", pipeErr)
					stopTtyd()
				} else if ttydErr, pipeErr := cmd.StderrPipe(); pipeErr != nil {
					fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", pipeErr)
					stopTtyd()
				} else if startErr := cmd.Start(); startErr != nil {
					fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", startErr)
					stopTtyd()
				} else {
					go func(stdoutPipe io.ReadCloser) {
						buf := make([]byte, 1024)
						for {
							n, err := stdoutPipe.Read(buf)
							if n > 0 {
								fmt.Fprintf(os.Stderr, "[ttyd] %s", string(buf[:n]))
							}
							if err != nil {
								break
							}
						}
					}(ttydOut)
					go func(stderrPipe io.ReadCloser) {
						buf := make([]byte, 1024)
						for {
							n, err := stderrPipe.Read(buf)
							if n > 0 {
								fmt.Fprintf(os.Stderr, "[ttyd] %s", string(buf[:n]))
							}
							if err != nil {
								break
							}
						}
					}(ttydErr)

					time.Sleep(500 * time.Millisecond)
					if cmd == nil || cmd.Process == nil {
						fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: ttyd process not started\n")
						stopTtyd()
					} else {
						ttydURL := fmt.Sprintf("ws://127.0.0.1:%d/ws", port)
						ttydWS, _, dialErr := websocket.DefaultDialer.DialContext(ctx, ttydURL, nil)
						if dialErr != nil {
							fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", dialErr)
							stopTtyd()
						} else {
							ttydWS.SetReadLimit(maxBridgeWebSocketMessageBytes)
							ttydConn = ttydWS
						}
					}
				}
			}
		} else {
			fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", err)
		}
	} else {
		fmt.Fprintf(opts.stderr, "legacy ttyd mirror disabled; bridge will use the authenticated backend terminal proxy. Set %s=true to re-enable the legacy mirror.\n", legacyTTYDMirrorEnv)
	}

	// 2. Connect to relay.
	relayEndpoint, err := websocketEndpoint(opts.relayURL, opts.scope)
	if err != nil {
		stopTtyd()
		return false, fmt.Errorf("build relay endpoint: %w", err)
	}
	relayConn, _, err := websocket.DefaultDialer.DialContext(ctx, relayEndpoint, relayAuthHeaders(opts.refreshToken))
	if err != nil {
		stopTtyd()
		return false, fmt.Errorf("dial relay: %w", err)
	}
	defer relayConn.Close()
	relayConn.SetReadLimit(maxBridgeWebSocketMessageBytes)
	defer stopTtyd()

	// 3. Tell relay we are connected and ready.
	var relayMu sync.Mutex
	send := func(env bridgeEnvelope) error {
		data, _ := json.Marshal(env)
		relayMu.Lock()
		defer relayMu.Unlock()
		return relayConn.WriteMessage(websocket.TextMessage, data)
	}
	statusEnvelope := func() bridgeEnvelope {
		return bridgeEnvelope{
			Type:         "bridge_status",
			Hostname:     opts.hostname,
			OS:           opts.osName,
			Connected:    true,
			Version:      opts.version,
			Capabilities: []string{apiStreamV1Capability},
		}
	}
	if err := send(statusEnvelope()); err != nil {
		stopTtyd()
		return false, fmt.Errorf("send bridge_status: %w", err)
	}

	// 4. Bidirectional bridge loop.
	errCh := make(chan error, 2)
	var activeTerminals sync.Map
	var activeAPIStreams apiStreamRegistry
	defer activeAPIStreams.cancelAll()

	// relay → ttyd
	go func() {
		for {
			_, data, err := relayConn.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("relay read: %w", err)
				return
			}

			var env bridgeEnvelope
			if err := json.Unmarshal(data, &env); err != nil {
				if ttydConn != nil {
					_ = ttydConn.WriteMessage(websocket.BinaryMessage, data)
				}
				continue
			}

			switch env.Type {
			case "terminal_input":
				if ttydConn != nil {
					_ = ttydConn.WriteMessage(websocket.BinaryMessage, []byte(env.Data))
				}

			case "terminal_resize":
				if ttydConn != nil {
					resize, _ := json.Marshal(map[string]int{"cols": env.Cols, "rows": env.Rows})
					_ = ttydConn.WriteMessage(websocket.TextMessage, resize)
				}

			case "ping":
				_ = send(bridgeEnvelope{Type: "pong"})

			case "api_request":
				// Proxy to localhost:4749 (conductor backend).
				apiResp, apiErr := proxyAPI(opts.backendBaseURL, env.ID, env.Method, env.Path, env.Body)
				if apiErr != nil {
					_ = send(bridgeEnvelope{
						Type:   "api_response",
						ID:     env.ID,
						Status: 502,
						Body:   map[string]string{"error": apiErr.Error()},
					})
				} else {
					_ = send(bridgeEnvelope{
						Type:   "api_response",
						ID:     env.ID,
						Status: apiResp.Status,
						Body:   apiResp.Body,
					})
				}

			case "api_stream_request":
				requestID := strings.TrimSpace(env.ID)
				if requestID == "" {
					continue
				}
				streamCtx, streamCancel := context.WithCancel(ctx)
				handle := &apiStreamHandle{cancel: streamCancel}
				if previous := activeAPIStreams.register(requestID, handle); previous != nil {
					previous.cancel()
				}
				go func(request bridgeEnvelope, requestID string, handle *apiStreamHandle) {
					defer streamCancel()
					defer activeAPIStreams.removeIfMatch(requestID, handle)
					if err := proxyAPIStream(
						streamCtx,
						opts.backendBaseURL,
						send,
						requestID,
						request.Method,
						request.Path,
						request.Headers,
						request.Body,
					); err != nil && ctx.Err() == nil && streamCtx.Err() == nil {
						fmt.Fprintf(opts.stderr, "api stream proxy failed id=%s error=%v\n", requestID, err)
					}
				}(env, requestID, handle)

			case "api_stream_cancel":
				activeAPIStreams.cancel(strings.TrimSpace(env.ID))

			case "preview_request":
				previewResp, previewErr := proxyPreview(env.ID, env.SessionID, env.Method, env.URL, env.Headers, env.BodyBase64)
				if previewErr != nil {
					_ = send(bridgeEnvelope{
						Type:       "preview_response",
						ID:         env.ID,
						Status:     502,
						Headers:    map[string]string{"content-type": "text/plain; charset=utf-8"},
						BodyBase64: base64.StdEncoding.EncodeToString([]byte(previewErr.Error())),
					})
				} else {
					_ = send(bridgeEnvelope{
						Type:       "preview_response",
						ID:         env.ID,
						Status:     previewResp.Status,
						Headers:    previewResp.Headers,
						BodyBase64: previewResp.BodyBase64,
					})
				}

			case "file_browse":
				entries, browseErr := browseFiles(env.Path)
				response := bridgeEnvelope{
					Type:    "file_tree",
					Path:    env.Path,
					Entries: entries,
				}
				if browseErr != nil {
					response.Status = http.StatusBadRequest
					response.Body = map[string]string{"error": browseErr.Error()}
					response.Error = browseErr.Error()
					response.Entries = []any{}
				}
				_ = send(response)

			case "terminal_proxy_start":
				terminalID := strings.TrimSpace(env.TerminalID)
				sessionID := strings.TrimSpace(env.SessionID)
				if terminalID == "" || sessionID == "" {
					continue
				}
				if _, exists := activeTerminals.LoadOrStore(terminalID, struct{}{}); exists {
					continue
				}

				go func(terminalID string, sessionID string) {
					defer activeTerminals.Delete(terminalID)
					startedAt := time.Now()
					fmt.Fprintf(
						opts.stderr,
						"terminal proxy lifecycle event=start terminal_id=%s session_id=%s\n",
						terminalID,
						sessionID,
					)
					err := proxyTerminalSession(
						ctx,
						opts.relayURL,
						opts.refreshToken,
						terminalID,
						sessionID,
						opts.stderr,
					)
					if err != nil && ctx.Err() == nil {
						fmt.Fprintf(
							opts.stderr,
							"terminal proxy lifecycle event=end terminal_id=%s session_id=%s duration_ms=%d outcome=error error=%v\n",
							terminalID,
							sessionID,
							time.Since(startedAt).Milliseconds(),
							err,
						)
					} else {
						fmt.Fprintf(
							opts.stderr,
							"terminal proxy lifecycle event=end terminal_id=%s session_id=%s duration_ms=%d outcome=closed\n",
							terminalID,
							sessionID,
							time.Since(startedAt).Milliseconds(),
						)
					}
				}(terminalID, sessionID)

			case "bridge_status", "pong":
				// No-op.

			default:
				// Unknown message type — ignore.
			}
		}
	}()

	// ttyd → relay
	if ttydConn != nil {
		go func() {
			for {
				msgType, data, err := ttydConn.ReadMessage()
				if err != nil {
					fmt.Fprintf(opts.stderr, "ttyd mirror disconnected; continuing without the legacy direct terminal mirror: %v\n", err)
					stopTtyd()
					return
				}
				if msgType == websocket.TextMessage {
					// ttyd resize ACK or other control message — skip.
					continue
				}
				relayMu.Lock()
				err = relayConn.WriteMessage(websocket.BinaryMessage, data)
				relayMu.Unlock()
				if err != nil {
					errCh <- fmt.Errorf("ttyd->relay write: %w", err)
					return
				}
			}
		}()
	}

	// Heartbeat to relay.
	heartbeat := time.NewTicker(opts.heartbeatInterval)
	defer heartbeat.Stop()

	// Keep-alive loop: heartbeat + monitor errors.
	for {
		select {
		case <-ctx.Done():
			stopTtyd()
			return true, nil
		case err := <-errCh:
			stopTtyd()
			// The relay handshake and initial status message already succeeded.
			// Report that this attempt connected so Run resets exponential
			// backoff before retrying a dropped long-lived session.
			return true, err
		case <-heartbeat.C:
			if err := send(statusEnvelope()); err != nil {
				stopTtyd()
				return true, fmt.Errorf("send bridge_status: %w", err)
			}
			relayMu.Lock()
			err := relayConn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(2*time.Second))
			relayMu.Unlock()
			if err != nil {
				stopTtyd()
				return true, fmt.Errorf("relay ping: %w", err)
			}
		}
	}
}

func relayAuthHeaders(token string) http.Header {
	header := http.Header{}
	trimmed := strings.TrimSpace(token)
	if trimmed != "" {
		header.Set("Authorization", "Bearer "+trimmed)
	}
	return header
}

func websocketEndpoint(relayURL, scope string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(relayURL))
	if err != nil {
		return "", fmt.Errorf("parse relay URL: %w", err)
	}
	switch base.Scheme {
	case "ws", "wss":
	case "http":
		base.Scheme = "ws"
	case "https":
		base.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported relay URL scheme %q", base.Scheme)
	}
	base.Path = "/bridge/" + url.PathEscape(scope)
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func terminalBridgeEndpoint(relayURL, terminalID string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(relayURL))
	if err != nil {
		return "", fmt.Errorf("parse relay URL: %w", err)
	}
	switch base.Scheme {
	case "ws", "wss":
	case "http":
		base.Scheme = "ws"
	case "https":
		base.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported relay URL scheme %q", base.Scheme)
	}
	base.Path = "/terminal/" + url.PathEscape(strings.TrimSpace(terminalID)) + "/bridge"
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func resolveTerminalTokenPayload(body []byte, statusCode int) (string, backendTerminalProtocol, error) {
	var payload terminalTokenPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", &terminalAttachError{err: fmt.Errorf("decode terminal token response: %w", err)}
	}

	if statusCode < 200 || statusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("terminal token request failed with status %d", statusCode)
		}
		return "", "", &terminalAttachError{
			status: statusCode,
			err:    errors.New(message),
		}
	}

	rawURL := strings.TrimSpace(payload.WSURL)
	protocol := backendTerminalProtocolNative
	if rawURL == "" {
		rawURL = strings.TrimSpace(payload.TtydWSURL)
		protocol = backendTerminalProtocolTTYD
	}
	if rawURL == "" {
		return "", "", &terminalAttachError{err: errors.New("terminal token response missing websocket url")}
	}

	base, _ := url.Parse("http://127.0.0.1:4749")
	resolved, err := base.Parse(rawURL)
	if err != nil {
		return "", "", &terminalAttachError{err: fmt.Errorf("parse terminal websocket url: %w", err)}
	}

	switch resolved.Scheme {
	case "http":
		resolved.Scheme = "ws"
	case "https":
		resolved.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", "", &terminalAttachError{err: fmt.Errorf("unsupported terminal websocket scheme %q", resolved.Scheme)}
	}

	if protocol == backendTerminalProtocolNative && !isLoopbackHostname(resolved.Hostname()) {
		return "", "", &terminalAttachError{err: fmt.Errorf("native terminal websocket host %q is not allowed", resolved.Hostname())}
	}
	if protocol == backendTerminalProtocolTTYD && !isLoopbackHostname(resolved.Hostname()) {
		return "", "", &terminalAttachError{err: fmt.Errorf("ttyd terminal websocket host %q is not allowed", resolved.Hostname())}
	}

	return resolved.String(), protocol, nil
}

func fetchSessionTerminalWSURL(sessionID string) (string, backendTerminalProtocol, error) {
	if strings.TrimSpace(sessionID) == "" {
		return "", "", fmt.Errorf("session id is required")
	}

	endpoint := fmt.Sprintf(
		"http://127.0.0.1:4749/api/sessions/%s/terminal/token",
		url.PathEscape(strings.TrimSpace(sessionID)),
	)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", fmt.Errorf("build terminal token request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", &terminalAttachError{err: fmt.Errorf("request terminal token: %w", err)}
	}
	defer resp.Body.Close()

	body, err := readAllBounded(resp.Body, maxTerminalTokenResponseBytes, "terminal token response")
	if err != nil {
		return "", "", &terminalAttachError{err: fmt.Errorf("read terminal token response: %w", err)}
	}

	return resolveTerminalTokenPayload(body, resp.StatusCode)
}

func shouldRetryTerminalAttach(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var attachErr *terminalAttachError
	if errors.As(err, &attachErr) {
		if attachErr.status == 0 {
			return true
		}
		switch attachErr.status {
		case http.StatusConflict, http.StatusBadGateway, http.StatusGatewayTimeout, http.StatusServiceUnavailable:
			return true
		default:
			return false
		}
	}

	return false
}

func connectBackendTerminal(
	ctx context.Context,
	sessionID string,
	terminalID string,
	stderr io.Writer,
) (*websocket.Conn, backendTerminalProtocol, error) {
	var lastErr error
	backoff := 250 * time.Millisecond

	for attempt := 0; attempt < terminalAttachMaxAttempts; attempt++ {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}

		fmt.Fprintf(
			stderr,
			"terminal proxy lifecycle event=backend_attach_attempt terminal_id=%s session_id=%s attempt=%d max_attempts=%d\n",
			terminalID,
			sessionID,
			attempt+1,
			terminalAttachMaxAttempts,
		)
		backendEndpoint, protocol, err := fetchSessionTerminalWSURL(sessionID)
		if err == nil {
			conn, _, dialErr := websocket.DefaultDialer.DialContext(ctx, backendEndpoint, nil)
			if dialErr == nil {
				fmt.Fprintf(
					stderr,
					"terminal proxy lifecycle event=backend_attached terminal_id=%s session_id=%s attempt=%d protocol=%s\n",
					terminalID,
					sessionID,
					attempt+1,
					protocol,
				)
				return conn, protocol, nil
			}
			err = &terminalAttachError{err: fmt.Errorf("connect backend terminal socket: %w", dialErr)}
		}

		lastErr = err
		willRetry := shouldRetryTerminalAttach(err) && attempt < terminalAttachMaxAttempts-1
		fmt.Fprintf(
			stderr,
			"terminal proxy lifecycle event=backend_attach_failed terminal_id=%s session_id=%s attempt=%d retry=%t error=%v\n",
			terminalID,
			sessionID,
			attempt+1,
			willRetry,
			err,
		)
		if !willRetry {
			break
		}

		if ensureErr := ensureLocalBackendForProxy(ctx); ensureErr != nil {
			lastErr = ensureErr
			break
		}

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, "", ctx.Err()
		case <-timer.C:
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}

	if lastErr == nil {
		lastErr = errors.New("backend terminal connection failed")
	}
	return nil, "", lastErr
}

func writeNativeTerminalMessage(conn *websocket.Conn, payload nativeTerminalClientMessage) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode native terminal message: %w", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, encoded); err != nil {
		return fmt.Errorf("write native terminal message: %w", err)
	}
	return nil
}

func parseRelayResizeMessage(payload []byte) (int, int, error) {
	var resize relayResizePayload
	if err := json.Unmarshal(payload, &resize); err != nil {
		return 0, 0, fmt.Errorf("decode relay resize message: %w", err)
	}
	if resize.Columns <= 0 || resize.Rows <= 0 {
		return 0, 0, fmt.Errorf("relay resize message missing terminal dimensions")
	}
	return resize.Columns, resize.Rows, nil
}

func terminalWebSocketReadError(peer string, err error) error {
	if websocket.IsCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	) {
		return io.EOF
	}
	return fmt.Errorf("%s read: %w", peer, err)
}

func proxyTTYDTerminalSession(ctx context.Context, backendConn *websocket.Conn, relayConn *websocket.Conn) error {
	errCh := make(chan error, 2)

	forward := func(srcName string, src *websocket.Conn, dstName string, dst *websocket.Conn) {
		go func() {
			for {
				msgType, data, err := src.ReadMessage()
				if err != nil {
					errCh <- terminalWebSocketReadError(srcName, err)
					return
				}
				switch msgType {
				case websocket.TextMessage, websocket.BinaryMessage:
					if err := dst.WriteMessage(msgType, data); err != nil {
						errCh <- fmt.Errorf("%s write: %w", dstName, err)
						return
					}
				case websocket.CloseMessage:
					_ = dst.WriteMessage(websocket.CloseMessage, data)
					errCh <- io.EOF
					return
				}
			}
		}()
	}

	forward("relay terminal", relayConn, "backend terminal", backendConn)
	forward("backend terminal", backendConn, "relay terminal", relayConn)

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		if err == io.EOF {
			return nil
		}
		return err
	}
}

func proxyNativeTerminalSession(ctx context.Context, backendConn *websocket.Conn, relayConn *websocket.Conn) error {
	errCh := make(chan error, 2)

	go func() {
		helloSent := false
		cols := 120
		rows := 32
		for {
			msgType, data, err := relayConn.ReadMessage()
			if err != nil {
				errCh <- terminalWebSocketReadError("relay terminal", err)
				return
			}
			switch msgType {
			case websocket.BinaryMessage:
				if len(data) == 0 {
					continue
				}
				command := data[0]
				payload := data[1:]
				switch command {
				case '1':
					nextCols, nextRows, err := parseRelayResizeMessage(payload)
					if err != nil {
						continue
					}
					cols = nextCols
					rows = nextRows
					messageType := "resize"
					if !helloSent {
						messageType = "hello"
						helloSent = true
					}
					if err := writeNativeTerminalMessage(backendConn, nativeTerminalClientMessage{
						Type: messageType,
						Cols: cols,
						Rows: rows,
					}); err != nil {
						errCh <- fmt.Errorf("backend terminal write: %w", err)
						return
					}
				case '0':
					if !helloSent {
						if err := writeNativeTerminalMessage(backendConn, nativeTerminalClientMessage{
							Type: "hello",
							Cols: cols,
							Rows: rows,
						}); err != nil {
							errCh <- fmt.Errorf("backend terminal write: %w", err)
							return
						}
						helloSent = true
					}
					if len(payload) == 0 {
						continue
					}
					if err := writeNativeTerminalMessage(backendConn, nativeTerminalClientMessage{
						Type: "input",
						Data: string(payload),
					}); err != nil {
						errCh <- fmt.Errorf("backend terminal write: %w", err)
						return
					}
				case '2', '3':
					continue
				default:
					continue
				}
			case websocket.TextMessage:
				nextCols, nextRows, err := parseRelayResizeMessage(data)
				if err != nil {
					continue
				}
				cols = nextCols
				rows = nextRows
				messageType := "resize"
				if !helloSent {
					messageType = "hello"
					helloSent = true
				}
				if err := writeNativeTerminalMessage(backendConn, nativeTerminalClientMessage{
					Type: messageType,
					Cols: cols,
					Rows: rows,
				}); err != nil {
					errCh <- fmt.Errorf("backend terminal write: %w", err)
					return
				}
			case websocket.CloseMessage:
				_ = backendConn.WriteMessage(websocket.CloseMessage, data)
				errCh <- io.EOF
				return
			}
		}
	}()

	go func() {
		for {
			msgType, data, err := backendConn.ReadMessage()
			if err != nil {
				errCh <- terminalWebSocketReadError("backend terminal", err)
				return
			}
			switch msgType {
			case websocket.TextMessage:
				if err := relayConn.WriteMessage(websocket.TextMessage, data); err != nil {
					errCh <- fmt.Errorf("relay terminal write: %w", err)
					return
				}
			case websocket.BinaryMessage:
				frame := make([]byte, 1+len(data))
				frame[0] = '0'
				copy(frame[1:], data)
				if err := relayConn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					errCh <- fmt.Errorf("relay terminal write: %w", err)
					return
				}
			case websocket.CloseMessage:
				_ = relayConn.WriteMessage(websocket.CloseMessage, data)
				errCh <- io.EOF
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		if err == io.EOF {
			return nil
		}
		return err
	}
}

func proxyTerminalSession(
	ctx context.Context,
	relayURL string,
	refreshToken string,
	terminalID string,
	sessionID string,
	stderr io.Writer,
) error {
	backendConn, protocol, err := connectBackendTerminal(ctx, sessionID, terminalID, stderr)
	if err != nil {
		return err
	}
	defer backendConn.Close()
	backendConn.SetReadLimit(maxBridgeWebSocketMessageBytes)

	relayEndpoint, err := terminalBridgeEndpoint(relayURL, terminalID)
	if err != nil {
		return err
	}

	relayConn, _, err := websocket.DefaultDialer.DialContext(ctx, relayEndpoint, relayAuthHeaders(refreshToken))
	if err != nil {
		return fmt.Errorf("connect relay terminal socket: %w", err)
	}
	defer relayConn.Close()
	relayConn.SetReadLimit(maxBridgeWebSocketMessageBytes)
	fmt.Fprintf(
		stderr,
		"terminal proxy lifecycle event=relay_attached terminal_id=%s session_id=%s protocol=%s\n",
		terminalID,
		sessionID,
		protocol,
	)

	if protocol == backendTerminalProtocolTTYD {
		return proxyTTYDTerminalSession(ctx, backendConn, relayConn)
	}
	return proxyNativeTerminalSession(ctx, backendConn, relayConn)
}

type apiResponse struct {
	Status int
	Body   interface{}
}

type previewResponse struct {
	Status     int
	Headers    map[string]string
	BodyBase64 string
}

func isLoopbackHostname(hostname string) bool {
	normalized := strings.Trim(strings.ToLower(strings.TrimSpace(hostname)), "[]")
	normalized = strings.TrimSuffix(normalized, ".")
	switch normalized {
	case "127.0.0.1", "localhost", "::1", "0.0.0.0":
		return true
	default:
		return false
	}
}

func normalizePreviewURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("parse preview url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("preview url scheme %q is not allowed", parsed.Scheme)
	}
	if !isLoopbackHostname(parsed.Hostname()) {
		return nil, fmt.Errorf("preview host %q is not allowed", parsed.Hostname())
	}
	if parsed.Hostname() == "0.0.0.0" {
		parsed.Host = strings.Replace(parsed.Host, "0.0.0.0", "127.0.0.1", 1)
	}
	return parsed, nil
}

func sanitizePreviewRequestHeaders(headers map[string]string) http.Header {
	sanitized := http.Header{}
	for name, value := range headers {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "", "host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding":
			continue
		default:
			sanitized.Set(name, value)
		}
	}
	return sanitized
}

func sanitizePreviewResponseHeaders(headers http.Header) map[string]string {
	sanitized := map[string]string{}
	for name, values := range headers {
		if len(values) == 0 {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding":
			continue
		default:
			sanitized[name] = values[len(values)-1]
		}
	}
	return sanitized
}

func decodeProxyRequestBody(body interface{}) ([]byte, string, bool, error) {
	payload, ok := body.(map[string]interface{})
	if !ok {
		return nil, "", false, nil
	}

	metaRaw, ok := payload[bridgeRequestMetaKey]
	if !ok {
		return nil, "", false, nil
	}

	meta, ok := metaRaw.(map[string]interface{})
	if !ok {
		return nil, "", true, fmt.Errorf("invalid bridge request metadata")
	}

	kind, _ := meta["kind"].(string)
	if kind != "bytes" {
		return nil, "", true, fmt.Errorf("unsupported bridge request kind %q", kind)
	}

	encoded, _ := meta["base64"].(string)
	if strings.TrimSpace(encoded) == "" {
		return nil, "", true, fmt.Errorf("missing bridge request payload")
	}

	decoded, err := decodeBase64Bounded(encoded, maxProxyRequestBodyBytes, "bridge request payload")
	if err != nil {
		return nil, "", true, err
	}

	contentType, _ := meta["contentType"].(string)
	return decoded, strings.TrimSpace(contentType), true, nil
}

func proxyPreview(
	id string,
	sessionID string,
	method string,
	rawURL string,
	headers map[string]string,
	bodyBase64 string,
) (previewResponse, error) {
	if strings.TrimSpace(id) == "" {
		return previewResponse{}, fmt.Errorf("preview request id is required")
	}
	if strings.TrimSpace(sessionID) == "" {
		return previewResponse{}, fmt.Errorf("preview session id is required")
	}

	targetURL, err := normalizePreviewURL(rawURL)
	if err != nil {
		return previewResponse{}, err
	}

	method, err = normalizeHTTPMethod(method)
	if err != nil {
		return previewResponse{}, err
	}

	var requestBody io.Reader
	if strings.TrimSpace(bodyBase64) != "" {
		decoded, err := decodeBase64Bounded(bodyBase64, maxPreviewRequestBodyBytes, "preview body")
		if err != nil {
			return previewResponse{}, err
		}
		requestBody = bytes.NewReader(decoded)
	}

	req, err := http.NewRequest(method, targetURL.String(), requestBody)
	if err != nil {
		return previewResponse{}, err
	}
	req.Header = sanitizePreviewRequestHeaders(headers)

	client := loopbackOnlyHTTPClient(20 * time.Second)

	// lgtm[go/request-forgery] Preview targets are normalized to HTTP(S) loopback URLs and the client dialer rejects non-loopback destinations.
	resp, err := client.Do(req)
	if err != nil {
		return previewResponse{}, err
	}
	defer resp.Body.Close()

	responseBytes, err := readAllBounded(resp.Body, maxPreviewResponseBytes, "preview response")
	if err != nil {
		return previewResponse{}, err
	}

	return previewResponse{
		Status:     resp.StatusCode,
		Headers:    sanitizePreviewResponseHeaders(resp.Header),
		BodyBase64: base64.StdEncoding.EncodeToString(responseBytes),
	}, nil
}

func sendAPIStreamFailureResponse(send func(bridgeEnvelope) error, id string, status int, message string) error {
	if err := send(bridgeEnvelope{
		Type:    "api_stream_start",
		ID:      id,
		Status:  status,
		Headers: map[string]string{"content-type": "application/json"},
	}); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"error": message})
	if err != nil {
		return fmt.Errorf("encode api stream failure response: %w", err)
	}
	if err := send(bridgeEnvelope{
		Type:        "api_stream_chunk",
		ID:          id,
		ChunkBase64: base64.StdEncoding.EncodeToString(body),
	}); err != nil {
		return err
	}
	return send(bridgeEnvelope{
		Type: "api_stream_end",
		ID:   id,
	})
}

func proxyAPIStream(
	ctx context.Context,
	backendBaseURL string,
	send func(bridgeEnvelope) error,
	id string,
	method string,
	path string,
	headers map[string]string,
	body interface{},
) error {
	requestBodyBytes, contentType, err := encodeProxyRequestBody(body)
	if err != nil {
		return sendAPIStreamFailureResponse(send, id, http.StatusBadGateway, err.Error())
	}

	sanitizedHeaders, err := sanitizeProxyRequestHeaders(headers)
	if err != nil {
		return sendAPIStreamFailureResponse(send, id, http.StatusBadGateway, err.Error())
	}
	if len(requestBodyBytes) > 0 && sanitizedHeaders.Get("content-type") == "" && contentType != "" {
		sanitizedHeaders.Set("content-type", contentType)
	}

	resp, err := doBackendAPIStreamRequest(ctx, backendBaseURL, method, path, requestBodyBytes, sanitizedHeaders)
	if err != nil && shouldRetryAfterEnsuringBackend(err) {
		if ensureErr := ensureLocalBackendForProxy(ctx); ensureErr != nil {
			return sendAPIStreamFailureResponse(send, id, http.StatusBadGateway, ensureErr.Error())
		}
		resp, err = doBackendAPIStreamRequest(ctx, backendBaseURL, method, path, requestBodyBytes, sanitizedHeaders)
	}
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return sendAPIStreamFailureResponse(send, id, http.StatusBadGateway, err.Error())
	}
	defer resp.Body.Close()

	if err := send(bridgeEnvelope{
		Type:    "api_stream_start",
		ID:      id,
		Status:  resp.StatusCode,
		Headers: sanitizeProxyResponseHeaders(resp.Header),
	}); err != nil {
		return err
	}

	buffer := make([]byte, maxAPIStreamChunkBytes)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			if err := send(bridgeEnvelope{
				Type:        "api_stream_chunk",
				ID:          id,
				ChunkBase64: base64.StdEncoding.EncodeToString(chunk),
			}); err != nil {
				return err
			}
		}
		if readErr == nil {
			continue
		}
		if readErr == io.EOF {
			return send(bridgeEnvelope{
				Type: "api_stream_end",
				ID:   id,
			})
		}
		if ctx.Err() != nil || errors.Is(readErr, context.Canceled) || errors.Is(readErr, context.DeadlineExceeded) {
			return nil
		}
		return send(bridgeEnvelope{
			Type:  "api_stream_end",
			ID:    id,
			Error: readErr.Error(),
		})
	}
}

func proxyAPI(backendBaseURL, id, method, path string, body interface{}) (apiResponse, error) {
	if handled, resp := maybeHandleBridgeControlRequest(method, path, body); handled {
		return resp, nil
	}

	if path == "" {
		path = "/"
	}

	// Proxy to local conductor backend at localhost:4749.
	requestBodyBytes, contentType, err := encodeProxyRequestBody(body)
	if err != nil {
		return apiResponse{Status: 0, Body: nil}, err
	}

	resp, err := doBackendAPIRequest(backendBaseURL, method, path, requestBodyBytes, contentType)
	if err != nil && shouldRetryAfterEnsuringBackend(err) {
		if ensureErr := ensureLocalBackendForProxy(context.Background()); ensureErr != nil {
			return apiResponse{Status: http.StatusBadGateway, Body: map[string]any{
				"error": ensureErr.Error(),
			}}, ensureErr
		}
		resp, err = doBackendAPIRequest(backendBaseURL, method, path, requestBodyBytes, contentType)
	}
	if err != nil {
		return apiResponse{Status: http.StatusBadGateway, Body: map[string]any{
			"error": err.Error(),
		}}, err
	}
	defer resp.Body.Close()

	responseBytes, err := readAllBounded(resp.Body, maxBackendResponseBytes, "backend response")
	if err != nil {
		return apiResponse{Status: resp.StatusCode, Body: map[string]any{
			"error": err.Error(),
		}}, nil
	}

	responseContentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if len(responseBytes) == 0 {
		return apiResponse{Status: resp.StatusCode, Body: map[string]any{}}, nil
	}

	if strings.Contains(strings.ToLower(responseContentType), "application/json") && json.Valid(responseBytes) {
		return apiResponse{Status: resp.StatusCode, Body: json.RawMessage(responseBytes)}, nil
	}

	if strings.HasPrefix(strings.ToLower(responseContentType), "text/") {
		return apiResponse{
			Status: resp.StatusCode,
			Body: map[string]any{
				bridgeProxyMetaKey: map[string]any{
					"kind":        "text",
					"text":        string(responseBytes),
					"contentType": responseContentType,
				},
			},
		}, nil
	}

	return apiResponse{
		Status: resp.StatusCode,
		Body: map[string]any{
			bridgeProxyMetaKey: map[string]any{
				"kind":        "bytes",
				"base64":      base64.StdEncoding.EncodeToString(responseBytes),
				"contentType": responseContentType,
			},
		},
	}, nil
}

func maybeHandleBridgeControlRequest(method, path string, body interface{}) (bool, apiResponse) {
	switch normalizeProxyAPIPath(path) {
	case bridgeServiceRestartPath:
		return handleBridgeServiceRestartRequest(method)
	case bridgeInstallPath:
		return handleBridgeInstallRequest(method, body)
	default:
		return false, apiResponse{}
	}
}

func handleBridgeServiceRestartRequest(method string) (bool, apiResponse) {
	if strings.TrimSpace(method) != http.MethodPost {
		return true, apiResponse{
			Status: http.StatusMethodNotAllowed,
			Body: map[string]any{
				"error": "Bridge service restart only supports POST.",
			},
		}
	}

	if err := install.RestartServiceAvailable(); err != nil {
		return true, apiResponse{
			Status: http.StatusBadRequest,
			Body: map[string]any{
				"error": err.Error(),
			},
		}
	}

	go func() {
		time.Sleep(600 * time.Millisecond)
		if err := install.RestartServiceIfInstalled(); err != nil {
			fmt.Fprintf(os.Stderr, "bridge service restart failed: %v\n", err)
		}
	}()

	return true, apiResponse{
		Status: http.StatusAccepted,
		Body: map[string]any{
			"ok":      true,
			"message": "Bridge service restart scheduled. This laptop should reconnect once the bridge is back online.",
		},
	}
}

func handleBridgeInstallRequest(method string, body interface{}) (bool, apiResponse) {
	if strings.TrimSpace(method) != http.MethodPost {
		return true, apiResponse{
			Status: http.StatusMethodNotAllowed,
			Body: map[string]any{
				"error": "Bridge install only supports POST.",
			},
		}
	}

	installScriptURL, err := decodeBridgeInstallScriptURL(body)
	if err != nil {
		return true, apiResponse{
			Status: http.StatusBadRequest,
			Body: map[string]any{
				"error": err.Error(),
			},
		}
	}

	go func() {
		time.Sleep(600 * time.Millisecond)
		if err := runBridgeInstallScript(installScriptURL); err != nil {
			fmt.Fprintf(os.Stderr, "bridge install failed: %v\n", err)
		}
	}()

	return true, apiResponse{
		Status: http.StatusAccepted,
		Body: map[string]any{
			"ok":      true,
			"message": "Bridge reinstall requested. This laptop should reconnect shortly.",
		},
	}
}

func backendRequestTimeout(path string) time.Duration {
	switch path {
	case "/api/filesystem/pick-directory":
		return 5 * time.Minute
	case "/api/filesystem/directory":
		return 60 * time.Second
	default:
		return 20 * time.Second
	}
}

func resolveLocalConductorVersion() string {
	backendURL := strings.TrimSpace(os.Getenv("CONDUCTOR_BACKEND_URL"))
	if backendURL == "" {
		backendURL = "http://127.0.0.1:4749"
	}

	healthURL, err := url.Parse(backendURL)
	if err != nil {
		return ""
	}
	healthURL.Path = "/api/health"
	healthURL.RawQuery = ""
	healthURL.Fragment = ""

	req, err := http.NewRequest(http.MethodGet, healthURL.String(), nil)
	if err != nil {
		return ""
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}

	var payload backendHealthPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ""
	}

	return strings.TrimSpace(payload.Version)
}

func doBackendAPIRequest(backendBaseURL, method, path string, requestBodyBytes []byte, contentType string) (*http.Response, error) {
	backendURL, err := buildLocalBackendURLWithBase(backendBaseURL, path)
	if err != nil {
		return nil, err
	}
	method, err = normalizeHTTPMethod(method)
	if err != nil {
		return nil, err
	}
	var requestBody io.Reader
	if len(requestBodyBytes) > 0 {
		requestBody = bytes.NewReader(requestBodyBytes)
	}

	req, err := http.NewRequest(method, backendURL.String(), requestBody)
	if err != nil {
		return nil, err
	}
	if len(requestBodyBytes) > 0 {
		req.Header.Set("Content-Type", contentType)
	}

	client := &http.Client{
		Timeout: backendRequestTimeout(backendURL.Path),
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return client.Do(req)
}

func doBackendAPIStreamRequest(
	ctx context.Context,
	backendBaseURL string,
	method string,
	path string,
	requestBodyBytes []byte,
	headers http.Header,
) (*http.Response, error) {
	backendURL, err := buildLocalBackendURLWithBase(backendBaseURL, path)
	if err != nil {
		return nil, err
	}
	method, err = normalizeHTTPMethod(method)
	if err != nil {
		return nil, err
	}

	var requestBody io.Reader
	if len(requestBodyBytes) > 0 {
		requestBody = bytes.NewReader(requestBodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, backendURL.String(), requestBody)
	if err != nil {
		return nil, err
	}
	req.Header = headers.Clone()

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return client.Do(req)
}

func ensureLocalBackendForProxy(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-backendEnsureGate:
	}
	defer func() { backendEnsureGate <- struct{}{} }()

	_, err := backend.Ensure(ctx, backend.Options{
		Stderr:         os.Stderr,
		StartupTimeout: 45 * time.Second,
	})
	return err
}

func allowedBridgeInstallHosts() map[string]struct{} {
	hosts := map[string]struct{}{
		"app.conductross.com": {},
		"conductross.com":     {},
		"localhost":           {},
		"127.0.0.1":           {},
		"::1":                 {},
	}
	for _, raw := range strings.Split(os.Getenv(bridgeInstallHostsEnv), ",") {
		host := strings.TrimSuffix(strings.Trim(strings.ToLower(strings.TrimSpace(raw)), "[]"), ".")
		if host != "" {
			hosts[host] = struct{}{}
		}
	}
	return hosts
}

func validateBridgeInstallScriptURL(parsed *url.URL) error {
	if parsed == nil || parsed.Hostname() == "" {
		return fmt.Errorf("installScriptUrl must include a host")
	}
	if parsed.User != nil {
		return fmt.Errorf("installScriptUrl must not include credentials")
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("installScriptUrl must not include a fragment")
	}
	host := strings.TrimSuffix(strings.Trim(strings.ToLower(strings.TrimSpace(parsed.Hostname())), "[]"), ".")
	if parsed.Scheme != "https" {
		if !(parsed.Scheme == "http" && isLoopbackHostname(host)) {
			return fmt.Errorf("installScriptUrl scheme %q is not allowed", parsed.Scheme)
		}
	}
	if _, ok := allowedBridgeInstallHosts()[host]; !ok {
		return fmt.Errorf("installScriptUrl host %q is not allowed; set %s to allow self-hosted repair URLs", parsed.Hostname(), bridgeInstallHostsEnv)
	}
	if parsed.Path != "/bridge/install.sh" && parsed.Path != "/bridge/install.ps1" {
		return fmt.Errorf("installScriptUrl path %q is not allowed", parsed.Path)
	}
	return nil
}

func decodeBridgeInstallScriptURL(body interface{}) (string, error) {
	bodyMap, ok := body.(map[string]interface{})
	if !ok || bodyMap == nil {
		return "", fmt.Errorf("missing bridge install payload")
	}

	value, ok := bodyMap["installScriptUrl"]
	if !ok {
		return "", fmt.Errorf("missing installScriptUrl")
	}

	installScriptURL, ok := value.(string)
	if !ok || strings.TrimSpace(installScriptURL) == "" {
		return "", fmt.Errorf("invalid installScriptUrl")
	}

	parsed, err := url.Parse(strings.TrimSpace(installScriptURL))
	if err != nil {
		return "", fmt.Errorf("parse installScriptUrl: %w", err)
	}
	if err := validateBridgeInstallScriptURL(parsed); err != nil {
		return "", err
	}

	return parsed.String(), nil
}

func runBridgeInstallScript(installScriptURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(installScriptURL))
	if err != nil {
		return fmt.Errorf("parse install script URL: %w", err)
	}
	if err := validateBridgeInstallScriptURL(parsed); err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return fmt.Errorf("build install script request: %w", err)
	}

	client := &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	// lgtm[go/request-forgery] Install script URLs are restricted to allowed hosts, safe paths, and HTTPS or loopback HTTP before dispatch.
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download install script: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("download install script failed with status %d", response.StatusCode)
	}

	scriptBytes, err := readAllBounded(response.Body, maxBridgeInstallScriptBytes, "install script")
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(scriptBytes)) == 0 {
		return fmt.Errorf("install script is empty")
	}

	if runtime.GOOS == "windows" {
		tempFile, err := os.CreateTemp("", "conductor-bridge-install-*.ps1")
		if err != nil {
			return fmt.Errorf("create temporary PowerShell install script: %w", err)
		}
		tempPath := tempFile.Name()
		defer os.Remove(tempPath)

		if _, err := tempFile.Write(scriptBytes); err != nil {
			tempFile.Close()
			return fmt.Errorf("write temporary PowerShell install script: %w", err)
		}
		if err := tempFile.Close(); err != nil {
			return fmt.Errorf("close temporary PowerShell install script: %w", err)
		}

		commandPath := "powershell.exe"
		if systemRoot := strings.TrimSpace(os.Getenv("SystemRoot")); systemRoot != "" {
			candidate := filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			if _, statErr := os.Stat(candidate); statErr == nil {
				commandPath = candidate
			}
		}

		command := exec.Command(commandPath, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempPath)
		command.Stdout = os.Stderr
		command.Stderr = os.Stderr
		command.Env = os.Environ()

		if err := command.Run(); err != nil {
			return fmt.Errorf("run PowerShell install script: %w", err)
		}

		return nil
	}

	command := exec.Command("sh", "-s", "--")
	command.Stdin = bytes.NewReader(scriptBytes)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	command.Env = os.Environ()

	if err := command.Run(); err != nil {
		return fmt.Errorf("run install script: %w", err)
	}

	return nil
}

func shouldRetryAfterEnsuringBackend(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return shouldRetryAfterEnsuringBackend(urlErr.Err)
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return true
	}

	return strings.Contains(strings.ToLower(err.Error()), "connection refused")
}

func normalizeProxyAPIPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}

	parsed, err := url.ParseRequestURI(trimmed)
	if err != nil || parsed.Path == "" {
		return trimmed
	}

	return parsed.Path
}

type fileEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func normalizeFileBrowseRoot(root string) (string, error) {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		return "", fmt.Errorf("empty file browse root")
	}
	expanded := trimmed
	if strings.HasPrefix(expanded, "~/") || expanded == "~" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			expanded = filepath.Join(home, strings.TrimPrefix(expanded, "~/"))
		}
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		abs = resolved
	}
	return filepath.Clean(abs), nil
}

func allowedFileBrowseRoots() []string {
	seen := map[string]struct{}{}
	var roots []string
	add := func(raw string) {
		root, err := normalizeFileBrowseRoot(raw)
		if err != nil || root == string(filepath.Separator) {
			return
		}
		if _, ok := seen[root]; !ok {
			seen[root] = struct{}{}
			roots = append(roots, root)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		add(home)
	}
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		add(cwd)
	}
	for _, raw := range strings.Split(os.Getenv(bridgeFileRootsEnv), string(os.PathListSeparator)) {
		add(raw)
	}
	return roots
}

func isPathWithinRoot(path string, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func resolveFileBrowseDir(dir string) (string, error) {
	roots := allowedFileBrowseRoots()
	if len(roots) == 0 {
		return "", fmt.Errorf("no file browse roots are configured")
	}
	trimmed := strings.TrimSpace(dir)
	if trimmed == "" {
		return roots[0], nil
	}
	if strings.ContainsAny(trimmed, "\x00\r\n") {
		return "", fmt.Errorf("file browse path contains invalid characters")
	}
	if !filepath.IsAbs(trimmed) {
		trimmed = filepath.Join(roots[0], trimmed)
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		abs = resolved
	}
	cleaned := filepath.Clean(abs)
	for _, root := range roots {
		if isPathWithinRoot(cleaned, root) {
			return cleaned, nil
		}
	}
	return "", fmt.Errorf("file browse path is outside allowed roots; set %s to add roots", bridgeFileRootsEnv)
}

func browseFiles(dir string) ([]any, error) {
	resolvedDir, err := resolveFileBrowseDir(dir)
	if err != nil {
		return nil, err
	}
	// lgtm[go/path-injection] File browse paths are canonicalized, symlink-resolved, and constrained to configured allowed roots.
	dirHandle, err := os.Open(resolvedDir)
	if err != nil {
		return nil, err
	}
	defer dirHandle.Close()

	entries, err := dirHandle.ReadDir(maxFileBrowseEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > maxFileBrowseEntries {
		entries = entries[:maxFileBrowseEntries]
	}
	var result []any
	for _, e := range entries {
		kind := "file"
		if e.IsDir() {
			kind = "dir"
		}
		result = append(result, fileEntry{Name: e.Name(), Kind: kind})
	}
	return result, nil
}
