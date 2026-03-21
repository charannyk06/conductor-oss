package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/daemon"
	"github.com/charannyk06/conductor-oss/bridge/device"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

const defaultDashboardURL = "https://conductross.com"

type Options struct {
	RelayURL      string
	DashboardURL  string
	Store         *token.Store
	DeviceStore   *device.Store
	Stdout        io.Writer
	Stderr        io.Writer
	OpenBrowser   bool
	PollInterval  time.Duration
	StartupDaemon bool
}

type claimCreateRequest struct {
	DeviceID      string `json:"device_id"`
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	SuggestedName string `json:"suggested_name,omitempty"`
}

type claimCreateResponse struct {
	ClaimToken string `json:"claim_token"`
	PollToken  string `json:"poll_token"`
	ExpiresIn  int64  `json:"expires_in"`
	Error      string `json:"error"`
}

type claimPollResponse struct {
	Status       string `json:"status"`
	ExpiresIn    int64  `json:"expires_in"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	DeviceID     string `json:"device_id"`
	DeviceName   string `json:"device_name"`
	Error        string `json:"error"`
}

func Run(ctx context.Context, opts Options) error {
	if strings.TrimSpace(opts.RelayURL) == "" {
		return fmt.Errorf("relay URL is required")
	}

	stdout := opts.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	store := opts.Store
	if store == nil {
		var err error
		store, err = token.NewStore("")
		if err != nil {
			return err
		}
	}

	deviceStore := opts.DeviceStore
	if deviceStore == nil {
		var err error
		deviceStore, err = device.NewStore("")
		if err != nil {
			return err
		}
	}

	dashboardURL, err := resolveDashboardURL(opts.DashboardURL, opts.RelayURL)
	if err != nil {
		return err
	}

	if refreshToken, err := store.Load(); err == nil && strings.TrimSpace(refreshToken) != "" {
		deviceID, deviceErr := deviceStore.Load()
		openTarget := dashboardURL
		if deviceErr == nil && strings.TrimSpace(deviceID) != "" {
			if withDevice, err := appendBridgeQuery(dashboardURL, deviceID); err == nil {
				openTarget = withDevice
			}
		}

		fmt.Fprintln(stdout, "Device already paired. Reconnecting bridge daemon.")
		announceBrowser(openTarget, opts.OpenBrowser, stdout, stderr)
		if opts.StartupDaemon {
			return daemon.Run(ctx, daemon.Options{
				RelayURL: opts.RelayURL,
				Store:    store,
				Stderr:   stderr,
			})
		}
		return nil
	}

	deviceID, err := deviceStore.Ensure()
	if err != nil {
		return err
	}

	claim, err := createClaim(ctx, opts.RelayURL, deviceID)
	if err != nil {
		return err
	}

	browserURL, err := buildClaimURL(dashboardURL, claim.ClaimToken)
	if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "Open the dashboard to finish pairing this machine.")
	announceBrowser(browserURL, opts.OpenBrowser, stdout, stderr)
	result, err := waitForClaim(ctx, opts.RelayURL, claim.PollToken, opts.PollInterval)
	if err != nil {
		return err
	}

	if err := store.Save(result.RefreshToken); err != nil {
		return err
	}
	if strings.TrimSpace(result.DeviceID) != "" {
		if err := deviceStore.Save(result.DeviceID); err != nil {
			return err
		}
	}

	fmt.Fprintf(stdout, "Device paired: %q\n", strings.TrimSpace(result.DeviceName))
	fmt.Fprintf(stdout, "Refresh token saved to %s\n", store.Path())

	if opts.StartupDaemon {
		return daemon.Run(ctx, daemon.Options{
			RelayURL: opts.RelayURL,
			Store:    store,
			Stderr:   stderr,
		})
	}

	return nil
}

func createClaim(ctx context.Context, relayURL string, deviceID string) (claimCreateResponse, error) {
	requestBody, err := json.Marshal(claimCreateRequest{
		DeviceID:      strings.TrimSpace(deviceID),
		Hostname:      hostName(),
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		SuggestedName: hostName(),
	})
	if err != nil {
		return claimCreateResponse{}, fmt.Errorf("marshal claim request: %w", err)
	}

	endpoint, err := resolveRelayEndpoint(relayURL, "/api/devices/claims")
	if err != nil {
		return claimCreateResponse{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return claimCreateResponse{}, fmt.Errorf("build claim request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return claimCreateResponse{}, fmt.Errorf("create claim: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return claimCreateResponse{}, fmt.Errorf("read claim response: %w", err)
	}

	var payload claimCreateResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return claimCreateResponse{}, fmt.Errorf("decode claim response: %w (%s)", err, strings.TrimSpace(string(body)))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("claim request failed with status %d", resp.StatusCode)
		}
		return claimCreateResponse{}, fmt.Errorf(message)
	}

	if strings.TrimSpace(payload.ClaimToken) == "" || strings.TrimSpace(payload.PollToken) == "" {
		return claimCreateResponse{}, fmt.Errorf("relay returned an incomplete claim payload")
	}

	return payload, nil
}

func waitForClaim(ctx context.Context, relayURL string, pollToken string, interval time.Duration) (claimPollResponse, error) {
	if interval <= 0 {
		interval = 2 * time.Second
	}

	endpoint, err := resolveRelayEndpoint(relayURL, "/api/devices/claims/poll/"+url.PathEscape(strings.TrimSpace(pollToken)))
	if err != nil {
		return claimPollResponse{}, err
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		result, done, err := pollClaimOnce(ctx, endpoint)
		if done || err != nil {
			return result, err
		}

		select {
		case <-ctx.Done():
			return claimPollResponse{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func pollClaimOnce(ctx context.Context, endpoint string) (claimPollResponse, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return claimPollResponse{}, true, fmt.Errorf("build claim poll request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return claimPollResponse{}, false, nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return claimPollResponse{}, true, fmt.Errorf("read claim poll response: %w", err)
	}

	var payload claimPollResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return claimPollResponse{}, true, fmt.Errorf("decode claim poll response: %w (%s)", err, strings.TrimSpace(string(body)))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("claim poll failed with status %d", resp.StatusCode)
		}
		return claimPollResponse{}, true, fmt.Errorf(message)
	}

	if payload.Status == "paired" {
		if strings.TrimSpace(payload.RefreshToken) == "" {
			return claimPollResponse{}, true, fmt.Errorf("claim completed without a refresh token")
		}
		return payload, true, nil
	}

	return claimPollResponse{}, false, nil
}

func resolveRelayEndpoint(relayURL string, path string) (string, error) {
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

	base.Path = path
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func resolveDashboardURL(explicit string, relayURL string) (string, error) {
	for _, candidate := range []string{
		strings.TrimSpace(explicit),
		strings.TrimSpace(os.Getenv("CONDUCTOR_DASHBOARD_URL")),
		strings.TrimSpace(os.Getenv("CONDUCTOR_PUBLIC_DASHBOARD_URL")),
	} {
		if candidate == "" {
			continue
		}
		if normalized, err := normalizeHTTPURL(candidate); err == nil {
			return normalized, nil
		}
	}

	relayBase, err := normalizeHTTPURL(relayURL)
	if err == nil {
		parsed, parseErr := url.Parse(relayBase)
		if parseErr == nil {
			host := strings.ToLower(parsed.Hostname())
			if host == "127.0.0.1" || host == "localhost" {
				return "http://127.0.0.1:3000", nil
			}
			return parsed.Scheme + "://" + parsed.Host, nil
		}
	}

	return defaultDashboardURL, nil
}

func normalizeHTTPURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return "", fmt.Errorf("unsupported url scheme %q", parsed.Scheme)
	}
	if parsed.Scheme == "ws" {
		parsed.Scheme = "http"
	}
	if parsed.Scheme == "wss" {
		parsed.Scheme = "https"
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func buildClaimURL(dashboardURL string, claimToken string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(dashboardURL))
	if err != nil {
		return "", fmt.Errorf("parse dashboard url: %w", err)
	}
	base.Path = "/bridge/connect"
	base.RawQuery = ""
	base.Fragment = ""
	base.RawQuery = url.Values{"claim": []string{strings.TrimSpace(claimToken)}}.Encode()
	return base.String(), nil
}

func appendBridgeQuery(dashboardURL string, deviceID string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(dashboardURL))
	if err != nil {
		return "", fmt.Errorf("parse dashboard url: %w", err)
	}
	query := base.Query()
	query.Set("bridge", strings.TrimSpace(deviceID))
	base.RawQuery = query.Encode()
	return base.String(), nil
}

func announceBrowser(target string, open bool, stdout io.Writer, stderr io.Writer) {
	if open {
		if err := openBrowser(target); err == nil {
			fmt.Fprintf(stdout, "Opened %s\n", target)
			return
		} else {
			fmt.Fprintf(stderr, "Could not open the browser automatically: %v\n", err)
		}
	}
	fmt.Fprintf(stdout, "Open this URL to finish pairing: %s\n", target)
}

func openBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

func hostName() string {
	if hostname, err := os.Hostname(); err == nil && strings.TrimSpace(hostname) != "" {
		return hostname
	}
	return "unknown"
}
