package pair

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/token"
)

type PairRequest struct {
	Code      string `json:"code"`
	DeviceID  string `json:"device_id"`
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

type PairResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	DeviceName   string `json:"device_name"`
}

func Run(relayURL, code string) error {
	if code == "" {
		return fmt.Errorf("pairing code is required (--code FLAG)")
	}

	hostname, _ := os.Hostname()
	deviceID := os.Getenv("CONDUCTOR_DEVICE_ID")

	store, err := token.NewTokenStore()
	if err != nil {
		return fmt.Errorf("token store: %w", err)
	}

	if deviceID == "" {
		deviceID, _ = store.LoadDeviceID()
		if deviceID == "" {
			// Generate a device ID from hostname + random suffix
			deviceID = fmt.Sprintf("%s-%04x", hostname, time.Now().UnixNano()&0xFFFF)
			store.SaveDeviceID(deviceID)
		}
	}

	// Normalize relay URL to http for API calls
	httpURL := relayURL
	if len(httpURL) > 2 && httpURL[:2] == "ws" {
		if httpURL[:5] == "wss:" {
			httpURL = "https:" + httpURL[5:]
		} else {
			httpURL = "http:" + httpURL[5:]
		}
	}
	apiURL := httpURL + "/api/devices/pair"

	payload := PairRequest{
		Code:     code,
		DeviceID: deviceID,
		Hostname: hostname,
		OS:       os.Getenv("OS"),
		Arch:     "amd64", // could detect properly
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}

	req, err := http.NewRequest("POST", apiURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to relay at %s: %w\nIs the relay server running?", httpURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return fmt.Errorf("pairing failed: %s", errResp.Error)
		}
		return fmt.Errorf("pairing request failed with status %d", resp.StatusCode)
	}

	var pairResp PairResponse
	if err := json.NewDecoder(resp.Body).Decode(&pairResp); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	if err := store.Save(pairResp.RefreshToken); err != nil {
		return fmt.Errorf("save refresh token: %w", err)
	}

	fmt.Printf("Paired successfully as %q\n", pairResp.DeviceName)
	fmt.Println("Run 'conductor-bridge daemon' to connect.")
	return nil
}
