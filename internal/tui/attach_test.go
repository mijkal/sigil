package tui

import (
	"reflect"
	"testing"

	sigil "sigil.dev/sigil/pkg/sigil"
)

func TestAttachArgs(t *testing.T) {
	tests := []struct {
		name    string
		host    sigil.Host
		session string
		want    []string
	}{
		{
			name:    "default port 22 omits -p",
			host:    sigil.Host{Hostname: "box.lan", Port: 22, User: "cc"},
			session: "work",
			want:    []string{"ssh", "-t", "cc@box.lan", "tmux", "attach", "-t", "work"},
		},
		{
			name:    "zero port omits -p",
			host:    sigil.Host{Hostname: "box.lan", User: "cc"},
			session: "work",
			want:    []string{"ssh", "-t", "cc@box.lan", "tmux", "attach", "-t", "work"},
		},
		{
			name:    "non-22 port includes -p",
			host:    sigil.Host{Hostname: "box.lan", Port: 2222, User: "cc"},
			session: "work",
			want:    []string{"ssh", "-t", "-p", "2222", "cc@box.lan", "tmux", "attach", "-t", "work"},
		},
		{
			name:    "no user drops the user@ prefix",
			host:    sigil.Host{Hostname: "box.lan", Port: 22},
			session: "work",
			want:    []string{"ssh", "-t", "box.lan", "tmux", "attach", "-t", "work"},
		},
		{
			name:    "session name with a space is carried as one argv element",
			host:    sigil.Host{Hostname: "box.lan", Port: 22, User: "cc"},
			session: "my session",
			want:    []string{"ssh", "-t", "cc@box.lan", "tmux", "attach", "-t", "my session"},
		},
		{
			name:    "session name with a colon is passed through verbatim",
			host:    sigil.Host{Hostname: "box.lan", Port: 2200, User: "root"},
			session: "proj:1",
			want:    []string{"ssh", "-t", "-p", "2200", "root@box.lan", "tmux", "attach", "-t", "proj:1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := attachArgs(tt.host, tt.session)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("attachArgs()\n got = %#v\nwant = %#v", got, tt.want)
			}
		})
	}
}
