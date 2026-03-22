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
	"strings"
	"sync"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/backend"
	"github.com/charannyk06/conductor-oss/bridge/install"
	"github.com/gorilla/websocket"
)

const (
	defaultScope             = "conductor-bridge-control"
	defaultHeartbeatInterval = 30 * time.Second
	maxReconnectBackoff      = 30 * time.Second
	ttydPortRangeStart       = 7681
	ttydPortRangeEnd         = 8699
	bridgeProxyMetaKey       = "$bridgeProxy"
	bridgeRequestMetaKey     = "$bridgeRequest"
	bridgeServiceRestartPath = "/_bridge/service/restart"
	maxPreviewResponseBytes  = 10 * 1024 * 1024
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
	ID         string            `json:"id,omitempty"`
	Method     string            `json:"method,omitempty"`
	Path       string            `json:"path,omitempty"`
	URL        string            `json:"url,omitempty"`
	Status     int               `json:"status,omitempty"`
	Body       interface{}       `json:"body,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	BodyBase64 string            `json:"body_base64,omitempty"`

	// terminal_proxy_start
	TerminalID string `json:"terminal_id,omitempty"`
	SessionID  string `json:"session_id,omitempty"`

	// file_browse / file_tree
	Entries []any `json:"entries,omitempty"`

	// terminal_resize
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`

	// bridge_status
	Hostname  string `json:"hostname,omitempty"`
	OS        string `json:"os,omitempty"`
	Connected bool   `json:"connected,omitempty"`
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

	backoff := time.Second
	for {
		connected, err := runSession(ctx, sessionOptions{
			relayURL:          opts.RelayURL,
			refreshToken:      opts.RefreshToken,
			scope:             scope,
			hostname:          hostname,
			osName:            osName,
			stderr:            stderr,
			heartbeatInterval: heartbeat,
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
	stderr            io.Writer
	heartbeatInterval time.Duration
}

var backendEnsureMu sync.Mutex

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
	return "", fmt.Errorf("ttyd not found in PATH or common locations; install: brew install ttyd")
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
	if ttydPath, err := findTtyd(); err == nil {
		port, err := findFreePort()
		if err != nil {
			fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", err)
		} else {
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
						ttydConn = ttydWS
					}
				}
			}
		}
	} else {
		fmt.Fprintf(opts.stderr, "ttyd unavailable; bridge will stay online without the legacy direct terminal mirror: %v\n", err)
	}

	// 2. Connect to relay.
	relayEndpoint, err := websocketEndpoint(opts.relayURL, opts.scope, opts.refreshToken)
	if err != nil {
		stopTtyd()
		return false, fmt.Errorf("build relay endpoint: %w", err)
	}
	relayConn, _, err := websocket.DefaultDialer.DialContext(ctx, relayEndpoint, nil)
	if err != nil {
		stopTtyd()
		return false, fmt.Errorf("dial relay: %w", err)
	}
	defer relayConn.Close()
	defer stopTtyd()

	// 3. Tell relay we are connected and ready.
	var relayMu sync.Mutex
	send := func(env bridgeEnvelope) error {
		data, _ := json.Marshal(env)
		relayMu.Lock()
		defer relayMu.Unlock()
		return relayConn.WriteMessage(websocket.TextMessage, data)
	}
	if err := send(bridgeEnvelope{
		Type:      "bridge_status",
		Hostname:  opts.hostname,
		OS:        opts.osName,
		Connected: true,
	}); err != nil {
		stopTtyd()
		return false, fmt.Errorf("send bridge_status: %w", err)
	}

	// 4. Bidirectional bridge loop.
	errCh := make(chan error, 2)
	var activeTerminals sync.Map

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
				apiResp, apiErr := proxyAPI(env.ID, env.Method, env.Path, env.Body)
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
				entries, _ := browseFiles(env.Path)
				_ = send(bridgeEnvelope{
					Type:    "file_tree",
					Path:    env.Path,
					Entries: entries,
				})

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
					if err := proxyTerminalSession(
						ctx,
						opts.relayURL,
						opts.refreshToken,
						terminalID,
						sessionID,
					); err != nil && ctx.Err() == nil {
						fmt.Fprintf(opts.stderr, "terminal proxy %s ended: %v\n", terminalID, err)
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
			return false, err
		case <-heartbeat.C:
			if err := send(bridgeEnvelope{
				Type:      "bridge_status",
				Hostname:  opts.hostname,
				OS:        opts.osName,
				Connected: true,
			}); err != nil {
				stopTtyd()
				return false, fmt.Errorf("send bridge_status: %w", err)
			}
			relayMu.Lock()
			err := relayConn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(2*time.Second))
			relayMu.Unlock()
			if err != nil {
				stopTtyd()
				return false, fmt.Errorf("relay ping: %w", err)
			}
		}
	}
}

