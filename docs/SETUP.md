# Setting up Sigil

A complete, first-run guide: install → configure → add a host → verify. Written to
be followed by a person **or** by an LLM agent assisting one — every step has an
observable success condition, so you never have to guess whether it worked.

If a step fails, jump to [Troubleshooting](#troubleshooting); the failures listed
there are the ones that actually happen, not hypothetical ones.

---

## 0. What you are installing

Sigil is **two processes plus a config file**:

| Process | Default port | Job |
|---|---|---|
| `sigild` | **7778** | The hub. Talks SSH to your hosts, owns tmux, serves the REST API + WebSocket. |
| `sigil-web` | **7777** | Serves the built web client and proxies API calls to the hub. |

You reach Sigil at **`http://<host>:7777`**. The hub itself does not serve the UI.

> **The one port rule.** `sigild` and `sigil-web` both historically defaulted to
> 7777. Keep the hub on **7778** and the web client on **7777**. If you put both on
> the same port, the second one to start exits with `address already in use`.

Sigil connects **outward over SSH** to machines you already have access to. It does
not install an agent on them. A host needs: sshd, `tmux`, and a shell.

---

## 1. Prerequisites

```bash
go version     # need 1.22+
node -v        # need 18+  (only to BUILD the web client)
tmux -V        # on each MANAGED host, not necessarily the hub
```

You also need working SSH access to each host you plan to manage — verify it
independently before involving Sigil:

```bash
ssh you@your-host 'tmux -V && echo SSH_OK'
```

If that does not print `SSH_OK`, stop and fix SSH first. Roughly half of all
"Sigil can't connect" reports are SSH problems that reproduce without Sigil.

---

## 2. Build

```bash
git clone <repo-url> sigil && cd sigil
make setup-config      # writes ~/.config/sigil/config.toml from the example
make build-web         # builds web/dist  (needs node)
make build             # builds dist/sigild and dist/sigil-web
```

**Success condition:** `ls dist/` shows `sigild` and `sigil-web`, and
`ls web/dist/index.html` exists.

---

## 3. Configure

Edit `~/.config/sigil/config.toml`. The minimum viable config is a token and one
host:

```toml
[hub]
listen_addr = "0.0.0.0:7778"      # keep off 7777 — see the port rule above

[hub.auth]
method = "token"
tokens = ["PASTE_A_LONG_RANDOM_STRING_HERE"]

[[hosts]]
name         = "workstation"       # the name you'll see in the sidebar
hostname     = "192.0.2.10"
port         = 22
user         = "you"
auth_method  = "key"
private_key_path = "~/.ssh/id_ed25519"
auto_connect = true
```

Generate a token with real entropy — this is the only thing between the internet
and a shell on every host you add:

```bash
openssl rand -hex 32
```

Full reference for every key: **[CONFIGURATION.md](CONFIGURATION.md)**.

---

## 4. Run

Two processes. For a first run, use two terminals so you can see both logs:

```bash
# terminal 1 — the hub
./dist/sigild --config ~/.config/sigil/config.toml

# terminal 2 — the web client
./dist/sigil-web -dir ./web/dist -backend http://127.0.0.1:7778 -addr 0.0.0.0:7777
```

**Success condition**, from a third terminal:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7778/api/v1/hosts
```

That should return JSON containing the host you configured. A `401` means the
token does not match; anything else means the hub is not up.

Now open `http://localhost:7777`, paste the same token, and your sessions appear.

---

## 5. Run it as a service

Once it works by hand, install the units (adjust paths and `User=`):

```bash
sudo cp systemd/sigild.service systemd/sigil-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sigild sigil-web
systemctl is-active sigild sigil-web     # expect: active active
```

---

## 6. Verify end to end

```bash
# 1. hub is healthy
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7778/api/v1/status

# 2. the host actually connected (not just configured)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7778/api/v1/hosts \
  | grep -o '"status":"[a-z]*"'

# 3. sessions are discovered
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7778/api/v1/sessions
```

A host that is `configured` but never `connected` is an SSH problem — see below.

---

## Troubleshooting

### Start here: `sigil doctor`

Before reading further, ask the installation what is wrong with it:

```bash
sigil doctor              # human-readable, with a suggested fix per problem
sigil doctor --json       # machine-readable — hand this to an LLM agent
```

It checks the config, the port pairing, the data directory, hub reachability,
token acceptance, and every configured host's key path. Exit code is **0** when
nothing failed (warnings still exit 0) and **1** otherwise, so it drops into a
script or CI as-is.

Every non-passing check carries a `remedy` field naming the next action — which is
what makes `--json` useful to an agent helping someone set up:

```json
{
  "id": "config.ports",
  "status": "fail",
  "detail": "hub.listen_addr is on :7777, which is also sigil-web's default",
  "remedy": "Set hub.listen_addr = \"0.0.0.0:7778\" and point sigil-web at -backend http://127.0.0.1:7778"
}
```

Statuses are `pass`, `warn` (works, but probably not what you meant), `fail`, and
`skip` (could not be judged — usually downstream of an earlier failure). A `skip`
is never success.


### `address already in use` on startup
The hub and the web client are both on 7777. Set `hub.listen_addr` to `0.0.0.0:7778`
and restart. This is the single most common first-run failure.

### Host stays disconnected / `ssh: handshake failed`
Check in this order:
1. **Does plain SSH work from the hub machine, as the user `sigild` runs as?**
   Service units often run as a different user with a different `~/.ssh`.
2. **Host key.** Default `host_key_mode = "tofu"` records unknown keys but
   **rejects changed** ones — a stale `known_hosts` entry for that address reads
   as a MITM and is refused. Remove the stale line, or set `"insecure"` to confirm
   that is the cause before deciding how to fix it properly.
3. **Key path.** `private_key_path` is expanded relative to the *hub's* user.

### `channel closed` spam, sessions blank
Usually SSH `MaxSessions` exhaustion on the managed host: Sigil opens a channel per
viewer, and the server default is 10. Either raise `MaxSessions` in that host's
`sshd_config` or reduce concurrent panes. Restarting `sigild` clears a wedged pool.

### Panes render but text is stuck or clipped
A shared tmux window is sized to the **smallest** connected viewer. Close the small
viewer (or resize it) and the grid grows back.

### 401 from the API but the token looks right
Tokens are compared byte-for-byte. Check for a trailing newline or a shell-quoting
artifact in the header — `echo -n "$TOKEN" | wc -c` should equal the token length.

---

## Security posture before you expose this

Read **[SECURITY.md](../SECURITY.md)** first. The short version:

- **Sigil is a remote shell.** A valid token is equivalent to shell access on every
  configured host. Treat the token like an SSH private key.
- **Do not put it on the public internet with `auth.method = "none"`.** Bind to
  localhost or a VPN/Tailscale address, or terminate TLS and set
  `hub.allowed_origins`.
- **Scrollback is retained on disk** (`~/.local/share/sigil` by default) and
  contains whatever your terminals printed — including secrets you echoed. Set a
  retention policy you are comfortable with; see `hub.scrollback`.
