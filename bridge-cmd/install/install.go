package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const serviceName = "com.conductor.bridge"

func resolveLaunchdPath(home string) string {
	return fmt.Sprintf(
		"%s:%s:%s:%s:%s:%s:%s:%s",
		filepath.Join(home, ".conductor", "bin"),
		filepath.Join(home, ".conductor", "npm", "bin"),
		filepath.Join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin:/sbin",
	)
}

func Install(binaryPath string) error {
	if binaryPath == "" {
		// Find our own binary
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("could not determine binary path: %w", err)
		}
		binaryPath = exe
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("could not find home directory: %w", err)
	}

	installDir := filepath.Join(home, ".conductor", "bin")
	if err := os.MkdirAll(installDir, 0755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}

	destPath := filepath.Join(installDir, "conductor-bridge")
	if binaryPath != destPath {
		if err := copyFile(binaryPath, destPath); err != nil {
			return fmt.Errorf("copy binary: %w", err)
		}
		if err := os.Chmod(destPath, 0755); err != nil {
			return fmt.Errorf("chmod: %w", err)
		}
		fmt.Printf("Installed to %s\n", destPath)
	}

	switch runtime.GOOS {
	case "darwin":
		return installLaunchd(home, destPath)
	case "linux":
		return installSystemd(home, destPath)
	case "windows":
		return installWindowsStartup(home, destPath)
	default:
		fmt.Println("Auto-start not supported on this platform.")
		fmt.Println("Add to your shell profile: conductor-bridge daemon")
		return nil
	}
}

func RestartServiceIfInstalled() error {
	if err := RestartServiceAvailable(); err != nil {
		return err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("could not find home directory: %w", err)
	}

	switch runtime.GOOS {
	case "darwin":
		plistPath := filepath.Join(home, "Library", "LaunchAgents", serviceName+".plist")
		return installLaunchdService(home, plistPath)
	case "linux":
		cmd := exec.Command("systemctl", "--user", "restart", serviceName)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("restart systemd service: %w", err)
		}
		return nil
	case "windows":
		binaryPath := filepath.Join(home, ".conductor", "bin", "conductor-bridge.exe")
		if _, err := os.Stat(binaryPath); err != nil {
			binaryPath = filepath.Join(home, ".conductor", "bin", "conductor-bridge")
		}
		cmd := exec.Command("cmd", "/C", "start", "", "/B", binaryPath, "daemon")
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("restart windows bridge daemon: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("auto-restart not supported on %s", runtime.GOOS)
	}
}

func RestartServiceAvailable() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("could not find home directory: %w", err)
	}

	switch runtime.GOOS {
	case "darwin":
		plistPath := filepath.Join(home, "Library", "LaunchAgents", serviceName+".plist")
		if _, err := os.Stat(plistPath); err != nil {
			return fmt.Errorf("launchd service not installed: %w", err)
		}
		return nil
	case "linux":
		xdgConfig := os.Getenv("XDG_CONFIG_HOME")
		if xdgConfig == "" {
			xdgConfig = filepath.Join(home, ".config")
		}
		unitPath := filepath.Join(xdgConfig, "systemd", "user", serviceName+".service")
		if _, err := os.Stat(unitPath); err != nil {
			return fmt.Errorf("systemd service not installed: %w", err)
		}
		return nil
	case "windows":
		startupScript, err := resolveWindowsStartupScriptPath()
		if err != nil {
			return err
		}
		if _, err := os.Stat(startupScript); err != nil {
			return fmt.Errorf("windows startup script not installed: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("auto-restart not supported on %s", runtime.GOOS)
	}
}

func installLaunchd(home, binaryPath string) error {
	plistDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(plistDir, 0755); err != nil {
		return fmt.Errorf("create LaunchAgents dir: %w", err)
	}

	plistPath := filepath.Join(plistDir, serviceName+".plist")
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
        <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>%s</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/conductor-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/conductor-bridge.err</string>
</dict>
</plist>
`, serviceName, binaryPath, resolveLaunchdPath(home))

	if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	if err := installLaunchdService(home, plistPath); err != nil {
		return err
	}

	fmt.Printf("macOS service installed at %s\n", plistPath)
	fmt.Println("Conductor Bridge will relaunch automatically on login.")
	return nil
}

func installLaunchdService(home, plistPath string) error {
	uid := strconv.Itoa(os.Getuid())
	domainTarget := "gui/" + uid
	serviceTarget := domainTarget + "/" + serviceName

	_ = exec.Command("launchctl", "bootout", serviceTarget).Run()

	if err := exec.Command("launchctl", "bootstrap", domainTarget, plistPath).Run(); err != nil {
		time.Sleep(300 * time.Millisecond)
		if printErr := exec.Command("launchctl", "print", serviceTarget).Run(); printErr != nil {
			if retryErr := exec.Command("launchctl", "bootstrap", domainTarget, plistPath).Run(); retryErr != nil {
				return fmt.Errorf("bootstrap launchd service: %w", err)
			}
		}
	}
	if err := exec.Command("launchctl", "kickstart", "-k", serviceTarget).Run(); err != nil {
		return fmt.Errorf("kickstart launchd service: %w", err)
	}
	return nil
}

func resolveWindowsStartupScriptPath() (string, error) {
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" {
		return "", fmt.Errorf("APPDATA is not set")
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "conductor-bridge.cmd"), nil
}

func installWindowsStartup(home, binaryPath string) error {
	startupScript, err := resolveWindowsStartupScriptPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(startupScript), 0755); err != nil {
		return fmt.Errorf("create Windows Startup dir: %w", err)
	}
	launcher := fmt.Sprintf("@echo off\r\nstart \"\" /B \"%s\" daemon\r\n", binaryPath)
	if err := os.WriteFile(startupScript, []byte(launcher), 0644); err != nil {
		return fmt.Errorf("write Windows startup launcher: %w", err)
	}
	fmt.Printf("Windows startup launcher installed at %s\n", startupScript)
	fmt.Println("Conductor Bridge will start automatically when you sign in.")
	return nil
}

func installSystemd(home, binaryPath string) error {
	xdgConfig := os.Getenv("XDG_CONFIG_HOME")
	if xdgConfig == "" {
		xdgConfig = filepath.Join(home, ".config")
	}
	unitDir := filepath.Join(xdgConfig, "systemd", "user")
	if err := os.MkdirAll(unitDir, 0755); err != nil {
		return fmt.Errorf("create systemd dir: %w", err)
	}

	unitPath := filepath.Join(unitDir, serviceName+".service")
	unit := fmt.Sprintf(`[Unit]
Description=Conductor Bridge
After=network.target

[Service]
Type=simple
ExecStart=%s daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`, binaryPath)

	if err := os.WriteFile(unitPath, []byte(unit), 0644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}

	fmt.Printf("systemd user service installed at %s\n", unitPath)
	fmt.Println("Run: systemctl --user enable --now conductor-bridge")
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0755)
}
