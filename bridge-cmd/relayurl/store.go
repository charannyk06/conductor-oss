package relayurl

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultDirName  = ".conductor"
	defaultFileName = "bridge-relay-url"
)

var ErrRelayURLNotFound = errors.New("bridge relay url not found")

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

func (s *Store) Save(relayURL string) error {
	trimmed := strings.TrimSpace(relayURL)
	if trimmed == "" {
		return errors.New("relay url is empty")
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create relay url directory: %w", err)
	}

	if err := os.WriteFile(s.path, []byte(trimmed+"\n"), 0o600); err != nil {
		return fmt.Errorf("write relay url: %w", err)
	}

	return nil
}

func (s *Store) Load() (string, error) {
	contents, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrRelayURLNotFound
		}
		return "", fmt.Errorf("read relay url: %w", err)
	}

	relayURL := strings.TrimSpace(string(contents))
	if relayURL == "" {
		return "", ErrRelayURLNotFound
	}

	return relayURL, nil
}
