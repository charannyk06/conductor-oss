package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultScope             = "conductor-bridge-control"
	defaultHeartbeatInterval = 30 * time.Second
	maxReconnectBackoff      = 30 * time.Second
)

type Options struct {
	RelayURL          string
	RefreshToken      string
	Scope             string
	Hostname          string
	OS                string
	Stdin             io.Reader
	Stdout            io.Writer
	Stderr            io.Writer
	HeartbeatInterval time.Duration
}

type bridgeEnvelope struct {
	Type   string      `json:"type"`
	Data   string      `json:"data,omitempty"`
	ID     string      `json:"id,omitempty"`
	Status int         `json:"status,omitempty"`
	Body   interface{} `json:"body,omitempty"`
	Path   string      `json:"path,omitempty"`
	Entries []any      `json:"entries,omitempty"`
	Cols   int         `json:"cols,omitempty"`
	Rows   int         `json:"rows,omitempty"`

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

	stdout := opts.Stdout
	if stdout == nil {
		stdout = io.Discard
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

	inputCh := make(chan string, 32)
	inputErrCh := make(chan error, 1)
	go pumpInput(ctx, opts.Stdin, inputCh, inputErrCh)

	backoff := time.Second
	for {
		connected, err := runSession(ctx, sessionOptions{
			relayURL:          opts.RelayURL,
			refreshToken:      opts.RefreshToken,
			scope:             scope,
			hostname:          hostname,
			osName:            osName,
			stdout:            stdout,
			stderr:            stderr,
			heartbeatInterval: heartbeat,
			inputCh:           inputCh,
			inputErrCh:        inputErrCh,
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
	stdout            io.Writer
	stderr            io.Writer
	heartbeatInterval time.Duration
	inputCh           <-chan string
	inputErrCh        <-chan error
}

func runSession(ctx context.Context, opts sessionOptions) (bool, error) {
	endpoint, err := websocketEndpoint(opts.relayURL, opts.scope, opts.refreshToken)
	if err != nil {
		return false, err
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return false, fmt.Errorf("dial relay websocket: %w", err)
	}
	defer conn.Close()

	var writeMu sync.Mutex
	if err := writeEnvelope(conn, &writeMu, bridgeEnvelope{
		Type:      "bridge_status",
		Hostname:  opts.hostname,
		OS:        opts.osName,
		Connected: true,
	}); err != nil {
		return true, err
	}

	readErrCh := make(chan error, 1)
	go func() {
		readErrCh <- readLoop(ctx, conn, &writeMu, opts.stdout)
	}()

	heartbeatTicker := time.NewTicker(opts.heartbeatInterval)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			writeMu.Lock()
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"), time.Now().Add(2*time.Second))
			writeMu.Unlock()
			return true, nil
		case chunk, ok := <-opts.inputCh:
			if !ok {
				opts.inputCh = nil
				continue
			}

			if err := writeEnvelope(conn, &writeMu, bridgeEnvelope{
				Type: "terminal_output",
				Data: chunk,
			}); err != nil {
				return true, err
			}
		case err := <-opts.inputErrCh:
			if err != nil {
				fmt.Fprintf(opts.stderr, "stdin relay pump failed: %v\n", err)
			}
		case <-heartbeatTicker.C:
			if err := writeEnvelope(conn, &writeMu, bridgeEnvelope{
				Type:      "bridge_status",
				Hostname:  opts.hostname,
				OS:        opts.osName,
				Connected: true,
			}); err != nil {
				return true, err
			}
			writeMu.Lock()
			err := conn.WriteControl(websocket.PingMessage, []byte("heartbeat"), time.Now().Add(2*time.Second))
			writeMu.Unlock()
			if err != nil {
				return true, fmt.Errorf("send heartbeat ping: %w", err)
			}
		case err := <-readErrCh:
			return true, err
		}
	}
}

func readLoop(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, stdout io.Writer) error {
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		if messageType != websocket.TextMessage {
			if messageType == websocket.BinaryMessage {
				if _, writeErr := stdout.Write(payload); writeErr != nil {
					return fmt.Errorf("write relay payload: %w", writeErr)
				}
			}
			continue
		}

		var message bridgeEnvelope
		if err := json.Unmarshal(payload, &message); err != nil {
			if _, writeErr := stdout.Write(payload); writeErr != nil {
				return fmt.Errorf("write relay payload: %w", writeErr)
			}
			continue
		}

		switch message.Type {
		case "terminal_input":
			if _, err := io.WriteString(stdout, message.Data); err != nil {
				return fmt.Errorf("write terminal output: %w", err)
			}
		case "ping":
			if err := writeEnvelope(conn, writeMu, bridgeEnvelope{Type: "pong"}); err != nil {
				return err
			}
		case "api_request":
			if err := writeEnvelope(conn, writeMu, bridgeEnvelope{
				Type:   "api_response",
				ID:     message.ID,
				Status: 501,
				Body: map[string]string{
					"error": "Phase 1 bridge API proxy is not implemented yet.",
				},
			}); err != nil {
				return err
			}
		case "file_browse":
			if err := writeEnvelope(conn, writeMu, bridgeEnvelope{
				Type:    "file_tree",
				Path:    message.Path,
				Entries: []any{},
			}); err != nil {
				return err
			}
		case "terminal_resize", "bridge_status", "pong":
		default:
			select {
			case <-ctx.Done():
				return nil
			default:
			}
		}
	}
}

func websocketEndpoint(relayURL string, scope string, refreshToken string) (string, error) {
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
	query := base.Query()
	query.Set("token", refreshToken)
	base.RawQuery = query.Encode()
	base.Fragment = ""
	return base.String(), nil
}

func pumpInput(ctx context.Context, stdin io.Reader, out chan<- string, errCh chan<- error) {
	defer close(out)
	if stdin == nil {
		return
	}

	buffer := make([]byte, 4096)
	for {
		n, err := stdin.Read(buffer)
		if n > 0 {
			select {
			case <-ctx.Done():
				return
			case out <- string(buffer[:n]):
			}
		}

		if err == nil {
			continue
		}
		if err != io.EOF {
			select {
			case errCh <- err:
			default:
			}
		}
		return
	}
}

func writeEnvelope(conn *websocket.Conn, writeMu *sync.Mutex, payload bridgeEnvelope) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal relay payload: %w", err)
	}

	writeMu.Lock()
	defer writeMu.Unlock()
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return fmt.Errorf("write relay payload: %w", err)
	}
	return nil
}
