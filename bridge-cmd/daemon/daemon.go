package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/backend"
	"github.com/charannyk06/conductor-oss/bridge/relay"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

var ErrNotPaired = errors.New("bridge is not paired")

type Options struct {
	RelayURL     string
	Store        *token.Store
	Stderr       io.Writer
	PollInterval time.Duration
}

type deviceAuthResponse struct {
	DeviceID string `json:"device_id"`
	Error    string `json:"error"`
}

func Run(ctx context.Context, opts Options) error {
	store := opts.Store
	if store == nil {
		var err error
		store, err = token.NewStore("")
		if err != nil {
			return err
		}
	}

	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	refreshToken, err := store.Load()
	if err != nil {
		if errors.Is(err, token.ErrTokenNotFound) {
			fmt.Fprintln(stderr, "Run 'conductor-bridge connect' or 'conductor-bridge pair --code CODE' first")
			return ErrNotPaired
		}
		return err
	}
	if err := validateSavedPairing(ctx, opts.RelayURL, refreshToken); err != nil {
		if errors.Is(err, ErrNotPaired) {
			fmt.Fprintln(stderr, "Saved bridge pairing is invalid or expired. Run 'conductor-bridge connect' again.")
		}
		return err
	}

	backendCleanup, err := backend.Ensure(ctx, backend.Options{Stderr: stderr})
	if err != nil {
		return err
	}
	defer backendCleanup()

	pollInterval := opts.PollInterval
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}

	fmt.Fprintf(stderr, "bridge daemon started\n")
	currentToken := refreshToken
	clientCancel, clientDone := startClient(ctx, opts.RelayURL, currentToken, stderr)
	defer clientCancel()

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			clientCancel()
			<-clientDone
			fmt.Fprintf(stderr, "bridge daemon stopped\n")
			return nil
		case err := <-clientDone:
			if ctx.Err() != nil {
				return nil
			}
			if err != nil {
				return err
			}
			return nil
		case <-ticker.C:
			nextToken, err := store.Load()
			if err != nil {
				if errors.Is(err, token.ErrTokenNotFound) {
					continue
				}
				fmt.Fprintf(stderr, "refresh token reload failed: %v\n", err)
				continue
			}
			if nextToken == currentToken {
				continue
			}

			fmt.Fprintf(stderr, "refresh token updated, reconnecting bridge\n")
			clientCancel()
			<-clientDone

			currentToken = nextToken
			clientCancel, clientDone = startClient(ctx, opts.RelayURL, currentToken, stderr)
		}
	}
}

func validateSavedPairing(ctx context.Context, relayURL string, refreshToken string) error {
	endpoint, err := resolveDeviceAuthEndpoint(relayURL)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build device auth request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(refreshToken))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("validate saved pairing: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read device auth response: %w", err)
	}

	var payload deviceAuthResponse
	if len(body) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			return fmt.Errorf("decode device auth response: %w (%s)", err, strings.TrimSpace(string(body)))
		}
	}

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return ErrNotPaired
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("device auth request failed with status %d", resp.StatusCode)
		}
		return errors.New(message)
	}
	if strings.TrimSpace(payload.DeviceID) == "" {
		return ErrNotPaired
	}

	return nil
}

func resolveDeviceAuthEndpoint(relayURL string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(relayURL))
	if err != nil {
		return "", fmt.Errorf("parse relay url: %w", err)
	}

	switch base.Scheme {
	case "http", "https":
	case "ws":
		base.Scheme = "http"
	case "wss":
		base.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported relay url scheme %q", base.Scheme)
	}

	base.Path = "/api/devices/auth"
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func startClient(parent context.Context, relayURL string, refreshToken string, stderr io.Writer) (context.CancelFunc, <-chan error) {
	clientCtx, cancel := context.WithCancel(parent)
	done := make(chan error, 1)

	go func() {
		done <- relay.Run(clientCtx, relay.Options{
			RelayURL:     relayURL,
			RefreshToken: refreshToken,
			Stderr:       stderr,
		})
	}()

	return cancel, done
}
