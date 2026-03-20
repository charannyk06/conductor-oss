package main

import (
	"flag"
	"fmt"
	"os"
)

const (
	version       = "0.1.0"
	defaultRelay  = "wss://relay.conductor.dev"
	tokenFileName = "bridge-refresh-token"
)

var (
	relayURL  = flag.String("relay", defaultRelay, "Relay WebSocket URL")
	code      = flag.String("code", "", "Pairing code from dashboard")
	daemonMode bool
	verbose   bool
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "pair":
		if err := runPair(); err != nil {
			fmt.Fprintf(os.Stderr, "Pair failed: %v\n", err)
			os.Exit(1)
		}
	case "daemon":
		flag.BoolVar(&daemonMode, "d", false, "Run as background daemon")
		if err := runDaemon(); err != nil {
			fmt.Fprintf(os.Stderr, "Daemon error: %v\n", err)
			os.Exit(1)
		}
	case "status":
		if err := runStatus(); err != nil {
			fmt.Fprintf(os.Stderr, "Status: %v\n", err)
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Printf("conductor-bridge %s\n", version)
	default:
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("conductor-bridge — access your laptop from any browser")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  conductor-bridge pair --code CODE    Pair this laptop with your dashboard")
	fmt.Println("  conductor-bridge daemon             Run as background service")
	fmt.Println("  conductor-bridge status             Check connection status")
	fmt.Println()
	fmt.Println("Options:")
	fmt.Println("  --relay URL   Relay server URL (default: wss://relay.conductor.dev)")
}
