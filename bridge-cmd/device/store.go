package device

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const (
	defaultDirName  = ".conductor"
	defaultFileName = "bridge-device-id"
)

var ErrDeviceIDNotFound = errors.New("bridge device id not found")

type Store struct {
	path string
}

func NewStore(path string) (*Store, error) {
	resolvedPath := strings.TrimSpace(path)
	if resolvedPath == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home directory: %w", err)
		}
		resolvedPath = filepath.Join(homeDir, defaultDirName, defaultFileName)
	}

	return &Store{path: resolvedPath}, nil
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) Save(deviceID string) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return errors.New("device id is empty")
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create device directory: %w", err)
	}

	if err := os.WriteFile(s.path, []byte(deviceID+"\n"), 0o600); err != nil {
		return fmt.Errorf("write device id: %w", err)
	}

	return nil
}

func (s *Store) Load() (string, error) {
	contents, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrDeviceIDNotFound
		}
		return "", fmt.Errorf("read device id: %w", err)
	}

	deviceID := strings.TrimSpace(string(contents))
	if deviceID == "" {
		return "", ErrDeviceIDNotFound
	}

	return deviceID, nil
}

func (s *Store) Ensure() (string, error) {
	deviceID, err := s.Load()
	if err == nil {
		return deviceID, nil
	}
	if !errors.Is(err, ErrDeviceIDNotFound) {
		return "", err
	}

	deviceID = uuid.NewString()
	if err := s.Save(deviceID); err != nil {
		return "", err
	}

	return deviceID, nil
}
