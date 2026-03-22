package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBackendURL     = "http://127.0.0.1:4749"
	defaultStartupTimeout = 20 * time.Second
	defaultWorkspaceName  = "bridge-home"
)

type Options struct {
	URL            string
	Command        string
	Stderr         io.Writer
	StartupTimeout time.Duration
}

type launchPlan struct {
	cmd  string
	args []string
	env  []string
}

type cliPackageManifest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func isNodeScriptBinary(binaryPath string) bool {
	data, err := os.ReadFile(binaryPath)
	if err != nil {
		return false
	}
	firstLine := strings.SplitN(string(data), "\n", 2)[0]
	return strings.Contains(firstLine, "node")
}

func resolveBundledNativeConductorBinary(binaryPath string) string {
	if !isNodeScriptBinary(binaryPath) {
		return ""
	}

	resolvedPath, err := filepath.EvalSymlinks(binaryPath)
	if err != nil {
		resolvedPath = binaryPath
	}

	packageRoot := filepath.Dir(filepath.Dir(resolvedPath))
	packageNames := []string{}
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" || runtime.GOARCH == "amd64" {
			packageNames = append(packageNames, "conductor-oss-native-darwin-universal")
		}
	case "linux":
		if runtime.GOARCH == "amd64" {
			packageNames = append(packageNames, "conductor-oss-native-linux-x64")
		}
	case "windows":
		if runtime.GOARCH == "amd64" {
			packageNames = append(packageNames, "conductor-oss-native-win32-x64")
		}
	}

	binaryName := "conductor"
	if runtime.GOOS == "windows" {
		binaryName = "conductor.exe"
	}

	for _, packageName := range packageNames {
		candidate := filepath.Join(packageRoot, "node_modules", packageName, "bin", binaryName)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}

	return ""
}

func findNodeBinary() string {
	if resolved, err := exec.LookPath("node"); err == nil {
		return resolved
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	for _, candidate := range []string{
		filepath.Join(homeDir, ".local", "bin", "node"),
		filepath.Join(homeDir, ".nvm", "current", "bin", "node"),
		filepath.Join("/opt/homebrew/bin", "node"),
		filepath.Join("/usr/local/bin", "node"),
		filepath.Join("/usr/bin", "node"),
	} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}

	return ""
}

func resolveBinaryLaunch(binaryPath string, args []string) launchPlan {
	if isNodeScriptBinary(binaryPath) {
		if nodePath := findNodeBinary(); nodePath != "" {
			return launchPlan{cmd: nodePath, args: append([]string{binaryPath}, args...)}
		}
	}

	return launchPlan{cmd: binaryPath, args: args}
}

func applyLaunchEnv(cmd *exec.Cmd, env []string) {
	if len(env) == 0 {
		return
	}

	cmd.Env = append(os.Environ(), env...)
}

func Ensure(ctx context.Context, opts Options) (func(), error) {
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	backendURL, err := resolveBackendURL(opts.URL)
	if err != nil {
		return nil, err
	}

	if backendHealthy(ctx, backendURL) {
		return func() {}, nil
	}

	launch, err := resolveLaunchPlan(opts.Command, backendURL)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, launch.cmd, launch.args...)
	applyLaunchEnv(cmd, launch.env)
	cmd.Stdout = stderr
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start local backend: %w", err)
	}

	timeout := opts.StartupTimeout
	if timeout <= 0 {
		timeout = defaultStartupTimeout
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if backendHealthy(ctx, backendURL) {
			return func() {
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
					_, _ = cmd.Process.Wait()
				}
			}, nil
		}

		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return nil, fmt.Errorf("local backend exited before becoming ready")
		}

		select {
		case <-ctx.Done():
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
				_, _ = cmd.Process.Wait()
			}
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}

	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
	return nil, fmt.Errorf("local backend did not become ready at %s", backendURL)
}

