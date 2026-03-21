package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/charannyk06/conductor-oss/bridge/connect"
	"github.com/charannyk06/conductor-oss/bridge/daemon"
	"github.com/charannyk06/conductor-oss/bridge/device"
	"github.com/charannyk06/conductor-oss/bridge/install"
	"github.com/charannyk06/conductor-oss/bridge/pair"
	"github.com/charannyk06/conductor-oss/bridge/relayurl"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

const defaultRelayURL = "https://relay.conductross.com"

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(2)
		}
		if errors.Is(err, daemon.ErrNotPaired) {
			os.Exit(1)
		}

		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usageError()
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch args[0] {
	case "connect":
		return runConnect(ctx, args[1:])
	case "pair":
		return runPair(ctx, args[1:])
	case "daemon":
		return runDaemon(ctx, args[1:])
	case "status":
		return runStatus()
	case "install":
		return runInstall(args[1:])
	case "help", "--help", "-h":
		fmt.Fprintln(os.Stdout, usageText())
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usageText())
	}
}

func runConnect(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	relayURL := fs.String("relay-url", resolveRelayURL(), "Relay base URL")
	dashboardURL := fs.String("dashboard-url", resolveDashboardURL(), "Hosted dashboard URL")
	noBrowser := fs.Bool("no-browser", false, "Print the pairing URL instead of opening the browser")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return connect.Run(ctx, connect.Options{
		RelayURL:      strings.TrimSpace(*relayURL),
		DashboardURL:  strings.TrimSpace(*dashboardURL),
		Stdout:        os.Stdout,
		Stderr:        os.Stderr,
		OpenBrowser:   !*noBrowser,
		StartupDaemon: true,
	})
}

func runPair(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	code := fs.String("code", "", "Pairing code shown in the dashboard")
	deviceID := fs.String("device-id", "", "Override the stable device ID stored on this machine")
	relayURL := fs.String("relay-url", resolveRelayURL(), "Relay base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return pair.Run(ctx, pair.Options{
		Code:     strings.TrimSpace(*code),
		DeviceID: strings.TrimSpace(*deviceID),
		RelayURL: strings.TrimSpace(*relayURL),
		Stdout:   os.Stdout,
		Stderr:   os.Stderr,
	})
}

func runDaemon(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	relayURL := fs.String("relay-url", resolveRelayURL(), "Relay base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return daemon.Run(ctx, daemon.Options{
		RelayURL: strings.TrimSpace(*relayURL),
		Stderr:   os.Stderr,
	})
}

func runInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	binaryPath := fs.String("binary", "", "Path to conductor-bridge binary (defaults to this binary)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return install.Install(*binaryPath)
}

func runStatus() error {
	store, err := token.NewStore("")
	if err != nil {
		return err
	}

	refreshToken, err := store.Load()
	switch {
	case err == nil:
		deviceStore, deviceErr := device.NewStore("")
		deviceLine := ""
		if deviceErr == nil {
			if deviceID, loadErr := deviceStore.Load(); loadErr == nil {
				deviceLine = fmt.Sprintf("device id: %s\n", deviceID)
			}
		}
		fmt.Fprintf(os.Stdout, "paired\n%srefresh token path: %s\nrefresh token length: %d\n", deviceLine, store.Path(), len(refreshToken))
		return nil
	case errors.Is(err, token.ErrTokenNotFound):
		fmt.Fprintf(os.Stdout, "not paired\nrun 'conductor-bridge connect' or 'conductor-bridge pair --code CODE' first\n")
		return nil
	default:
		return err
	}
}

func resolveRelayURL() string {
	for _, key := range []string{"RELAY_URL", "CONDUCTOR_BRIDGE_RELAY_URL"} {
		value := strings.TrimSpace(os.Getenv(key))
		if value != "" {
			return value
		}
	}

	store, err := relayurl.NewStore("")
	if err == nil {
		if value, loadErr := store.Load(); loadErr == nil && strings.TrimSpace(value) != "" {
			return value
		}
	}

	return defaultRelayURL
}

func resolveDashboardURL() string {
	for _, key := range []string{"CONDUCTOR_DASHBOARD_URL", "CONDUCTOR_PUBLIC_DASHBOARD_URL"} {
		value := strings.TrimSpace(os.Getenv(key))
		if value != "" {
			return value
		}
	}
	return ""
}

func usageError() error {
	return fmt.Errorf("%s", usageText())
}

func usageText() string {
	return `Usage:
	conductor-bridge connect [--dashboard-url URL] [--relay-url URL]
  conductor-bridge pair --code CODE [--relay-url URL]
  conductor-bridge daemon [--relay-url URL]
  conductor-bridge status
  conductor-bridge install`
}
