# Sigil — Gotchas, protocols & hard rules (full text)

Every hard-won rule, with the evidence that produced it. Nothing here may be
deleted without the reason being disproven — these are conclusions from real
incidents, not style preferences.

## 1. Do NOT run destructive/mutating probes on live state

sigild holds the user's live sessions plus a scrollback DB with retention/prune
logic. **Read the code path first** — identify eviction/cleanup/watchdog logic
before probing. This has bitten hard:

- Starting a scratch `tmux new` on a target disabled the
  skip-prune-when-discovery-returns-zero safety net and **permanently pruned
  zombie DB rows (with the cwds the user still wanted)**.
- A "controlled" `tmux kill-server` test wiped freshly recreated sessions.

If the only way to test is on live state, surface the risk and get explicit
consent FIRST. "Just one quick probe" is the moment to stop.

## 2. sigild is a HUB, not a per-host agent

- sigild runs ONLY on the hub host (192.0.2.10). Do NOT look for sigild on a target
  host. When "sigil-web seems dead", check **target reachability first** — a down
  target makes the UI look broken while the hub is perfectly healthy.
- Live persistence depends on the **target's tmux server**, not sigild. After a
  target reboot its tmux dies → DB rows are zombies until fresh tmux starts
  (named sessions auto-resurrect).
- `discovery returned zero sessions while DB has records — skipping prune` = SSH
  reached the host but no tmux server is running there. Normal defensive log.
