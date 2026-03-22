package token

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultDirName      = ".conductor"
	defaultFileName     = "bridge-refresh-token"
	defaultCacheDirName = "bridge-refresh-tokens"
)

var ErrTokenNotFound = errors.New("bridge refresh token not found")

type Store struct {
	path     string
	cacheDir string
}

func NewStore(path string) (*Store, error) {
	resolvedPath := strings.TrimSpace(path)
	var cacheDir string
	if resolvedPath == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home directory: %w", err)
		}
		baseDir := filepath.Join(homeDir, defaultDirName)
		resolvedPath = filepath.Join(baseDir, defaultFileName)
		cacheDir = filepath.Join(baseDir, defaultCacheDirName)
	} else {
		cacheDir = filepath.Join(filepath.Dir(resolvedPath), defaultCacheDirName)
	}

	return &Store{
		path:     resolvedPath,
		cacheDir: cacheDir,
	}, nil
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) CacheDir() string {
	return s.cacheDir
}

func (s *Store) Save(refreshToken string) error {
	return writeTokenFile(s.path, refreshToken)
}

func (s *Store) Load() (string, error) {
	return loadTokenFile(s.path)
}

func (s *Store) SaveForDashboard(dashboardURL string, refreshToken string) error {
	path, err := s.PathForDashboard(dashboardURL)
	if err != nil {
		return err
	}
	return writeTokenFile(path, refreshToken)
}

func (s *Store) LoadForDashboard(dashboardURL string) (string, error) {
	path, err := s.PathForDashboard(dashboardURL)
	if err != nil {
		return "", err
	}
	return loadTokenFile(path)
}

func (s *Store) PathForDashboard(dashboardURL string) (string, error) {
	normalized, err := normalizeDashboardURL(dashboardURL)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.cacheDir, safeDashboardTokenFileName(normalized)), nil
}

func writeTokenFile(path string, refreshToken string) error {
	refreshToken = strings.TrimSpace(refreshToken)
	if refreshToken == "" {
		return errors.New("refresh token is empty")
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create token directory: %w", err)
	}

	if err := os.WriteFile(path, []byte(refreshToken+"\n"), 0o600); err != nil {
		return fmt.Errorf("write refresh token: %w", err)
	}

	return nil
}

func loadTokenFile(path string) (string, error) {
	contents, err := os.ReadFile(path)
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

func normalizeDashboardURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse dashboard url: %w", err)
	}
	if parsed.Host == "" {
		return "", errors.New("dashboard url host is empty")
	}

	switch parsed.Scheme {
	case "http", "https":
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported dashboard url scheme %q", parsed.Scheme)
	}

	parsed.Host = normalizeHost(parsed)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func normalizeHost(parsed *url.URL) string {
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if port == "" {
		return host
	}
	return net.JoinHostPort(host, port)
}

func safeDashboardTokenFileName(normalizedDashboardURL string) string {
	parsed, _ := url.Parse(normalizedDashboardURL)
	slugSource := parsed.Host
	if pathPart := strings.Trim(parsed.Path, "/"); pathPart != "" {
		slugSource += "-" + pathPart
	}

	slug := sanitizeFileComponent(slugSource)
	if slug == "" {
		slug = "dashboard"
	}
	if len(slug) > 48 {
		slug = strings.TrimRight(slug[:48], "-.")
		if slug == "" {
			slug = "dashboard"
		}
	}

	sum := sha256.Sum256([]byte(normalizedDashboardURL))
	return fmt.Sprintf("%s-%s.token", slug, hex.EncodeToString(sum[:]))
}

func sanitizeFileComponent(input string) string {
	var builder strings.Builder
	lastDash := false

	for _, r := range strings.ToLower(strings.TrimSpace(input)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_':
			builder.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				builder.WriteByte('-')
				lastDash = true
			}
		}
	}

	return strings.Trim(builder.String(), "-.")
}
