# Configuration reference

One TOML file, by default `~/.config/sigil/config.toml` (override with
`sigild --config <path>`). Start from [`config.example.toml`](../config.example.toml).

Every default below is the value `sigild` actually applies when the key is absent —
taken from `internal/config`, not from prose. A key set to its zero value (`0`, `""`)
is treated as *unset* and falls back to the default, so you cannot use `0` to mean
"disable" unless the table below says so explicitly.

---

## `[hub]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `listen_addr` | string | `0.0.0.0:7777` | API + WebSocket bind. **Set this to `0.0.0.0:7778`** — `sigil-web` defaults to 7777 and the two collide. |
| `data_dir` | string | `~/.local/share/sigil` | SQLite DB, scrollback logs, identity marks. |
| `log_level` | string | `info` | `debug`, `info`, `warn`, `error`. |
| `host_key_mode` | string | `tofu` | SSH host-key policy — see below. |
| `known_hosts_path` | string | `~/.ssh/known_hosts` | Used by `tofu` and `strict`. |
| `allowed_origins` | []string | `[]` (permissive) | WebSocket `Origin` allowlist. Empty still requires a token, but accepts any origin. Set it if the hub is reachable from a browser you do not control. |

### `host_key_mode`

| Value | Behaviour |
|---|---|
| `tofu` *(default)* | Trust on first use: record unknown keys, **reject changed** keys. Fails open on file I/O errors. A stale `known_hosts` entry for the dial address reads as a mismatch and is refused. |
| `strict` | Only keys already present in `known_hosts`. Nothing is learned automatically. |
| `insecure` | Accept any key. No MITM protection — use only to *diagnose*, never as a resting state. |

---

## `[hub.auth]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `method` | string | `token` | `token` or `none`. |
| `tokens` | []string | — | Accepted bearer tokens. Compared in constant time. |

> **`method = "none"` disables authentication entirely.** Combined with a
> `0.0.0.0` bind that is an unauthenticated remote shell on every configured host.
> Only ever pair it with a loopback bind.

Generate tokens with `openssl rand -hex 32`. Multiple tokens are allowed, which is
how you rotate without downtime: add the new one, move clients over, remove the old.

---

## `[hub.tls]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | Terminate TLS in the hub itself. |
| `cert_file` | string | — | PEM certificate. |
| `key_file` | string | — | PEM private key. |

Most deployments leave this off and put a reverse proxy (Caddy, nginx) in front.
If you do that, the proxy must forward `Upgrade`/`Connection` headers or the
WebSocket — and therefore every live pane — will fail while plain REST still works.

---

## `[hub.scrollback]`

Captured terminal output. **This is the most privacy-sensitive setting in Sigil:**
it persists whatever your terminals printed, including any secret a command echoed.

| Key | Type | Default | Notes |
|---|---|---|---|
| `capture_enabled` | bool | `false` | Master switch for persisting scrollback. |
| `flush_interval_ms` | int | `500` | How often buffered output is written. |
| `max_chunk_lines` | int | `1000` | Lines per stored chunk. |
| `retention_days` | int | `30` | Age-based pruning. |
| `max_bytes_per_session` | int64 | `8388608` (8 MiB) | Hard per-session ceiling. **`0` disables the byte cap** (one of the few keys where 0 is meaningful). |

Worst-case disk is roughly `sessions × max_bytes_per_session`, plus whatever the
retention window holds. Both are also editable live in **Settings → Storage**.

---

## `[hub.discovery]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `interval_seconds` | int | `10` | How often hosts are polled for their tmux session list. |

Each poll is an SSH round trip per connected host. Raising this reduces load on
busy or distant hosts at the cost of slower session/activity updates.

---

## `[hub.metrics]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | Collect per-host CPU/memory/load. |
| `interval_seconds` | int | `5` | Sampling period. |

---

## `[hub.webhooks]`

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | Allow triggers to fire outbound HTTP. |

Triggers match on session output, so a webhook body can contain **terminal text**.
Do not point one at a third party unless you are content for it to receive whatever
scrolls past.

---

## `[[hosts]]`

One block per machine. Hosts declared here are authoritative — they are loaded into
the database at startup and re-applied on restart. Hosts added later through the API
or UI live only in the database.

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | Display name and API identifier. Must be unique. |
| `hostname` | string | — | IP or DNS name to dial. |
| `port` | int | `22` | |
| `user` | string | — | SSH user. |
| `auth_method` | string | — | `key` or `password`. |
| `private_key_path` | string | — | For `auth_method = "key"`. Expanded relative to the **hub's** user, which is not necessarily your login user when run under systemd. |
| `password` | string | — | For `auth_method = "password"`. Stored in plaintext in the config — prefer keys. |
| `tags` | []string | `[]` | Free-form grouping, used by the sidebar. |
| `auto_connect` | bool | `false` | Connect at startup rather than on first use. |

The hub can manage its own machine: give it `hostname = "127.0.0.1"` and a key that
authorises to itself.

### Seeding from `~/.ssh/config`

Each `Host` block maps directly onto a `[[hosts]]` entry — `HostName` → `hostname`,
`User` → `user`, `Port` → `port`, `IdentityFile` → `private_key_path`. Sigil does
not read `~/.ssh/config` itself, so aliases, `ProxyJump`, and `Include` are not
inherited; translate them explicitly.

---

## Applying changes

Config is read at startup. Restart the hub after editing:

```bash
systemctl restart sigild          # or restart your foreground process
```

Scrollback and retention settings are the exception — those can be changed live in
**Settings → Storage** and take effect without a restart.
