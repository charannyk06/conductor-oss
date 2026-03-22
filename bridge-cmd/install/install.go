package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
)

const serviceName = "com.conductor.bridge"

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
	default:
		fmt.Println("Auto-start not supported on this platform.")
		fmt.Println("Add to your shell profile: conductor-bridge daemon")
		return nil
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
`, serviceName, binaryPath)

	if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	installLaunchdService(home, plistPath)

	fmt.Printf("macOS service installed at %s\n", plistPath)
	fmt.Println("Conductor Bridge will relaunch automatically on login.")
	return nil
}

func installLaunchdService(home, plistPath string) {
	uid := strconv.Itoa(os.Getuid())
	domainTarget := "gui/" + uid
	serviceTarget := domainTarget + "/" + serviceName

	_ = exec.Command("launchctl", "bootout", serviceTarget).Run()
	_ = exec.Command("launchctl", "bootstrap", domainTarget, plistPath).Run()
	_ = exec.Command("launchctl", "kickstart", "-k", serviceTarget).Run()
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
