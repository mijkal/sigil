# HTTP API reference

Base URL: `http://<hub>:7778/api/v1` (the hub, not the web client on 7777).

Every route below is generated from `internal/api/server.go`. Where this document
and the code disagree, the code is right — please file that as a bug.

---

## Authentication

Every request needs a bearer token from `hub.auth.tokens`:

```bash
curl -H "Authorization: Bearer $SIGIL_TOKEN" http://127.0.0.1:7778/api/v1/hosts
```

Tokens are compared in constant time. There are no scopes or per-token
permissions: **a valid token can do everything, on every configured host,
including running commands.** Treat it as equivalent to an SSH private key. If
`hub.auth.method = "none"`, the check is skipped entirely.

Responses are JSON. Errors return a non-2xx status with a JSON body carrying an
`error` field.

---

## Hosts

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/hosts` | List hosts and their connection status. |
| `POST` | `/hosts` | Add a host (database-only; not written back to config). |
| `PATCH` | `/hosts/{name}` | Update a host. |
| `DELETE` | `/hosts/{name}` | Remove a host. |
| `POST` | `/hosts/{name}/connect` | Establish the SSH connection now. |
| `POST` | `/hosts/{name}/disconnect` | Drop it. |
| `POST` | `/hosts/{name}/adopt` | Adopt an existing tmux session found on the host. |
| `GET` | `/hosts/{name}/metrics` | CPU / memory / load for one host. |
| `GET` | `/metrics` | Metrics for all hosts. |

## Sessions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sessions` | All discovered sessions, with `activity` and `status`. |
| `POST` | `/sessions` | Create a tmux session on a host. |
| `PATCH` | `/sessions/{id}` | Rename / retag. |
| `DELETE` | `/sessions/{id}` | Kill the session. |
| `GET` | `/sessions/{id}/capture` | Current visible pane contents. |
| `GET` | `/sessions/{id}/scrollback` | Retained history (requires `capture_enabled`). |
| `GET` | `/sessions/{id}/pipe` | Ranged read of the raw pipe log. Negative `offset` = last N bytes. |
| `POST` | `/sessions/{id}/keys` | Send keystrokes into the session. |
| `POST` | `/sessions/{id}/signal` | Authoritative "this agent is waiting / idle / done" signal. |
| `POST` | `/sessions/{id}/resurrect` | Restore a session per the auto-resurrect policy. |

> `capture`, `scrollback`, and `pipe` return **raw terminal output**. That is where
> secrets live — anything a command printed. Anything consuming these (an MCP
> server, a webhook, an LLM agent) is a data-exfiltration path and a
> prompt-injection surface, because terminal text becomes model input. Scope
> access deliberately.

### `session.activity`

`GET /sessions` reports a per-session `activity`, used for the sidebar indicator:

| Value | Meaning |
|---|---|
| `working` | Mid-task (agent is producing output). |
| `waiting` | **Blocked on a human decision.** The escalation-worthy state. |
| `attention` | Stopped; may need you. The honest "unknown" state. |
| `error` | API error / blocked. |
| `done` | Finished a turn. |
| *(absent)* | Idle or not tracked. |

It is derived from output-growth heuristics plus tail classification, and is
**overridden** by an authoritative signal posted to `/sessions/{id}/signal`. Agents
that can report their own state should do so rather than relying on the heuristic —
see `sigil-notify.py` for a reference hook.

## Files and transfer

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/hosts/{name}/files` | List a directory (`?path=`, `?browse=1`) or read a file (`?path=`). |
| `POST` | `/hosts/{name}/files` | Upload. Multipart; the `dir` field **must precede** the file part. |
| `POST` | `/hosts/{name}/files/copy` | Copy on the host. |
| `POST` | `/hosts/{name}/files/move` | Move on the host. |
| `GET` | `/hosts/{name}/download` | Download a file. |
| `POST` | `/transfer` | Host-to-host transfer. |

> **Reading a path that does not exist returns `200` with `content: ""`**, not a
> 404 — so callers cannot distinguish "missing" from "empty" without a directory
> listing. A missing *directory* does return `500 list_error`, which is the usable
> existence signal.
>
> The files API is **text-oriented**: invalid UTF-8 is replaced, so binary read back
> through it is corrupted. Use `/hosts/{name}/download` for binary.

## Workspaces, layouts, triggers, prefs

| Method | Path | Purpose |
|---|---|---|
| `GET` `POST` | `/workspaces` | List / create. |
| `PATCH` `DELETE` | `/workspaces/{id}` | Update / remove. |
| `GET` `POST` | `/layouts` | Saved pane layouts. |
| `DELETE` | `/layouts/{id}` | |
| `GET` `POST` | `/triggers` | Output-matching rules (webhook and/or in-UI action). |
| `PATCH` `DELETE` | `/triggers/{id}` | |
| `GET` | `/prefs` | All preferences. |
| `POST` | `/prefs/set` | Set one. |
| `POST` | `/prefs/color` | Host/session accent colour. |
| `GET` `PUT` | `/settings` | Hub settings (scrollback, retention). |

## Misc

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | Hub health. Cheapest liveness probe. |
| `GET` | `/search` | Search across sessions. |
| `GET` | `/exec` | Run a one-shot command on a host. |
| `POST` | `/maintenance` | Vacuum / prune scrollback. |
| `GET` | `/agent-usage` | Agent token-usage rollup, for the sidebar widget. |
| `GET` | `/images` | Identity marks. |
| `GET` | `/proxy` `POST /preview` | Fetch/preview a URL for the links panel. |

---

## Streaming

### WebSocket — `/ws`

The live pane transport: terminal output, input, resize. Token required; `Origin`
is checked against `hub.allowed_origins` when set. One **channel per viewer** over
a shared tmux client, so several browsers can watch one session.

> The shared pty is sized to the **smallest** connected viewer on each axis, so no
> viewer is shown a grid it cannot draw. A small window therefore shrinks the pane
> for everyone until it disconnects.

### SSE — `GET /events`

Server-sent events for everything that is not pane output: session discovery,
activity changes, notifications. Use this rather than polling `/sessions`.

---

## Worked example

```bash
export SIGIL=http://127.0.0.1:7778/api/v1
export H="Authorization: Bearer $SIGIL_TOKEN"

curl -s -H "$H" $SIGIL/status                            # 1. hub alive?
curl -s -H "$H" $SIGIL/hosts                             # 2. hosts + status
curl -s -H "$H" -X POST $SIGIL/hosts/workstation/connect # 3. connect one
curl -s -H "$H" $SIGIL/sessions                          # 4. what's running
curl -s -H "$H" "$SIGIL/sessions/$ID/capture"            # 5. current pane
```