func websocketEndpoint(relayURL, scope, refreshToken string) (string, error) {
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
	q := base.Query()
	q.Set("token", refreshToken)
	base.RawQuery = q.Encode()
	base.Fragment = ""
	return base.String(), nil
}

func terminalBridgeEndpoint(relayURL, terminalID, refreshToken string) (string, error) {
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
	q := base.Query()
	q.Set("token", refreshToken)
	base.RawQuery = q.Encode()
	base.Fragment = ""
	return base.String(), nil
}

func resolveSessionTerminalWSURL(sessionID string) (string, error) {
	if strings.TrimSpace(sessionID) == "" {
		return "", fmt.Errorf("session id is required")
	}

	endpoint := fmt.Sprintf(
		"http://127.0.0.1:4749/api/sessions/%s/terminal/token",
		url.PathEscape(strings.TrimSpace(sessionID)),
	)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("build terminal token request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("request terminal token: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read terminal token response: %w", err)
	}

	var payload struct {
		TtydWSURL string `json:"ttydWsUrl"`
		Error     string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("decode terminal token response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("terminal token request failed with status %d", resp.StatusCode)
		}
		return "", fmt.Errorf(message)
	}

	base, _ := url.Parse("http://127.0.0.1:4749")
	resolved, err := base.Parse(strings.TrimSpace(payload.TtydWSURL))
	if err != nil {
		return "", fmt.Errorf("parse ttyd websocket url: %w", err)
	}

	switch resolved.Scheme {
	case "http":
		resolved.Scheme = "ws"
	case "https":
		resolved.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported ttyd websocket scheme %q", resolved.Scheme)
	}

	return resolved.String(), nil
}

