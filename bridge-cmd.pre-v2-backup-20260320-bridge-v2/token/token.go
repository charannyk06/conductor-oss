package token

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

type TokenStore struct {
	dir string
}

func NewTokenStore() (*TokenStore, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("could not find home directory: %w", err)
	}
	dir := filepath.Join(home, ".conductor")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}
	return &TokenStore{dir: dir}, nil
}

func (s *TokenStore) tokenPath() string {
	return filepath.Join(s.dir, "bridge-refresh-token")
}

func (s *TokenStore) deviceIDPath() string {
	return filepath.Join(s.dir, "bridge-device-id")
}

func (s *TokenStore) Save(token string) error {
	path := s.tokenPath()
	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}
	if runtime.GOOS != "windows" {
		// Lock the file
	}
	return nil
}

func (s *TokenStore) Load() (string, error) {
	data, err := os.ReadFile(s.tokenPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("read token file: %w", err)
	}
	return string(data), nil
}

func (s *TokenStore) Clear() error {
	os.Remove(s.tokenPath())
	return nil
}

func (s *TokenStore) HasToken() bool {
	_, err := os.Stat(s.tokenPath())
	return err == nil
}

func (s *TokenStore) SaveDeviceID(id string) error {
	path := s.deviceIDPath()
	if err := os.WriteFile(path, []byte(id), 0600); err != nil {
		return fmt.Errorf("write device id file: %w", err)
	}
	return nil
}

func (s *TokenStore) LoadDeviceID() (string, error) {
	data, err := os.ReadFile(s.deviceIDPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("read device id file: %w", err)
	}
	return string(data), nil
}
