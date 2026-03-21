package pair

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"

	"github.com/charannyk06/conductor-oss/bridge/device"
	"github.com/charannyk06/conductor-oss/bridge/relayurl"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

type Options struct {
	Code        string
	DeviceID    string
	RelayURL    string
	DeviceStore *device.Store
	Store       *token.Store
	Stdout      io.Writer
	Stderr      io.Writer
}

type pairRequest struct {
	Code     string `json:"code"`
	DeviceID string `json:"device_id"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
}

type pairResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	DeviceName   string `json:"device_name"`
	Error        string `json:"error"`
}

func Run(ctx context.Context, opts Options) error {
	var err error

	code := strings.TrimSpace(opts.Code)
	if code == "" {
		return errors.New("pairing code is required")
	}

	if strings.TrimSpace(opts.RelayURL) == "" {
		return errors.New("relay URL is required")
	}

	relayStore, err := relayurl.NewStore("")
	if err != nil {
		return err
	}
	if err := relayStore.Save(opts.RelayURL); err != nil {
		return err
	}

	store := opts.Store
	if store == nil {
		var err error
		store, err = token.NewStore("")
		if err != nil {
			return err
		}
	}

	stdout := opts.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}

	deviceStore := opts.DeviceStore
	if deviceStore == nil {
		deviceStore, err = device.NewStore("")
		if err != nil {
			return err
		}
	}

	deviceID := strings.TrimSpace(opts.DeviceID)
	if deviceID == "" {
		deviceID, err = deviceStore.Ensure()
		if err != nil {
			return err
		}
	}

	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "unknown"
	}

	requestBody, err := json.Marshal(pairRequest{
		Code:     strings.ToUpper(code),
		DeviceID: deviceID,
		Hostname: hostname,
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
	})
	if err != nil {
		return fmt.Errorf("marshal pair request: %w", err)
	}

	endpoint, err := resolvePairEndpoint(opts.RelayURL)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return fmt.Errorf("build pair request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("pair device: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read pair response: %w", err)
	}

	var payload pairResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("decode pair response: %w (%s)", err, strings.TrimSpace(string(body)))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = fmt.Sprintf("pair request failed with status %d", resp.StatusCode)
		}
		return errors.New(message)
	}

	if strings.TrimSpace(payload.RefreshToken) == "" {
		return errors.New("relay returned an empty refresh token")
	}

	if err := store.Save(payload.RefreshToken); err != nil {
		return err
	}

	deviceName := strings.TrimSpace(payload.DeviceName)
	if deviceName == "" {
		deviceName = hostname
	}

	fmt.Fprintf(stdout, "Device paired: %q\n", deviceName)
	fmt.Fprintf(stdout, "Refresh token saved to %s\n", store.Path())
	return nil
}

func resolvePairEndpoint(relayURL string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(relayURL))
	if err != nil {
		return "", fmt.Errorf("parse relay URL: %w", err)
	}

	switch base.Scheme {
	case "http", "https":
	case "ws":
		base.Scheme = "http"
	case "wss":
		base.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported relay URL scheme %q", base.Scheme)
	}

	base.Path = "/api/devices/pair"
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}
