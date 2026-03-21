package token

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultDirName  = ".conductor"
	defaultFileName = "bridge-refresh-token"
)

var ErrTokenNotFound = errors.New("bridge refresh token not found")

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

func (s *Store) Save(refreshToken string) error {
	refreshToken = strings.TrimSpace(refreshToken)
	if refreshToken == "" {
		return errors.New("refresh token is empty")
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create token directory: %w", err)
	}

	if err := os.WriteFile(s.path, []byte(refreshToken+"\n"), 0o600); err != nil {
		return fmt.Errorf("write refresh token: %w", err)
	}

	return nil
}

func (s *Store) Load() (string, error) {
	contents, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrTokenNotFound
		}
		return "", fmt.Errorf("read refresh token: %w", err)
	}

	refreshToken := strings.TrimSpace(string(contents))
	if refreshToken == "" {
		return "", ErrTokenNotFound
	}

	return refreshToken, nil
}
