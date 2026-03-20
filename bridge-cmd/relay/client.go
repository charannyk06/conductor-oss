package relay

import (
	"context"
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
		"-W",          // accept any origin (relay->bridge->browser)
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
			sendMu := relayMu
			sendMu.Lock()
			err = relayConn.WriteMessage(websocket.BinaryMessage, data)
			sendMu.Unlock()
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

type apiResponse struct {
	Status int
	Body   interface{}
}

func proxyAPI(id, method, path string, body interface{}) (apiResponse, error) {
	// Proxy to local conductor backend at localhost:4749.
	if path == "" {
		path = "/"
	}
	backendURL := "http://127.0.0.1:4749" + path
	var bodyBytes []byte
	if body != nil {
		bodyBytes, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, backendURL, strings.NewReader(string(bodyBytes)))
	if err != nil {
		return apiResponse{Status: 0, Body: nil}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return apiResponse{Status: 502, Body: nil}, err
	}
	defer resp.Body.Close()
	var respBody interface{}
	json.NewDecoder(resp.Body).Decode(&respBody)
	return apiResponse{Status: resp.StatusCode, Body: respBody}, nil
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
