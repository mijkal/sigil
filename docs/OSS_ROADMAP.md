# Sigil — OSS hardening roadmap

Working plan for taking Sigil from "works great for me" to a confident public
release. Derived from a two-part architecture review (daemon + webapp) plus a
root-cause dig into the scrollback pipeline. Ordered by phase; within a phase,
by leverage.

## Guiding architecture directives (apply to all new work)

- **Layered frontend**: a **tested logic/API layer** (transport, domain
  transforms, trigger evaluation) at the bottom → **state/hooks/context** in the
  middle → **presentational, themeable UI components** on top (a reusable kit:
  Button, Modal, Sheet, Field, etc.). No business logic in components. Every
  logic-layer module ships with unit tests.
- **Themeable throughout**: no raw hex in components — everything through CSS
  tokens; a lint rule enforces it. Light + dark must both be correct.
- **Seamless scrollback**: no "loading" states, reflows to any viewport width,
  logical-line copy (no wrap `\n`), links intact. This is the north star.
- **Triggers are first-class**: a rule on session output can fire a **webhook**
  AND/OR an **in-UI action** (flash a pane, set a background tint, play an audio
  alert, toast). Configurable per session and globally.
- **Settings are two-tier**: global defaults + per-session overrides
  (scrollback retention, vacuum, triggers, theme accents, …).

## Phase 0 — Security ✅ DONE (deployed 2026-07-15, all 6 items)

- [x] **Command injection in file/transfer paths** — replaced `eval echo` with
  a no-eval `case`-based ~ expansion (`expandTildeSh`, `internal/session/manager.go`).
  Verified: old fired injection, new treats path as literal. (files.go ×2, transfer.go)
- [x] **Constant-time token compare** — `crypto/subtle.ConstantTimeCompare` in
  both `internal/api/server.go` and `internal/ws/server.go`.
- [x] **WS origin validation** — `InsecureSkipVerify:true` (`ws/server.go:81`)
  disables Origin checks → cross-site WS hijack when `auth.method=none` + `0.0.0.0`
  bind. Add an `OriginPatterns`/allowlist (config `[hub].allowed_origins`).
- [x] **SSH host-key verification** — `ssh.InsecureIgnoreHostKey()` (`pool.go:114`).
  Add known_hosts support (config: path + TOFU option).
- [x] **PTY channel-close race** — stdout goroutine closes `ch.Output` while
  stderr may still send → panic that kills the daemon (`manager.go` ~581-624).
  Serialize with a WaitGroup/Once, or drop the separate stderr reader under a PTY.
- [x] **Per-call SSH timeouts** — thread `context.WithTimeout` through every
  `sess.Output/Run` (enumerated: discovery, attach, capture, metrics, files,
  transfer). A hung host currently pins its goroutine forever; `DiscoverAll`
  barriers on it.
- [ ] Default posture note in docs: bind, CORS `*`, auth modes, trust model.

## Phase 1 — Scrollback / copy / links (the core UX pain)

Root cause (proven on a live session): **we render the terminal's visual grid,
not logical text.** Two wrap sources — tmux visual wrap (fixable) and TUI-internal
wrap like the Claude CLI which writes real newlines and emits **zero OSC8** links.

- [x] Daemon: capture logical lines with **`capture-pane -pJ`** and take the
  **exact history slice with `-S- -E-1`** (verified: history-only = total − pane
  rows) instead of the frontend's fragile "drop last N rows".
- [ ] Daemon/util: **preserve OSC 8 hyperlinks** end-to-end; stop `stripNonSGR`
  from destroying them before render.
- [x] Frontend: **reflow-capable history rows** — logical lines that wrap via CSS
  (`white-space: pre-wrap`) so copy yields no injected `\n` and text reflows to
  any width. Kills the "hard line breaks in copied content" bug.
- [x] Frontend: link layer over logical lines (heuristic URL; OSC8
  URL detection that rejoins a URL split at exactly pane width).
- [x] Retire the wheel-up "scrollback overlay" model — Unified is now the default
  surface (no mode switch, no "loading").

## Phase 2 — Frontend re-architecture + quick wins

- [ ] Extract logic layer with tests: `SigilClient` transport already clean;
  add `lib/` domain modules (scrollback transform, url/link extract, trigger
  eval, settings) each unit-tested. Add Vitest + React Testing Library.
- [ ] Build a themeable **UI kit** (`ui/`): Button, IconButton, Modal (with
  focus-trap + Escape + focus-return), Sheet, Field, Toggle, Badge — replace
  ad-hoc inline modals (HostModal, SetupModal have no a11y today).
- [ ] Split `Sidebar.tsx` (1200+ lines) → `HostRow`, `SessionRow`, `HostModal`,
  `hostGrouping.ts`.
- [x] Delete dead code: `hooks/useChannel.ts`, `hooks/useScrollback.ts`.
- [x] Decide `@tanstack/react-query` (currently imported, **zero** uses) — remove.
- [ ] `PreviewPanel.tsx` — replace ~40 hardcoded hex colors with tokens (breaks
  light theme today). Add ESLint rule banning raw hex in `src/components`.
