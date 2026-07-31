#!/bin/sh
# Supervisor for the long-lived tmux server, run by launchd (com.<user>.tmux).
#
# Why a wrapper instead of `tmux -D`: -D means "do not daemonize", but with no
# command tmux also starts a CLIENT, which needs a tty. Under launchd there is
# none, so on this build it dies with "open terminal failed: not a terminal".
# `start-server` needs no tty, but it forks and exits — launchd would see the job
# end instantly and, with KeepAlive, spin restarting it.
#
# So: start the server, then block for as long as it lives. When it dies this
# script exits non-zero, launchd KeepAlive restarts us, and the server is
# recreated. That gives launchd a real process to supervise and makes the server
# survive logout, crashes and reboots (RunAtLoad).
set -u
# Apple Silicon brew is /opt/homebrew, Intel brew is /usr/local. Override with
# TMUX_BIN in the plist if tmux lives elsewhere.
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
export TMUX_TMPDIR="${TMUX_TMPDIR:-$HOME/.local/state/tmux}"
mkdir -p "$TMUX_TMPDIR" 2>/dev/null

"$TMUX_BIN" -f "$HOME/.tmux.conf" start-server 2>/dev/null

# display-message succeeds only while a server is answering on this socket.
while "$TMUX_BIN" display-message -p "" >/dev/null 2>&1; do
    sleep 15
done
exit 1