func resolveBackendURL(explicit string) (*url.URL, error) {
	trimmed := strings.TrimSpace(explicit)
	if trimmed == "" {
		trimmed = strings.TrimSpace(os.Getenv("CONDUCTOR_BACKEND_URL"))
	}
	if trimmed == "" {
		trimmed = defaultBackendURL
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse backend url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("unsupported backend url scheme %q", parsed.Scheme)
	}
	return parsed, nil
}

func backendHealthy(ctx context.Context, backendURL *url.URL) bool {
	healthURL := *backendURL
	healthURL.Path = "/api/health"
	healthURL.RawQuery = ""
	healthURL.Fragment = ""

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL.String(), nil)
	if err != nil {
		return false
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func resolveLaunchPlan(explicitCommand string, backendURL *url.URL) (launchPlan, error) {
	trimmedCommand := strings.TrimSpace(explicitCommand)
	if trimmedCommand == "" {
		trimmedCommand = strings.TrimSpace(os.Getenv("CONDUCTOR_BRIDGE_BACKEND_COMMAND"))
	}
	if trimmedCommand != "" {
		if runtime.GOOS == "windows" {
			return launchPlan{cmd: "cmd", args: []string{"/C", trimmedCommand}}, nil
		}
		return launchPlan{cmd: "sh", args: []string{"-lc", trimmedCommand}}, nil
	}

	port := backendPort(backendURL)
	workspace, err := defaultWorkspacePath()
	if err != nil {
		return launchPlan{}, err
	}

	if conductorPath := findConductorBinary("conductor"); conductorPath != "" {
		updateEnv := inferCliUpdateEnv(conductorPath)
		if nativePath := resolveBundledNativeConductorBinary(conductorPath); nativePath != "" {
			return launchPlan{
				cmd:  nativePath,
				args: []string{"--workspace", workspace, "start", "--host", "127.0.0.1", "--port", strconv.Itoa(port)},
				env:  updateEnv,
			}, nil
		}
		args := []string{"--workspace", workspace, "start", "--host", "127.0.0.1", "--port", strconv.Itoa(port)}
		if isNodeScriptBinary(conductorPath) {
			args = []string{"start", "--no-dashboard", "--backend-port", strconv.Itoa(port), "--workspace", workspace}
		}
		launch := resolveBinaryLaunch(conductorPath, args)
		launch.env = updateEnv
		return launch, nil
	}

	if coPath := findConductorBinary("co"); coPath != "" {
		launch := resolveBinaryLaunch(
			coPath,
			[]string{"start", "--no-dashboard", "--backend-port", strconv.Itoa(port), "--workspace", workspace},
		)
		launch.env = inferCliUpdateEnv(coPath)
		return launch, nil
	}

	return launchPlan{}, errors.New("could not find `conductor` or `co`; set CONDUCTOR_BRIDGE_BACKEND_COMMAND to start the local backend")
}

func inferCliUpdateEnv(binaryPath string) []string {
	packageName := strings.TrimSpace(os.Getenv("CONDUCTOR_CLI_PACKAGE_NAME"))
	currentVersion := strings.TrimSpace(os.Getenv("CONDUCTOR_CLI_VERSION"))
	installMode := strings.TrimSpace(os.Getenv("CONDUCTOR_CLI_INSTALL_MODE"))

	resolvedPath, err := filepath.EvalSymlinks(binaryPath)
	if err != nil {
		resolvedPath = binaryPath
	}

	manifestName, manifestVersion, manifestPackageRoot := inferCliPackageManifest(resolvedPath)
	if manifestName != "" && manifestVersion != "" {
		packageName = manifestName
		currentVersion = manifestVersion
		installMode = inferCliInstallMode(manifestPackageRoot)
	}

	if packageName == "" {
		packageName = inferFallbackPackageName(binaryPath)
	}
	if currentVersion == "" {
		currentVersion = inferCliBinaryVersion(binaryPath)
	}
	if installMode == "" {
		installMode = inferCliInstallModeFromBinary(binaryPath)
	}
	if packageName == "" || currentVersion == "" {
		return nil
	}

	return []string{
		"CONDUCTOR_CLI_PACKAGE_NAME=" + packageName,
		"CONDUCTOR_CLI_VERSION=" + currentVersion,
		"CONDUCTOR_CLI_INSTALL_MODE=" + installMode,
	}
}

func inferCliPackageManifest(binaryPath string) (string, string, string) {
	for _, packageRoot := range inferCliPackageRootCandidates(binaryPath) {
		manifestPath := filepath.Join(packageRoot, "package.json")
		manifest, ok := readCliPackageManifest(manifestPath)
		if !ok {
			continue
		}
		packageName := strings.TrimSpace(manifest.Name)
		if !isConductorPackageName(packageName) {
			continue
		}
		currentVersion := strings.TrimSpace(manifest.Version)
		if packageName == "" || currentVersion == "" {
			continue
		}
		return packageName, currentVersion, packageRoot
	}
	return "", "", ""
}

func inferCliInstallModeFromBinary(binaryPath string) string {
	resolvedPath, err := filepath.EvalSymlinks(strings.TrimSpace(binaryPath))
	if err != nil {
		resolvedPath = binaryPath
	}
	for _, packageRoot := range inferCliPackageRootCandidates(resolvedPath) {
		installMode := inferCliInstallMode(packageRoot)
		if installMode != "" && installMode != "unknown" {
			return installMode
		}
	}
	return "unknown"
}

func isConductorPackageName(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "conductor", "conductor-oss":
		return true
	default:
		return false
	}
}