- [ ] Bundle: `manualChunks` split (xterm/mosaic/marked async), lazy-load
  PreviewPanel + MobileLayout. Current: single 994 KB chunk.
- [ ] ESLint + `eslint-plugin-react-hooks` (already writing disable comments
  with no ESLint installed). Gate `console.log`s behind a debug flag.

## Phase 3 — Mobile redesign (core use case) ✅ DONE (2026-07-15)

Was: hamburger→drawer tree (3 taps per switch), zero gestures, <44px targets,
emoji icons, no PWA. Rebuilt around a bottom session strip as the single switcher.

- [x] Persistent **bottom session strip** — thumb-reach, one-tap switch, trailing
  `+` opens the picker. Replaces the in-pane tab list on phones.
- [x] **Swipe between sessions** (horizontal drag → `layoutStore.cycleTab`, with a
  horizontal-dominance guard so it doesn't fight scroll/selection).
- [x] Bottom-sheet host/session picker (slide-up sheet wrapping `Sidebar`)
  replacing the full-screen sidebar overlay drawer.
- [x] Dedupe chrome: dropped the top-bar session label and, on phones, hid
  PaneView's tab list + split/close controls (kept zoom + TTY/UNI toggle).
- [x] 44px targets + inline-SVG icon set (`ui/Icons.tsx`; killed emoji on phone).
- [x] **PWA**: manifest, apple-touch-icon, theme-color, `viewport-fit=cover`,
  `env(safe-area-inset-*)` in top bar + strip.
- [ ] (deferred) **Pull-down → search** gesture — search is reachable via the
  sheet's `⌘K` palette; the dedicated pull gesture is a nice-to-have.

## Phase 4 — Triggers, media, settings, DB ✅ DONE (2026-07-15)

- [x] **Wired the trigger subsystem end-to-end**: the PTY feeder emits ephemeral,
  line-buffered `session.output` events (gated so the no-trigger default is
  zero-cost; feeder-only so concurrent attaches don't double-fire). UI actions
  (flash / bg tint / audio beep / toast) deliver over a new `trigger.action` WS
  message alongside the HMAC webhook path, with per-trigger debounce. **A
  regression** — routing session.output through the generic handlers turned a
  busy session into a toast storm — was caught and fixed (it now only feeds the
  matcher). Managed in the new Settings ▸ Triggers UI (create/edit/enable/delete).
- [x] **Media/file workflow**: already first-class — media tray, insert `@paths`
  into the focused terminal, copy/download, host↔host transfer, inline image
  preview, drag-drop upload (PreviewPanel). Paths hardened in Phase 0.
- [x] **Settings, two-tier**: `settings` table scoped `global | session:<id>`
  (migration v2). Global tier shipped in Settings ▸ Storage (retention days, max
  bytes/session, event keep, auto-vacuum); retention loop reads it live. Per-
  session override UI is the remaining follow-up (backend scope already supports
  it).
- [x] **DB growth**: `events` now pruned (bounded keep) and session.output is
  never persisted; Settings ▸ Storage exposes Prune / Reclaim / **Full VACUUM**
  (the operator path to shrink the existing 1.5 GB file at a quiet moment).
- [x] Schema versioning: replaced the swallow-all-errors `ALTER` loop with an
  append-only, transactional migration list tracked by `PRAGMA user_version`
  (`db.go`), tolerant of legacy DBs. Tests: fresh / idempotent / legacy adoption.

Follow-ups (deferred, non-blocking): per-session retention override UI; a
one-time Full VACUUM to reclaim the current 1.5 GB (operator-triggered).

## Phase 5 — Release hygiene (in progress)

- [x] **LICENSE** — MIT © 2026 Michael Gifford-Santos.
- [x] **SECURITY.md** — trust model (holds SSH), hardening checklist, private
  reporting, supported versions.
- [x] **README.md** — overview, features, quick start, config table, architecture
  sketch, dev commands.
- [x] **CONTRIBUTING.md** — setup, layout, test/lint commands, layered-arch +
  theme-token + append-only-migration conventions.
- [x] **docs/ARCHITECTURE.md** — daemon components + key flows (replay-then-live,
  scrollback, metrics, triggers, migrations) + frontend layering.
- [x] **CI** — `.github/workflows/ci.yml`: Go build/vet/test + web
  typecheck/vitest/eslint/colour-guard/build.
- [x] Trigger API is now wired (Phase 4), so nothing to cut.
- [ ] **Public GitHub mirror** — gated on your explicit go (outward-facing). Repo
  is release-ready locally; pushing it public is a one-command step when you say.

## Kept as-is (reviewed, genuinely good)

Replay ring, metrics collector, replay-then-live reconnect, InputBar
compose-on-commit, zustand store design, `SigilClient` transport boundary,
doc-comment quality, existing defense-in-depth (upload caps, path.Base, WS read
limit, gitignored secrets, HMAC webhooks). No rewrite needed.
