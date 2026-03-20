package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/charannyk06/conductor-oss/bridge/relay"
	"github.com/charannyk06/conductor-oss/bridge/token"
)

var ErrNotPaired = errors.New("bridge is not paired")

type Options struct {
	RelayURL     string
	Store        *token.Store
	Stderr       io.Writer
	PollInterval time.Duration
}

func Run(ctx context.Context, opts Options) error {
	store := opts.Store
	if store == nil {
		var err error
		store, err = token.NewStore("")
		if err != nil {
			return err
		}
	}

	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	refreshToken, err := store.Load()
	if err != nil {
		if errors.Is(err, token.ErrTokenNotFound) {
			fmt.Fprintln(stderr, "Run 'conductor-bridge pair --code CODE' first")
			return ErrNotPaired
		}
		return err
	}

	pollInterval := opts.PollInterval
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}

	fmt.Fprintf(stderr, "bridge daemon started\n")
	currentToken := refreshToken
	clientCancel, clientDone := startClient(ctx, opts.RelayURL, currentToken, stderr)
	defer clientCancel()

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			clientCancel()
			<-clientDone
			fmt.Fprintf(stderr, "bridge daemon stopped\n")
			return nil
		case err := <-clientDone:
			if ctx.Err() != nil {
				return nil
			}
			if err != nil {
				return err
			}
			return nil
		case <-ticker.C:
			nextToken, err := store.Load()
			if err != nil {
				if errors.Is(err, token.ErrTokenNotFound) {
					continue
				}
				fmt.Fprintf(stderr, "refresh token reload failed: %v\n", err)
				continue
			}
			if nextToken == currentToken {
				continue
			}

			fmt.Fprintf(stderr, "refresh token updated, reconnecting bridge\n")
			clientCancel()
			<-clientDone

			currentToken = nextToken
			clientCancel, clientDone = startClient(ctx, opts.RelayURL, currentToken, stderr)
		}
	}
}

func startClient(parent context.Context, relayURL string, refreshToken string, stderr io.Writer) (context.CancelFunc, <-chan error) {
	clientCtx, cancel := context.WithCancel(parent)
	done := make(chan error, 1)

	go func() {
		done <- relay.Run(clientCtx, relay.Options{
			RelayURL:     relayURL,
			RefreshToken: refreshToken,
			Stderr:       stderr,
		})
	}()

	return cancel, done
}
