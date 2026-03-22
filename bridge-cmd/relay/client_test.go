package relay

import (
	"errors"
	"net/http"
	"testing"
)

func TestShouldRetryTerminalAttach(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "transport errors are retried",
			err:  &terminalAttachError{err: errors.New("request terminal token: connect: connection refused")},
			want: true,
		},
		{
			name: "conflict responses are retried",
			err:  &terminalAttachError{status: http.StatusConflict, err: errors.New("session is not running")},
			want: true,
		},
		{
			name: "bad gateway responses are retried",
			err:  &terminalAttachError{status: http.StatusBadGateway, err: errors.New("failed to attach live terminal")},
			want: true,
		},
		{
			name: "not found responses are not retried",
			err:  &terminalAttachError{status: http.StatusNotFound, err: errors.New("session not found")},
			want: false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldRetryTerminalAttach(tc.err); got != tc.want {
				t.Fatalf("shouldRetryTerminalAttach(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
