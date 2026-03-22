package dashboardurl

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultDirName  = ".conductor"
	defaultFileName = "bridge-dashboard-url"
)

var ErrDashboardURLNotFound = errors.New("bridge dashboard url not found")

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

func (s *Store) Save(dashboardURL string) error {
	trimmed := strings.TrimSpace(dashboardURL)
	if trimmed == "" {
		return errors.New("dashboard url is empty")
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create dashboard url directory: %w", err)
	}

	if err := os.WriteFile(s.path, []byte(trimmed+"\n"), 0o600); err != nil {
		return fmt.Errorf("write dashboard url: %w", err)
	}

	return nil
}

func (s *Store) Load() (string, error) {
	contents, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrDashboardURLNotFound
		}
		return "", fmt.Errorf("read dashboard url: %w", err)
	}

	dashboardURL := strings.TrimSpace(string(contents))
	if dashboardURL == "" {
		return "", ErrDashboardURLNotFound
	}

	return dashboardURL, nil
}