func inferCliPackageRootCandidates(binaryPath string) []string {
	resolvedPath := strings.ReplaceAll(strings.TrimSpace(binaryPath), "\\", "/")
	resolvedPath, err := filepath.EvalSymlinks(resolvedPath)
	if err != nil {
		resolvedPath = binaryPath
	}
	current := filepath.Dir(resolvedPath)
	var candidates []string
	seen := make(map[string]struct{})

	appendCandidate := func(candidate string) {
		if candidate == "" {
			return
		}
		if _, exists := seen[candidate]; exists {
			return
		}
		seen[candidate] = struct{}{}
		candidates = append(candidates, candidate)
	}

	if bunCandidate := inferBunCandidatePackageRootFromBinary(resolvedPath); bunCandidate != "" {
		appendCandidate(bunCandidate)
	}

	for i := 0; i < 16; i++ {
		appendCandidate(current)
		if filepath.Base(current) == "bin" {
			for _, packageName := range []string{"conductor", "conductor-oss"} {
				appendCandidate(filepath.Join(filepath.Dir(current), "lib", "node_modules", packageName))
				appendCandidate(filepath.Join(filepath.Dir(current), "node_modules", packageName))
			}
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return candidates
}

func inferBunCandidatePackageRootFromBinary(resolvedPath string) string {
	normalizedPath := strings.ReplaceAll(resolvedPath, "\\", "/")
	if !strings.Contains(normalizedPath, "/.bun/") {
		return ""
	}

	bunInstallRoot := strings.TrimSpace(os.Getenv("BUN_INSTALL"))
	if bunInstallRoot == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		bunInstallRoot = filepath.Join(homeDir, ".bun")
	}

	for _, packageName := range []string{"conductor-oss", "conductor"} {
		packageRoot := filepath.Join(bunInstallRoot, "install", "global", "node_modules", packageName)
		if _, err := os.Stat(packageRoot); err == nil {
			return packageRoot
		}
	}
	return ""
}

func readCliPackageManifest(path string) (cliPackageManifest, bool) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return cliPackageManifest{}, false
	}
	var manifest cliPackageManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return cliPackageManifest{}, false
	}
	return manifest, true
}

