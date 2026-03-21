package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
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
	ID     string      `json:"id,omitempty"`
	Method string      `json:"method,omitempty"`
	Path   string      `json:"path,omitempty"`
	Status int         `json:"status,omitempty"`
	Body   interface{} `json:"body,omitempty"`

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
	// 1. Find ttyd and pick a port.
	ttydPath, err := findTtyd()
	if err != nil {
		return false, fmt.Errorf("ttyd: %w", err)
	}
	port, err := findFreePort()
	if err != nil {
		return false, fmt.Errorf("allocate ttyd port: %w", err)
	}

	// 2. Spawn ttyd as a child process.
	cmd := exec.Command(ttydPath, []string{
		"-p", fmt.Sprintf("%d", port),
		"-i", "127.0.0.1",
		"-W", // accept any origin (relay->bridge->browser)
		"--wdir", os.TempDir(),
		"bash",
	}...)
	cmd.Env = os.Environ()
	ttydOut, err := cmd.StdoutPipe()
	if err != nil {
		return false, fmt.Errorf("ttyd stdout pipe: %w", err)
	}
	ttydErr, err := cmd.StderrPipe()
	if err != nil {
		return false, fmt.Errorf("ttyd stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return false, fmt.Errorf("start ttyd: %w", err)
	}

	// Give ttyd a moment to start.
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ttydOut.Read(buf)
			if n > 0 {
				fmt.Fprintf(os.Stderr, "[ttyd] %s", string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ttydErr.Read(buf)
			if n > 0 {
				fmt.Fprintf(os.Stderr, "[ttyd] %s", string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
	}()

	// Wait for ttyd to be ready.
	time.Sleep(500 * time.Millisecond)
	if cmd.Process == nil {
		return false, fmt.Errorf("ttyd process not started")
	}

	// 3. Connect to relay.
	relayEndpoint, err := websocketEndpoint(opts.relayURL, opts.scope, opts.refreshToken)
	if err != nil {
		cmd.Process.Kill()
		return false, fmt.Errorf("build relay endpoint: %w", err)
	}
	relayConn, _, err := websocket.DefaultDialer.DialContext(ctx, relayEndpoint, nil)
	if err != nil {
		cmd.Process.Kill()
		return false, fmt.Errorf("dial relay: %w", err)
	}
	defer relayConn.Close()

	// 4. Connect to ttyd WebSocket.
	ttydURL := fmt.Sprintf("ws://127.0.0.1:%d", port)
	ttydConn, _, err := websocket.DefaultDialer.DialContext(ctx, ttydURL, nil)
	if err != nil {
		cmd.Process.Kill()
		return false, fmt.Errorf("connect to ttyd at %s: %w", ttydURL, err)
	}
	defer ttydConn.Close()

	// 5. Tell relay we are connected and ready.
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
		cmd.Process.Kill()
		return false, fmt.Errorf("send bridge_status: %w", err)
	}

	// 6. Bidirectional bridge loop.
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
				// Not JSON — maybe binary fallback; try raw write to ttyd.
				ttydConn.WriteMessage(websocket.BinaryMessage, data)
				continue
			}

			switch env.Type {
			case "terminal_input":
				ttydConn.WriteMessage(websocket.BinaryMessage, []byte(env.Data))

			case "terminal_resize":
				// ttyd resize: send as special JSON on the binary channel.
				resize, _ := json.Marshal(map[string]int{"cols": env.Cols, "rows": env.Rows})
				ttydConn.WriteMessage(websocket.TextMessage, resize)

			case "ping":
				send(bridgeEnvelope{Type: "pong"})

			case "api_request":
				// Proxy to localhost:4749 (conductor backend).
				apiResp, apiErr := proxyAPI(env.ID, env.Method, env.Path, env.Body)
				if apiErr != nil {
					send(bridgeEnvelope{
						Type:   "api_response",
						ID:     env.ID,
						Status: 502,
						Body:   map[string]string{"error": apiErr.Error()},
					})
				} else {
					send(bridgeEnvelope{
						Type:   "api_response",
						ID:     env.ID,
						Status: apiResp.Status,
						Body:   apiResp.Body,
					})
				}

			case "file_browse":
				entries, _ := browseFiles(env.Path)
				send(bridgeEnvelope{
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
	go func() {
		for {
			msgType, data, err := ttydConn.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("ttyd read: %w", err)
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

	// Heartbeat to relay.
	heartbeat := time.NewTicker(opts.heartbeatInterval)
	defer heartbeat.Stop()

	// Monitor ttyd process liveness.
	ttydDone := make(chan struct{})
	go func() {
		cmd.Wait()
		close(ttydDone)
	}()

	// Keep-alive loop: heartbeat + monitor errors.
	for {
		select {
		case <-ctx.Done():
			cmd.Process.Kill()
			return true, nil
		case err := <-errCh:
			cmd.Process.Kill()
			return false, err
		case <-ttydDone:
			cmd.Process.Kill()
			return false, fmt.Errorf("ttyd process exited unexpectedly")
		case <-heartbeat.C:
			if err := send(bridgeEnvelope{
				Type:      "bridge_status",
				Hostname:  opts.hostname,
				OS:        opts.osName,
				Connected: true,
			}); err != nil {
				cmd.Process.Kill()
				return false, fmt.Errorf("send bridge_status: %w", err)
			}
			relayMu.Lock()
			err := relayConn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(2*time.Second))
			relayMu.Unlock()
			if err != nil {
				cmd.Process.Kill()
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

func proxyAPI(id, method, path string, body interface{}) (apiResponse, error) {
	// Proxy to local conductor backend at localhost:4749.
	if path == "" {
		path = "/"
	}
	backendURL := "http://127.0.0.1:4749" + path
	var requestBody io.Reader
	contentType := "application/json"
	if body != nil {
		if rawBody, rawContentType, ok, err := decodeProxyRequestBody(body); ok {
			if err != nil {
				return apiResponse{Status: 0, Body: nil}, err
			}
			requestBody = bytes.NewReader(rawBody)
			if rawContentType != "" {
				contentType = rawContentType
			} else {
				contentType = "application/octet-stream"
			}
		} else {
			bodyBytes, _ := json.Marshal(body)
			requestBody = bytes.NewReader(bodyBytes)
		}
	}
	req, err := http.NewRequest(method, backendURL, requestBody)
	if err != nil {
		return apiResponse{Status: 0, Body: nil}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return apiResponse{Status: 502, Body: nil}, err
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
