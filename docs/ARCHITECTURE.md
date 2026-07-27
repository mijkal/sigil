# Architecture

Sigil is two binaries and a browser client:

- **`sigild`** — the hub daemon. Holds the SSH pool, attaches to `tmux`, captures
  scrollback, collects metrics, matches triggers, and serves the API + WebSocket.
- **`sigil-web`** — a thin static server for the built React client that also
  reverse-proxies `/api` and `/ws` to `sigild` (so the browser talks to one
  origin).
- **web client** — React + xterm.js, talking to `sigild` over REST + a single
  multiplexed WebSocket.

```
                    ┌────────────────────────── sigild ──────────────────────────┐
 browser            │                                                             │
 ┌──────┐  HTTP/WS  │  api/ ── REST handlers                                      │
 │ web  │◄─────────►│  ws/  ── WebSocket: attach, replay-then-live, broadcasts    │
 │client│           │  session/ ── tmux attach, discovery, replay ring, files    │──SSH──► hosts
 └──────┘           │  ssh/ ── connection pool + host-key policy                  │        (tmux)
                    │  scrollback/ ── capture → SQLite (+ FTS5), retention        │
                    │  metrics/ ── per-host resource probes                       │
                    │  events/ ── event bus → trigger matching → webhooks/UI      │
                    │  db/  ── SQLite access + versioned migrations               │
                    └─────────────────────────────────────────────────────────────┘
```

## Key flows

### Attach & replay-then-live
Each session has an in-memory **replay ring** (`internal/replay`). The newest
attaching client becomes the ring's *feeder*; its byte stream is recorded. On
(re)attach a client gets a **replay** of the bytes it missed, then switches to the
live stream — so a dropped WebSocket resumes with no gap and no duplication. Only
the feeder records, so multiple viewers of one session don't multiply output.

### Scrollback
The feeder stream is also written to SQLite (`scrollback` table + an FTS5 index)
in flushed chunks. `tmux capture-pane -pJ` joins wrapped lines into logical lines
so copied text has no hard breaks and history reflows to any width. A retention
loop trims by age and per-session byte cap; params are read live from settings.

### Metrics
`internal/metrics` runs small `sh` probes over each SSH connection (load, memory
incl. PSI, disk, net, top processes) and pushes results to clients over the WS as
`metrics.update`.

### Triggers
`internal/events` is an in-process bus. The PTY feeder emits ephemeral,
line-buffered `session.output` events **only when triggers exist** (a lock-free
gate keeps the default path free). Each line is matched against enabled trigger
regexes; a match fires an action — an HMAC webhook, or a UI effect
(flash/tint/audio/toast) delivered to clients as a `trigger.action` message.
`session.output` is never persisted or fanned out to the generic event handlers.

### Persistence & migrations
`internal/db` wraps SQLite (WAL mode). Schema changes are an **append-only**
migration list tracked by `PRAGMA user_version` (`db.go`), each applied in a
transaction. `settings` is scoped `global | session:<id>` for two-tier config.

## Frontend layers

`lib/` (pure, tested logic) → `stores/` (zustand state) → `ui/` (themeable kit)
→ `components/` (features). Colours are CSS custom properties only, guarded by a
lint check; the app is theme-aware (light/dark) and PWA-installable.

### Identity marks (server-synced)

Resolution order: **session override → host default → generative sigil**.

- Generative mark: `name` → FNV-1a → mulberry32 PRNG → glyph; current v4
  "constellation" look. `web/src/components/Sigil.tsx` exports `Sigil`,
  `SessionGlyph`, `IdentityMark`; the logo is `sigil('sigil')`.
- Custom marks: uploaded images live in an `assets` SQLite table (migration v3),
  downscaled client-side to 256px WebP and API-capped at ~200 KB; a line-icon
  choice plus per-mark adjustments live in the shared `prefs` KV
  (`icon:<scope>`, `adj:<scope>`).
- Scope keys: `h:<host>` for a host default, `s:<host>::<session>` for a session
  override.
- APIs: `PUT/GET/DELETE /api/v1/images?scope=`, `GET/POST /api/v1/prefs`, and a
  `prefs.update` WS broadcast that carries **colours only** — clients re-fetch
  `/api/v1/prefs` to pick up image/icon changes. localStorage is a cache, never
  the source of truth.