func inferFallbackPackageName(binaryPath string) string {
	switch strings.ToLower(filepath.Base(binaryPath)) {
	case "conductor", "co":
		return "conductor-oss"
	default:
		return ""
	}
}

var cliVersionPattern = regexp.MustCompile(`(?:v|V)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`)

func inferCliBinaryVersion(binaryPath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	command := exec.CommandContext(ctx, binaryPath, "--version")
	output, _ := command.CombinedOutput()
	if ctx.Err() != nil {
		return ""
	}

	if len(output) == 0 {
		return ""
	}

	match := cliVersionPattern.FindString(string(output))
	return strings.TrimPrefix(match, "v")
}

func inferCliInstallMode(packageRoot string) string {
	normalizedRoot := normalizeFsPath(packageRoot)
	parentWorkspaceLockfile := filepath.Join(packageRoot, "..", "..", "pnpm-lock.yaml")
	if strings.HasSuffix(normalizedRoot, "/packages/cli") {
		if _, err := os.Stat(parentWorkspaceLockfile); err == nil {
			return "source"
		}
	}

	if strings.Contains(normalizedRoot, "/_npx/") ||
		strings.Contains(normalizedRoot, "/npm-cache/_npx/") ||
		strings.Contains(normalizedRoot, "/pnpm/dlx/") ||
		strings.Contains(normalizedRoot, "/bunx/") {
		return "npx"
	}

	homeDir, err := os.UserHomeDir()
	if err == nil {
		bunInstallRoot := strings.TrimSpace(os.Getenv("BUN_INSTALL"))
		if bunInstallRoot == "" {
			bunInstallRoot = filepath.Join(homeDir, ".bun")
		}
		bunGlobalRoot := filepath.Join(bunInstallRoot, "install", "global", "node_modules")
		if isPathInside(packageRoot, bunGlobalRoot) {
			return "global-bun"
		}
	}

	if strings.Contains(normalizedRoot, "/.conductor/npm/") ||
		strings.Contains(normalizedRoot, "/lib/node_modules/") ||
		strings.Contains(normalizedRoot, "/node_modules/") {
		return "global-npm"
	}

	if strings.Contains(normalizedRoot, "/pnpm/") {
		return "global-pnpm"
	}

	return "unknown"
}

func normalizeFsPath(value string) string {
	return strings.ReplaceAll(value, "\\", "/")
}

func isPathInside(candidate string, parent string) bool {
	relativePath, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(candidate))
	if err != nil {
		return false
	}
	return relativePath == "." || (!strings.HasPrefix(relativePath, "..") && !filepath.IsAbs(relativePath))
}

func findConductorBinary(command string) string {
	if resolved, err := exec.LookPath(command); err == nil {
		return resolved
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	candidates := []string{
		filepath.Join(homeDir, ".conductor", "bin", command),
		filepath.Join(homeDir, ".local", "bin", command),
		filepath.Join(homeDir, ".npm-global", "bin", command),
		filepath.Join("/opt/homebrew/bin", command),
		filepath.Join("/usr/local/bin", command),
		filepath.Join("/usr/bin", command),
	}

	if runtime.GOOS == "windows" {
		withExtensions := make([]string, 0, len(candidates)*2)
		for _, candidate := range candidates {
			withExtensions = append(withExtensions, candidate)
			withExtensions = append(withExtensions, candidate+".exe")
		}
		candidates = withExtensions
	}

	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}

	return ""
}

func backendPort(backendURL *url.URL) int {
	if backendURL.Port() != "" {
		if parsed, err := strconv.Atoi(backendURL.Port()); err == nil {
			return parsed
		}
	}
	if backendURL.Scheme == "https" {
		return 443
	}
	return 80
}

func defaultWorkspacePath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	workspace := filepath.Join(homeDir, ".conductor", defaultWorkspaceName)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return "", fmt.Errorf("create backend workspace: %w", err)
	}
	return workspace, nil
}
