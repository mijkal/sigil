# Keeping tmux sessions alive on a macOS host

sigild manages sessions on remote hosts as plain tmux sessions. On macOS, a tmux
server started over SSH has no durable owner: nothing restarts it after a reboot,
nothing restarts it if it dies, and its file-descriptor ceiling is low. The result
is sessions that vanish, sometimes repeatedly.

These files make the server a **system LaunchDaemon** so it survives logout,
crashes and reboots.

> Sessions come back, but the **processes inside them do not**. A killed CLI
> process cannot be resurrected with its memory intact. sigild replays a recorded
> launch command (e.g. `claude --continue`) so a tool can reload its own persisted
> state — that is a new process resuming saved data, not the original process.

## What each file is

| file | goes to |
|---|---|
| `com.sigil.tmux.plist` | `/Library/LaunchDaemons/` (owned `root:wheel`, mode 644) |
| `tmux-daemon.sh` | `~/.local/bin/` on the host, `chmod +x` |
| `tmux.conf` | merge into the session owner's `~/.tmux.conf` |

## Install

Replace `REPLACE_USER` in the plist with the account that owns the sessions.

```sh
# as the session owner
mkdir -p ~/.local/bin ~/.local/state/tmux && chmod 700 ~/.local/state/tmux
install -m 755 tmux-daemon.sh ~/.local/bin/tmux-daemon.sh
cat tmux.conf >> ~/.tmux.conf

# ~/.zshenv, NOT ~/.zshrc — sigild discovers sessions over non-interactive zsh,
# and must look at the same socket the daemon creates.
echo 'export TMUX_TMPDIR="$HOME/.local/state/tmux"' >> ~/.zshenv

# as an admin
sudo install -o root -g wheel -m 644 com.sigil.tmux.plist /Library/LaunchDaemons/
sudo plutil -lint /Library/LaunchDaemons/com.sigil.tmux.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.sigil.tmux.plist
sudo launchctl print system/com.sigil.tmux | grep -E 'state|runs|pid'
```

Expect `state = running` and `runs = 1`. Manage with `kickstart -k` to restart and
`bootout system/com.sigil.tmux` to remove.

## Verifying it actually works

```sh
# fd ceiling really applied (not the system default of 256)
sudo launchctl procinfo $(pgrep -f tmux-daemon.sh) | grep maxfiles   # => 8192

# recovery: kill the server, it should be back within ~20s
tmux kill-server; sleep 20; tmux display-message -p 'alive'
```

## Why a wrapper instead of `tmux -D`

`tmux -D` ("do not daemonize") looks like the obvious way to give launchd a
foreground process. It is not portable: with no command, tmux also starts a
*client*, which needs a tty. Under launchd there is none, so on some builds it
exits immediately with `open terminal failed: not a terminal`. It happens to work
on others, which makes this an easy trap.

`start-server` needs no tty — but it forks and exits, so launchd would see the job
finish instantly and `KeepAlive` would spin restarting it.

`tmux-daemon.sh` does both correctly: start the server, then block while it lives,
exiting non-zero when it dies so `KeepAlive` restarts it.

## Notes

- `ProcessType` is `Interactive`, not `Background` — `Background` applies darwin-bg
  throttling, the opposite of what an agent workload wants.
- The socket lives under `~/.local/state/tmux` rather than `/tmp` so macOS's
  periodic `/tmp` cleaner can never remove a live socket.
- Homebrew's tmux is `/opt/homebrew/bin/tmux` on Apple Silicon and
  `/usr/local/bin/tmux` on Intel. The wrapper resolves it from `PATH`; set
  `TMUX_BIN` in the plist to override.
- Ephemeral orchestrator sessions are routed to a **separate** tmux server
  (`tmux -L sigil-ephemeral`) so their churn cannot share a lifecycle or an fd
  budget with real work sessions. That is automatic in sigild; nothing to install.