func proxyTerminalSession(
	ctx context.Context,
	relayURL string,
	refreshToken string,
	terminalID string,
	sessionID string,
) error {
	relayEndpoint, err := terminalBridgeEndpoint(relayURL, terminalID, refreshToken)
	if err != nil {
		return err
	}
	backendEndpoint, err := resolveSessionTerminalWSURL(sessionID)
	if err != nil {
		return err
	}

	relayConn, _, err := websocket.DefaultDialer.DialContext(ctx, relayEndpoint, nil)
	if err != nil {
		return fmt.Errorf("connect relay terminal socket: %w", err)
	}
	defer relayConn.Close()

	backendConn, _, err := websocket.DefaultDialer.DialContext(ctx, backendEndpoint, nil)
	if err != nil {
		return fmt.Errorf("connect backend terminal socket: %w", err)
	}
	defer backendConn.Close()

	errCh := make(chan error, 2)

	forward := func(srcName string, src *websocket.Conn, dstName string, dst *websocket.Conn) {
		go func() {
			for {
				msgType, data, err := src.ReadMessage()
				if err != nil {
					errCh <- fmt.Errorf("%s read: %w", srcName, err)
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

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, "", true, fmt.Errorf("decode bridge request payload: %w", err)
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

	var requestBody io.Reader
	if strings.TrimSpace(bodyBase64) != "" {
		decoded, err := base64.StdEncoding.DecodeString(bodyBase64)
		if err != nil {
			return previewResponse{}, fmt.Errorf("decode preview body: %w", err)
		}
		requestBody = bytes.NewReader(decoded)
	}

	req, err := http.NewRequest(strings.TrimSpace(method), targetURL.String(), requestBody)
	if err != nil {
		return previewResponse{}, err
	}
	req.Header = sanitizePreviewRequestHeaders(headers)

	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		return previewResponse{}, err
	}
	defer resp.Body.Close()

	limitedBody := io.LimitReader(resp.Body, maxPreviewResponseBytes+1)
	responseBytes, err := io.ReadAll(limitedBody)
	if err != nil {
		return previewResponse{}, fmt.Errorf("read preview response: %w", err)
	}
	if len(responseBytes) > maxPreviewResponseBytes {
		return previewResponse{}, fmt.Errorf("preview response exceeded %d bytes", maxPreviewResponseBytes)
	}

	return previewResponse{
		Status:     resp.StatusCode,
		Headers:    sanitizePreviewResponseHeaders(resp.Header),
		BodyBase64: base64.StdEncoding.EncodeToString(responseBytes),
	}, nil
}

func proxyAPI(id, method, path string, body interface{}) (apiResponse, error) {
	if handled, resp := maybeHandleBridgeControlRequest(method, path); handled {
		return resp, nil
	}

	if path == "" {
		path = "/"
	}

	// Proxy to local conductor backend at localhost:4749.
	var requestBodyBytes []byte
	contentType := "application/json"
	if body != nil {
		if rawBody, rawContentType, ok, err := decodeProxyRequestBody(body); ok {
			if err != nil {
				return apiResponse{Status: 0, Body: nil}, err
			}
			requestBodyBytes = rawBody
			if rawContentType != "" {
				contentType = rawContentType
			} else {
				contentType = "application/octet-stream"
			}
		} else {
			bodyBytes, _ := json.Marshal(body)
			requestBodyBytes = bodyBytes
		}
	}

	resp, err := doBackendAPIRequest(method, path, requestBodyBytes, contentType)
	if err != nil && shouldRetryAfterEnsuringBackend(err) {
		if ensureErr := ensureLocalBackendForProxy(); ensureErr == nil {
			resp, err = doBackendAPIRequest(method, path, requestBodyBytes, contentType)
		}
	}
	if err != nil {
		return apiResponse{Status: http.StatusBadGateway, Body: nil}, err
	}
	defer resp.Body.Close()

	responseBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return apiResponse{Status: resp.StatusCode, Body: map[string]any{
			"error": err.Error(),
		}}, nil
	}

	responseContentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if len(responseBytes) == 0 {
		return apiResponse{Status: resp.StatusCode, Body: map[string]any{}}, nil
	}

	if strings.Contains(strings.ToLower(responseContentType), "application/json") {
		var respBody interface{}
		if err := json.Unmarshal(responseBytes, &respBody); err == nil {
			return apiResponse{Status: resp.StatusCode, Body: respBody}, nil
		}
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

func maybeHandleBridgeControlRequest(method, path string) (bool, apiResponse) {
	if normalizeProxyAPIPath(path) != bridgeServiceRestartPath {
		return false, apiResponse{}
	}

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
			"message": "Bridge service restart requested. This laptop should reconnect shortly.",
		},
	}
}

func doBackendAPIRequest(method, path string, requestBodyBytes []byte, contentType string) (*http.Response, error) {
	backendURL := "http://127.0.0.1:4749" + path
	var requestBody io.Reader
	if len(requestBodyBytes) > 0 {
		requestBody = bytes.NewReader(requestBodyBytes)
	}

	req, err := http.NewRequest(method, backendURL, requestBody)
	if err != nil {
		return nil, err
	}
	if len(requestBodyBytes) > 0 {
		req.Header.Set("Content-Type", contentType)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	return client.Do(req)
}

func ensureLocalBackendForProxy() error {
	backendEnsureMu.Lock()
	defer backendEnsureMu.Unlock()

	_, err := backend.Ensure(context.Background(), backend.Options{
		Stderr:         os.Stderr,
		StartupTimeout: 20 * time.Second,
	})
	return err
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

func browseFiles(dir string) ([]any, error) {
	if dir == "" {
		dir = "/"
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
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