- **a Linux host-local sigild is GONE (2026-07-17).** Any memory saying "MC needs the
  a Linux host-local sigild / do not disable it" is STALE — Mission Control points at
  the hub (`MC_SIGIL_BASE=http://192.0.2.10:7778`). Do not reinstall it.
  (The a Linux host `~/.local/share/sigil/logs/` dir was KEPT — the hub host writes
  a Linux host's pipe-pane logs there over SSH.)
- Config subtlety: hosts are NOT only from `config.toml [[hosts]]`.
  `cmd/sigild/main.go` upserts config hosts into the DB `hosts` table, then
  reloads ALL DB hosts back into cfg on startup. Editing config.toml alone won't
  drop a host — you must also `DELETE FROM hosts` in the DB (with sigild
  stopped).

## 3. Shared-pty sizing — "stuck text" (root-caused and FIXED 2026-07-26)

Commits `1047e31` / merge `3196a1e`. **This section describes current behaviour;
the bug below is history, not a live defect.**

The bug: every viewer of one session shares a single tmux client, and
`applySizeLocked` sized the shared pty to the SMALLEST rows and cols any viewer
asked for. Minimising *cols* is harmless (tmux paints a narrower window, wider
viewers get blank space beside it). Minimising *ROWS* is not — tmux paints only
`rows` lines and the taller viewer's remaining xterm rows keep whatever was drawn
there before. Nothing repaints them, so the pane showed a frozen slab of an older
frame (classically the Claude TUI footer stranded mid-pane with dead output
below). Reproduced with a 60-row and a 20-row WS viewer on one scratch session:
the pane went 60x200 → 20x200 and **stayed there 182 s** after the small viewer
left.

Current behaviour, in three parts:

1. **The hub publishes the effective grid.** `channel.attached` now carries
   `rows`/`cols`, and a new `channel.grid` message announces later changes. A
   viewer sizes its terminal to the *pty*, so the unpaintable region stops
   existing instead of holding a stale frame. Both tiles report **capacity**
   (`proposeDimensions`) on resize and **must not call `fit()` once the hub has
   answered** — `fit()` resizes the grid back to the container and resurrects the
   dead rows.
2. **Ghost channels no longer constrain the grid.** A viewer whose socket dropped
   is kept ~3 min as a replay feeder; its last requested size used to count for
   the whole grace period. `DetachAfter` now marks the ghost and re-applies the
   grid immediately. If *every* remaining viewer is a ghost we still count them,
   so the pty can never collapse to zero.
3. **Seam trimming uses the pty's rows.** `UnifiedTerminalTile` cut the
   history/live seam using its OWN rows, but `capture-pane`'s live screen is as
   tall as the PTY — when the local grid was taller it over-trimmed and silently
   ate real scrollback.

Regression cover: `internal/session/grid_test.go` (sizing, ghost release,
notification fan-out).

## 4. Deploy protocol (highest-stakes)

- **The user keeps LIVE WIP tmux sessions on the hub host.** Frontend changes
  ship via **`make deploy-web`** (rsync + atomic `dist` swap, NO daemon restart).
  Do NOT use `make deploy` for frontend-only work — it runs
  `systemctl restart sigild sigil-web`. tmux survives a sigild restart and
  re-attaches, but avoid restarts during WIP unless the user explicitly clears it.
- A change needs `make deploy` (full, with restart) ONLY when the **Go backend /
  sigild** itself changes (new API, prefs sync, migrations, …).
- Deploy is **the hub host-only** (`cc@192.0.2.10`). Source arrives via Syncthing; the
  Makefile pushes `web/dist` + binaries because `dist/` is Syncthing-excluded.
  Never hand-edit the deployed binary/dist — always go through the Makefile.
- **Never bump versions or deploy without explicit approval** (standing rule).

See [SETUP.md](SETUP.md) for installation and [CONFIGURATION.md](CONFIGURATION.md)
for the full option reference.

## 5. UI house rules (enforced by lint / CONTRIBUTING.md)

- **Icons over emoji — ALWAYS.** UI chrome uses monochrome inline SVGs from
  `web/src/components/icons.tsx` (inherit `currentColor` + size). Never ship an
  emoji as a UI glyph (no 🔔 / 🔗 / 📁 / ⬤). Add a new icon rather than an emoji.
  Plain typographic marks (arrows, ✓, ✕) are fine. Known debt:
  `PreviewPanel.tsx` `fileIcon()` still returns file-type emoji.
- **Theme tokens only.** Colours come from `var(--color-*)`; the lint guard
  `web/scripts/lint-colors.sh` (part of `npm run lint`) FAILS on raw hex in
  themeable components. Light and dark must both be correct.
- **Plain tmux only — never zellij** (or any multiplexer) inside a tmux/sigil
  session. zellij's status bar / floating-pane ANSI broke sigil's scrollback
  rendering. rc guards must include `-z "$TMUX"` so the block is skipped under
  any sigil attach.
- Touch targets ≥ 44px on mobile.

## 6. Branding / design rules

- **Dial BACK the occult** in the generative sigil marks — less pentagram /
  summoning-circle, more rune / alchemical / star-chart. Current mark = v4
  "constellation".
- **The generator must be bounded:** the ring-node walk can spin forever if the
  stride shares a factor with the ring point count (fewer than N distinct nodes).
  Guard the loop.
- Perf: a per-mark `feGaussianBlur` + `drop-shadow` on every sidebar/tab sigil is
  heavy — fall back to a filled dot at tiny sizes (≤ ~6px tab), full sigil only
  where there is room. Three perf tiers exist in `Sigil.tsx`.
- Never call Sigil "AI" — it is a terminal session hub.

## 7. Code conventions

- **Migrations are append-only.** Add to the `migrations` slice in
  `internal/db/db.go`; never edit or reorder an existing entry. Tracked by
  `PRAGMA user_version`.
- Layered web architecture: pure logic in `lib/` (tested, no React/DOM) →
  `stores/` → `ui/` primitives → `components/`. Keep components thin.
- Before every PR: `make test`, `make lint`, and
  `cd web && npx tsc --noEmit && npx vitest run && npm run lint`.
  Conventional-commit messages.

## 8. Identity-mark edge cases

- Renaming a session **orphans** its custom image/icon (keyed to the name; not
  migrated the way accent colours are). Accent colours DO migrate on rename.
- The `prefs.update` WS broadcast payload is colours-only → clients must
  **re-fetch** `GET /api/v1/prefs` and re-hydrate. Do not trust the broadcast
  body for images/icons.

## 9. Security posture

- sigild holds SSH access to every configured host; a bearer token gates the web
  UI/API/WS. Run on a trusted network (LAN/VPN/Tailscale) or behind a
  TLS-terminating reverse proxy (Caddy).
- `host_key_mode` defaults to `tofu`: unknown keys are recorded, **CHANGED keys
  are rejected** — so a stale `known_hosts` entry for a dial address reads as a
  MITM mismatch and the connection is refused.
- See `SECURITY.md` for the published trust model and
  `docs/OSS_ROADMAP.md` Phase 0 for the audited-and-fixed list.
