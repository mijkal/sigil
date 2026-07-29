// UnifiedTerminalTile — prototype of the dual-zone scroll container.
//
// Goal: kill the scrollback "mode". Scrollback isn't a separate UI overlay
// you enter and exit — it's just text that flows above the live terminal in
// the same scroll container. Scroll up to browse history (real text → real
// browser ctrl-F, real selection, real link detection later); scroll back
// down and you're auto-stuck at the bottom watching the live pane.
//
// Layout:
//   ┌──────────────────────────────┐  ← outer scroll container
//   │ history line                 │
//   │ history line  (virtualized)  │
//   │ ...                          │
//   ├──────────────────────────────┤
//   │ live xterm.js pane (rows×lh) │  ← always at the bottom
//   └──────────────────────────────┘
//
// History source for this prototype: server-side `tmux capture-pane`,
// re-fetched on a debounce after each output burst. That means lines that
// just scrolled off the live pane reappear in history with ~300 ms lag.
// Acceptable for the prototype; production would capture lines client-side
// from xterm's onLineFeed to remove the lag.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { stripNonSGR, renderLine } from '../lib/scrollback';
import { findMatches, highlightLine, type FindMatch } from '../lib/find';
import { stripDeviceAttrReports } from '../lib/termReports';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useUnwrapCopy } from '../hooks/useUnwrapCopy';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useConnectionStore } from '../stores/connectionStore';
import { useLayoutStore, paneMinimapMode, paneScrollRail } from '../stores/layoutStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useInputStore } from '../stores/inputStore';

interface Props {
  paneId: string;
  tabIdx: number;
  hostName: string;
  sessionName: string;
  sessionId: string;
  windowIndex?: number;
  visible: boolean;
  onClose: () => void;
}

const TERM_THEME = {
  // Transparent so the pane's base colour (and an optional sigil backdrop) show
  // through the live pane's default-background cells. The pane area paints the
  // real terminal colour (#0A0A0C) underneath, so with the backdrop OFF this looks
  // identical to a solid background. Cells the remote app paints with an explicit
  // colour stay opaque (as they should).
  background: 'rgba(10, 10, 12, 0)', foreground: '#E2E8F0',
  cursor: '#6366F1', cursorAccent: '#0A0A0C',
  selectionBackground: 'rgba(99, 102, 241, 0.3)',
  black: '#1E2330', red: '#EF4444', green: '#22C55E', yellow: '#F59E0B',
  blue: '#6366F1', magenta: '#A855F7', cyan: '#06B6D4', white: '#E2E8F0',
  brightBlack: '#64748B', brightRed: '#F87171', brightGreen: '#4ADE80',
  brightYellow: '#FCD34D', brightBlue: '#818CF8', brightMagenta: '#C084FC',
  brightCyan: '#22D3EE', brightWhite: '#F1F5F9',
};

// Scrollback text pipeline moved to the tested logic layer (src/lib/scrollback).

// composeFieldFocused reports whether the user is currently typing in a real
// form field (the bottom compose bar) rather than the terminal. xterm's own
// hidden input carries the class "xterm-helper-textarea"; anything else that's a
// TEXTAREA/INPUT is app chrome we must not steal focus from.
function composeFieldFocused(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae) return false;
  const tag = ae.tagName;
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
  return !ae.classList.contains('xterm-helper-textarea');
}

interface HistoryLine {
  id: number;       // React key = line index (stable across refreshes)
  html: string;     // ANSI-rendered HTML (no <br> — one line per item)
  text: string;     // plain text — what browser ctrl-F sees
  ts?: number;      // wall-clock ms when the line first arrived (post-seed only)
  color?: string;   // first SGR foreground colour in the line (for the minimap)
}

// firstColor pulls the first inline `color:#rrggbb` out of an ansi-to-html line,
// so the minimap can tint each bar with the line's terminal colour.
function firstColor(html: string): string | undefined {
  const m = html.match(/color:\s*(#[0-9a-fA-F]{3,6})/i);
  return m ? m[1] : undefined;
}

// fmtHM / fmtFull — local-time labels for the timestamp gutter.
function fmtHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtFull(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function UnifiedTerminalTile({
  paneId, tabIdx, hostName, sessionName, sessionId, windowIndex, visible,
}: Props) {
  const client = useConnectionStore(s => s.client);
  const setTabChannelId = useLayoutStore(s => s.setTabChannelId);
  const fontSize = useTerminalStore(s => s.fontSize);
  const overscan = useTerminalStore(s => s.overscan);
  const pauseScrollRefresh = useTerminalStore(s => s.pauseScrollRefresh);
  const pauseScrollRefreshRef = useRef(pauseScrollRefresh);
  useEffect(() => { pauseScrollRefreshRef.current = pauseScrollRefresh; }, [pauseScrollRefresh]);
  // Per-pane scrollback aids (toggled from the pane toolbar).
  const showTimestamps = useLayoutStore(s => s.panes.get(paneId)?.showTimestamps ?? false);
  const minimapMode = useLayoutStore(s => paneMinimapMode(s.panes.get(paneId)));
  const showMinimap = minimapMode !== 'off';   // the WIDE minimap (off by default)
  const RAIL_W = 11;                            // always-on thin scroll rail (docked, full height)
  const MINIMAP_W = 64;                         // wide minimap, left of the rail
  const showRail = useLayoutStore(s => paneScrollRail(s.panes.get(paneId)));
  // Reserve ONLY when the rail is actually drawn. The reserve and the render must
  // agree: reserve without drawing wastes a column, drawing without reserving puts
  // the rail on top of the last glyph (the original clipping bug).
  const railReserve = showRail ? RAIL_W + 8 : 0;
  const minimapReserve = minimapMode === 'docked' ? MINIMAP_W + 6 : 0; // wide docked also reserves
  const dockReserve = railReserve + minimapReserve;
  const minimapFrac = useLayoutStore(s => s.panes.get(paneId)?.minimapHeight ?? 0.5);
  const setMinimapHeight = useLayoutStore(s => s.setMinimapHeight);
  // Per-client soft-wrap: when enabled AND the session is a plain shell (not a
  // full-screen TUI), the live tail is rendered as reflowing logical lines so
  // each client wraps to its own width. altOn (alternate screen active) forces
  // the shared xterm grid regardless, so TUIs like claude/vim are never mangled.
  const softWrap = useLayoutStore(s => s.panes.get(paneId)?.softWrap ?? false);
  const [altOn, setAltOn] = useState(true);
  const softWrapRef = useRef(softWrap);
  const altOnRef = useRef(true);
  useEffect(() => { softWrapRef.current = softWrap; }, [softWrap]);
  // Effective live-view mode: reflow the live tail as logical lines only when
  // soft-wrap is on and no TUI is on the alternate screen.
  const liveAsLogical = softWrap && !altOn;
  // False until the first capture is seeded; lines added after that get a
  // wall-clock arrival stamp (seed lines are historical — time unknown).
  const seededRef = useRef(false);

  const lineHeight = useMemo(() => Math.round(fontSize * 1.4), [fontSize]);
  // Monospace advance width (px per char) for the current font size. Measured off
  // a canvas so it needs no DOM insertion/layout. Lets us compute wrapped-row
  // heights DETERMINISTICALLY (chars ÷ columns) instead of measuring each row with
  // a ResizeObserver — the measure-then-correct reflow is what flashed black on scroll.
  const charW = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return fontSize * 0.6;
    ctx.font = `${fontSize}px 'JetBrains Mono', 'Cascadia Code', monospace`;
    return ctx.measureText('M'.repeat(100)).width / 100 || fontSize * 0.6;
  }, [fontSize]);

  // Outer scroll container, history list, live xterm mount
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const channelIdRef = useRef<string | null>(null);
  // Replay cursor: seq of the last channel.output/replay byte consumed for
  // this session. Sent on re-attach so the hub replays only the missed tail.
  const lastSeqRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<{ rows: number; cols: number } | null>(null);
  // The EFFECTIVE pty grid reported by the hub. Viewers of one session share a
  // single tmux client, so the pty is sized to the smallest of them — it can be
  // smaller than this tile could display. tmux then paints only `rows` lines and
  // every row below keeps whatever was drawn there before, which is the
  // stuck-text artifact. We therefore size our xterm to the pty, not to our own
  // fit(): the dead region stops existing rather than holding an old frame.
  const effGridRef = useRef<{ rows: number; cols: number } | null>(null);

  // History — virtualized rows above the live pane. Keyed by line index so an
  // unchanged line keeps its DOM node across refreshes (native selection and
  // ctrl-F survive); prevRaw/prevHistory let us reuse object refs for untouched
  // lines so React skips them and we only re-render the parts that changed.
  const [history, setHistory] = useState<HistoryLine[]>([]);
  const prevRawRef = useRef<string[]>([]);
  const prevHistoryRef = useRef<HistoryLine[]>([]);

  // Stick-to-bottom: when true, every history change auto-scrolls to bottom.
  // User scrolling up unsticks; scrolling back to within 24px re-sticks.
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  // Visible height of the scroll container — the live pane fills it so the
  // terminal (and the tmux pane / any full-screen TUI like claude) gets the FULL
  // pane height, not a fixed 24-row strip with stale history filling the rest.
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  // How many chars fit per visual row (viewport minus the row's 12px×2 padding).
  // With break-all wrapping this is EXACT, so ceil(len/cols) gives the true row
  // height with no measurement needed.
  const cols = useMemo(
    () => Math.max(20, Math.floor((viewportW - 24 - dockReserve) / charW)),
    [viewportW, charW, dockReserve],
  );

  // Repair wrap-broken URLs on copy (scrollback rows AND the live grid).
  useUnwrapCopy(containerRef, terminalRef, cols);

  // ── Find-in-pane ──────────────────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchList, setFindMatchList] = useState<FindMatch[]>([]);
  const [findIdx, setFindIdx] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLCanvasElement>(null);

  // Refresh-from-server debounce
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshing = useRef(false);
  // Set when a refresh was skipped because the user is scrolled up (frozen list);
  // flushed the moment they re-stick to the live bottom so nothing is missed.
  const pendingRefreshRef = useRef(false);

  // ── Scroll-back paging from the durable pipe log ──────────────────────────
  // The capture window is bounded (~8k lines); to see further back, older lines
  // are prepended from the pipe log on scroll-up. archiveMode freezes the live
  // rebuild so the archive isn't clobbered; returning to the live bottom drops it
  // and resumes (memory stays bounded — the archive only exists while reading up).
  const archiveModeRef = useRef(false);
  const archiveBytesRef = useRef(0);      // bytes fetched from the pipe tail so far
  const archiveDoneRef = useRef(false);   // reached the start of the pipe log
  const archiveIdRef = useRef(-1);        // monotonic negative ids for archive rows
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const ARCHIVE_HARD_CAP = 50000;         // stop paging when the working set is this big

  // ── Refresh history from tmux capture-pane ────────────────────────────────
  const refreshHistory = useCallback(async () => {
    if (!client || refreshing.current) return;
    // Frozen while the user is paging OLDER history (archive prepended from the
    // pipe log) — a capture rebuild would overwrite the prepended lines. Flushed
    // when they return to the live bottom (see the stuck effect).
    if (archiveModeRef.current) { pendingRefreshRef.current = true; return; }
    // Freeze the scrollback rebuild while the user is scrolled up reading history.
    // New output only appends at the (off-screen) bottom, so rebuilding the list
    // now would just churn stable content underfoot and flash black mid-scroll.
    // Mark it pending; the re-stick effect flushes it when they return to live.
    if (pauseScrollRefreshRef.current && !stuckRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    // NOTE: do NOT gate on xterm's buffer type. Under tmux the OUTER terminal is
    // permanently in the alternate screen (tmux draws its client UI there), so
    // `buffer.active.type` is ALWAYS 'alternate' — using it as a "full-screen app
    // is active" proxy froze the history forever (only the live pane updated;
    // scrollback went stale). capture-pane reflects the pane's real content, so
    // just re-capture on every tick.
    refreshing.current = true;
    try {
      const { text, altOn: alt } = await client.captureScrollback(sessionId);
      // Track alternate-screen state so the live view can switch between the
      // shared xterm grid (TUI) and per-client logical-line reflow (shell).
      if (alt !== altOnRef.current) { altOnRef.current = alt; setAltOn(alt); }
      const cleaned = stripNonSGR(text);
      let lines = cleaned.split('\n');
      // A single trailing newline yields an empty final element — drop it.
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      // capture-pane returns scrollback + the live screen. Normally the live
      // screen (bottom `rows` lines) is drawn by the xterm pane below, so we drop
      // it here to avoid rendering it twice. But in soft-wrap shell mode the
      // xterm grid is hidden and the logical-line list IS the live view, so we
      // keep every line (each client reflows the tail to its own width).
      const liveLogical = softWrapRef.current && !altOnRef.current;
      if (!liveLogical) {
        // Trim by the PTY's rows, not our own grid's. capture-pane returns
        // scrollback + the live screen, and the live screen is exactly as tall
        // as the pty. Trimming by a larger local grid ate real scrollback that
        // the live pane never draws, so those lines vanished from the view.
        const rows = effGridRef.current?.rows ?? terminalRef.current?.rows ?? 24;
        lines = lines.length > rows ? lines.slice(0, lines.length - rows) : [];
      }
      // Trim trailing blank scrollback so history sits flush against the live pane.
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

      // Bound the in-memory scrollback working set. The server already caps the
      // capture window; this is a safety net so a runaway session can never grow
      // the tab's memory without limit (the old code kept the entire history +
      // two more copies → OOM tab crashes). Keep the most-recent MAX_HISTORY lines.
      const MAX_HISTORY = 10000;
      if (lines.length > MAX_HISTORY) lines = lines.slice(lines.length - MAX_HISTORY);

      // Nothing changed since last capture → skip the re-render entirely
      // (avoids selection churn + CPU on every output burst).
      const prevRaw = prevRawRef.current;
      if (lines.length === prevRaw.length && lines.every((l, i) => l === prevRaw[i])) return;

      // Reuse prior objects (and their rendered HTML) for unchanged indices so
      // React skips them; only render new/changed lines. New lines (only after
      // the initial seed) get a wall-clock arrival stamp for the timestamp gutter.
      const prevHist = prevHistoryRef.current;
      const seeded = seededRef.current;
      const now = Date.now();
      const next: HistoryLine[] = lines.map((line, i) => {
        if (line === prevRaw[i] && prevHist[i]) return prevHist[i];
        const html = renderLine(line);
        return {
          id: i,
          html,
          text: line.replace(/\x1b\[[0-9;]*m/g, ''),
          ts: seeded ? now : undefined,
          color: firstColor(html),
        };
      });
      seededRef.current = true;
      prevRawRef.current = lines;
      prevHistoryRef.current = next;
      setHistory(next);
    } catch {
      // empty history is fine
    } finally {
      refreshing.current = false;
    }
  }, [client, sessionId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    // In soft-wrap shell mode the logical-line list is the live view, so refresh
    // faster to keep typed echo snappy; otherwise the xterm pane shows live output
    // instantly and history can lag a touch.
    const delay = (softWrapRef.current && !altOnRef.current) ? 70 : 150;
    refreshTimerRef.current = setTimeout(refreshHistory, delay);
  }, [refreshHistory]);

  // Re-capture immediately when the effective live-view mode changes (soft-wrap
  // toggled, or a TUI entered/left the alternate screen). The keep-vs-drop rule
  // for the live rows differs between modes, so without this an idle shell would
  // blank its live tail the instant soft-wrap turns on — the rows were dropped in
  // grid mode and nothing re-adds them until the next output tick.
  useEffect(() => {
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [softWrap, altOn]);

  // Prepend an older chunk of history from the pipe log (triggered on scroll-up).
  const loadOlder = useCallback(async () => {
    if (!client || loadingOlderRef.current || archiveDoneRef.current) return;
    if (history.length >= ARCHIVE_HARD_CAP) { archiveDoneRef.current = true; setAtStart(true); return; }
    loadingOlderRef.current = true;
    archiveModeRef.current = true;   // freeze the live rebuild — snapshot the view
    setLoadingOlder(true);
    try {
      const CHUNK = 262144; // 256 KB per page (the pipe API reads a tail; grows each page)
      const want = archiveBytesRef.current + CHUNK;
      const { text, reset } = await client.getPipedScrollbackFrom(sessionId, -want);
      archiveBytesRef.current = want;
      const reachedStart = reset || text.length < want - 8; // got less than asked → whole log
      const plines = stripNonSGR(text).split('\n');
      if (plines.length && plines[plines.length - 1] === '') plines.pop();
      const ptext = plines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
      // Seam: locate the current oldest lines within the pipe tail and keep only
      // what's strictly above them (no overlap). Match a short sequence for
      // robustness; fall back to line-count alignment if rendering diverged.
      const anchor = history.slice(0, 10).map(h => h.text);
      let seam = -1;
      for (let i = ptext.length - anchor.length; i >= 0 && anchor.length; i--) {
        let ok = true;
        for (let j = 0; j < anchor.length; j++) if (ptext[i + j] !== anchor[j]) { ok = false; break; }
        if (ok) { seam = i; break; }
      }
      const keep = seam >= 0 ? seam : Math.max(0, plines.length - history.length);
      if (keep <= 0) {
        if (reachedStart) { archiveDoneRef.current = true; setAtStart(true); }
        return;
      }
      const baseId = archiveIdRef.current;
      archiveIdRef.current -= keep;
      const older: HistoryLine[] = [];
      for (let i = 0; i < keep; i++) {
        const html = renderLine(plines[i]);
        older.push({ id: baseId - i, html, text: ptext[i], color: firstColor(html) });
      }
      // Deterministic heights → anchor the viewport exactly: prepending shifts
      // content down by prependH, so add it to scrollTop after paint.
      const prependH = older.reduce(
        (s, h) => s + Math.max(1, Math.ceil((h.text.length || 1) / cols)) * lineHeight, 0);
      setHistory(h => older.concat(h));
      requestAnimationFrame(() => { const e = containerRef.current; if (e) e.scrollTop += prependH; });
      if (reachedStart) { archiveDoneRef.current = true; setAtStart(true); }
    } catch { /* best-effort — leave the view as-is */ }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [client, sessionId, history, cols, lineHeight]);

  // ── Virtualizer for history ───────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: history.length,
    getScrollElement: () => containerRef.current,
    // Deterministic wrapped-row height: a logical line of N chars wraps to
    // ceil(N/cols) visual rows, each exactly lineHeight px (line-height is fixed
    // on the container). No ResizeObserver, no measure-then-correct reflow —
    // the virtualizer knows every row's true size before it paints.
    estimateSize: (i) => Math.max(1, Math.ceil((history[i]?.text.length || 1) / cols)) * lineHeight,
    // Overscan = pre-rendered rows above/below the viewport (a buffer so a fast
    // fling doesn't outrun React's re-render and flash the black background).
    // Bigger = less black at the cost of more DOM. Tunable in Settings → Terminal.
    overscan,
  });

  // Invalidate the virtualizer's size cache whenever the reshape inputs change:
  // a resize/font change alters cols (every row's wrap count), and a history
  // rebuild (classic capture-pane refresh) can shift what line lives at each
  // index. Cheap — estimateSize is pure arithmetic — and it keeps positions
  // exact so nothing drifts into overlap or a black gap.
  useEffect(() => { virtualizer.measure(); }, [cols, lineHeight, history]);

  // ── Stick-to-bottom bookkeeping ───────────────────────────────────────────
  const onContainerScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distanceFromBottom < 24;
    if (next !== stuckRef.current) {
      stuckRef.current = next;
      setStuck(next);
    }
    // Near the top while scrolled up → page older history from the pipe log.
    if (!next && el.scrollTop < el.clientHeight * 1.5) loadOlder();
  }, [loadOlder]);

  // Flush a skipped refresh the instant the user returns to the live bottom.
  // Keyed on `stuck` so it fires for every re-stick path — scroll-to-bottom,
  // InputBar submit, and the jump-to-live button all flip this state.
  useEffect(() => {
    if (stuck && archiveModeRef.current) {
      // Back at the live bottom → drop the paged archive, unfreeze, and let the
      // next capture rebuild replace history with the bounded window (frees memory).
      archiveModeRef.current = false;
      archiveBytesRef.current = 0;
      archiveDoneRef.current = false;
      archiveIdRef.current = -1;
      setAtStart(false);
      pendingRefreshRef.current = true;
    }
    if (stuck && pendingRefreshRef.current) {
      pendingRefreshRef.current = false;
      refreshHistory();
    }
  }, [stuck, refreshHistory]);

  // Auto-scroll on history growth when stuck
  useEffect(() => {
    if (stuckRef.current && containerRef.current) {
      // Defer to next paint so virtualizer measures new rows
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [history.length, lineHeight]);

  // ── Re-stick to live when the InputBar submits ────────────────────────────
  // The bar bumps stickNonce[channelId] on submit; jump back to the bottom so
  // a submit from scrolled-back history snaps the user to the live pane.
  useEffect(() => useInputStore.subscribe((state, prev) => {
    const cid = channelIdRef.current;
    if (!cid) return;
    if ((state.stickNonce[cid] ?? 0) !== (prev.stickNonce[cid] ?? 0)) {
      stuckRef.current = true;
      setStuck(true);
      const el = containerRef.current;
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }), []);

  // ── Live terminal ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current || !client) return;

    const terminal = new Terminal({
      theme: TERM_THEME,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
      fontSize,
      lineHeight: 1.3,
      // We own scrollback now — the React-virtualized history list above
      // is the user-visible scrollback. Keep a small xterm buffer so transient
      // wrap continuations work, but it's not the user-facing scrollback.
      scrollback: 200,
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: false,
      // Let the transparent theme background composite over the pane base + backdrop.
      allowTransparency: true,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch { /* canvas fallback */ }

    terminal.open(termRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    if (!composeFieldFocused()) terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fit;

    const doAttach = () => {
      if (channelIdRef.current) return;
      const { rows, cols } = terminal;
      client.attach(hostName, sessionName, rows, cols, windowIndex, lastSeqRef.current);
    };

    // Auto-re-attach after an *unexpected* channel close (transient SSH session
    // end, server-side blip). Without this a live pane stays dead until the
    // next remount or WS reconnect — the "closing and not resurrecting" bug.
    // Exponential backoff, capped, so a genuinely dead session can't spin into
    // a tight attach loop.
    let reattachAttempts = 0;
    let reattachTimer: ReturnType<typeof setTimeout> | undefined;
    let attachedAt = 0;
    const MAX_REATTACH = 12;
    // See TerminalTile: the hub emits channel.attached before `tmux attach` can
    // fail, so a dead session still yields a brief attached/closed pair. Only a
    // channel that survives DURABLE_MS counts as success — otherwise the counter
    // reset below makes this backoff dead code and the pane spins ~2 attaches/sec
    // against a session that no longer exists.
    const DURABLE_MS = 10_000;
    const scheduleReattach = () => {
      if (reattachTimer || channelIdRef.current) return;
      if (reattachAttempts >= MAX_REATTACH) return;
      const delay = Math.min(500 * 2 ** reattachAttempts, 8000);
      reattachAttempts++;
      reattachTimer = setTimeout(() => {
        reattachTimer = undefined;
        if (client.isConnected() && !channelIdRef.current) doAttach();
      }, delay);
    };

    const unsubDisconnect = client.on('disconnect', () => {
      channelIdRef.current = null;
      setTabChannelId(paneId, tabIdx, undefined);
    });
    if (client.isConnected()) doAttach();
    const unsubConnect = client.on('connect', () => doAttach());

    // Size our grid to what the pty ACTUALLY is. Without this a tile taller than
    // the shared pty keeps rows tmux will never repaint, and they hold the last
    // frame drawn there — the stuck-text bug.
    const applyEffectiveGrid = (rows?: number, cols?: number) => {
      if (!rows || !cols) return;
      effGridRef.current = { rows, cols };
      // Publish the authoritative wrap column so link extraction can rejoin
      // hard-wrapped URLs without having to infer the width from repeats.
      try { useTerminalStore.getState().setSessionCols(sessionId, cols); } catch { /* ignore */ }
      const t = terminalRef.current;
      if (t && (t.rows !== rows || t.cols !== cols)) {
        try { t.resize(cols, rows); } catch { /* ignore */ }
      }
      // The history/live seam is defined by the pty's rows, so re-cut it.
      refreshHistory();
    };

    const unsubAttached = client.on('channel.attached', (payload, chId) => {
      const p = payload as {
        host_name: string; session_name: string; channel_id?: string;
        rows?: number; cols?: number;
      };
      const cid = chId || p.channel_id;
      if (p.host_name === hostName && p.session_name === sessionName && cid) {
        channelIdRef.current = cid;
        attachedAt = Date.now();
        setTabChannelId(paneId, tabIdx, cid);
        if (pendingResizeRef.current) {
          client.resize(cid, pendingResizeRef.current.rows, pendingResizeRef.current.cols);
          pendingResizeRef.current = null;
        }
        applyEffectiveGrid(p.rows, p.cols);
        // Initial seed
        refreshHistory();
      }
    });

    // The effective grid moved (a co-viewer joined, left, or resized).
    const unsubGrid = client.on('channel.grid', (payload, chId) => {
      if (chId && chId !== channelIdRef.current) return;
      const p = payload as { rows?: number; cols?: number };
      applyEffectiveGrid(p.rows, p.cols);
    });

    // Replay-then-live: the hub sends the buffered tail we missed (from our
    // last_seq cursor) right after channel.attached, before any live output.
    const unsubReplay = client.on('channel.replay', (payload, chId) => {
      if (chId !== channelIdRef.current) return;
      const p = payload as { data?: string; next_seq?: number };
      if (p.data) {
        const binary = atob(p.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        terminal.write(bytes);
        scheduleRefresh();
      }
      if (typeof p.next_seq === 'number') lastSeqRef.current = p.next_seq;
    });

    const unsubOutput = client.on('channel.output', (payload, chId) => {
      if (chId !== channelIdRef.current) return;
      // Binary frame → bytes already decoded; JSON frame → base64 in `data`.
      const p = payload as { data?: string; bytes?: Uint8Array; seq?: number };
      let bytes: Uint8Array;
      if (p.bytes) {
        bytes = p.bytes;
      } else if (p.data) {
        const binary = atob(p.data);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else {
        return;
      }
      terminal.write(bytes);
      if (typeof p.seq === 'number' && p.seq > 0) lastSeqRef.current = p.seq;
      // Debounced server-side refetch — the line that just scrolled off the
      // live pane reappears at the tail of historical scrollback shortly after.
      scheduleRefresh();
    });

    const unsubClosed = client.on('channel.closed', (_payload, chId) => {
      if (chId !== channelIdRef.current) return;
      // Only a durable channel counts as a successful attach; see DURABLE_MS.
      if (attachedAt && Date.now() - attachedAt >= DURABLE_MS) reattachAttempts = 0;
      attachedAt = 0;
      channelIdRef.current = null;
      // Resurrect the live channel — the tmux session is usually still alive and
      // only the sigil channel dropped. If it isn't, the backoff gives up.
      scheduleReattach();
    });

    // A line scrolling off the live viewport is the moment it should appear in
    // history — refresh promptly (debounced) rather than only on output bursts.
    const onLineFeed = terminal.onLineFeed(() => scheduleRefresh());

    const onData = terminal.onData((data: string) => {
      if (!channelIdRef.current) return;
      // Drop DA1/DA2/DA3 identity reports that xterm auto-emits when a device-
      // attributes query (from tmux/app probes, often replayed) is written into
      // it. Forwarding them as PTY input is what leaks `1;2c0;276;0c` onto the
      // shell prompt. Real keystrokes never match this shape. See lib/termReports.
      const clean = stripDeviceAttrReports(data);
      if (!clean) return;
      client.sendInput(channelIdRef.current, new TextEncoder().encode(clean));
    });

    const onBinary = terminal.onBinary((data: string) => {
      if (!channelIdRef.current) return;
      const clean = stripDeviceAttrReports(data);
      if (!clean) return;
      const bytes = new Uint8Array(clean.length);
      for (let i = 0; i < clean.length; i++) bytes[i] = clean.charCodeAt(i);
      client.sendInput(channelIdRef.current, bytes);
    });

    // Report CAPACITY when the container resizes — how much this tile could
    // show — and let the hub decide the effective grid (it must also satisfy any
    // co-viewer). Deliberately not fit(): fit() would resize the terminal to our
    // container and undo the pty-matched size applied by applyEffectiveGrid,
    // re-creating the rows tmux never paints. The grid is only ever set from the
    // hub's answer; before the first answer we fall back to fit() so the pane has
    // a sane size to attach with.
    const reportCapacity = () => {
      try {
        const d = fit.proposeDimensions();
        const rows = d?.rows, cols = d?.cols;
        if (!rows || !cols || !Number.isFinite(rows) || !Number.isFinite(cols)) return;
        if (!effGridRef.current) { try { fit.fit(); } catch { /* ignore */ } }
        if (channelIdRef.current) client.resize(channelIdRef.current, rows, cols);
        else pendingResizeRef.current = { rows, cols };
      } catch { /* ignore */ }
    };
    const ro = new ResizeObserver(() => reportCapacity());
    ro.observe(termRef.current);

    return () => {
      unsubDisconnect();
      unsubConnect();
      unsubAttached();
      unsubGrid();
      unsubReplay();
      unsubOutput();
      unsubClosed();
      onLineFeed.dispose();
      onData.dispose();
      onBinary.dispose();
      ro.disconnect();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (reattachTimer) clearTimeout(reattachTimer);
      if (channelIdRef.current) {
        client.detach(channelIdRef.current);
        channelIdRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hostName, sessionName]);

  // Update font on store change
  useEffect(() => {
    const t = terminalRef.current;
    const f = fitAddonRef.current;
    if (t && f) {
      t.options.fontSize = fontSize;
      try { f.fit(); } catch { /* ignore */ }
    }
  }, [fontSize]);

  // Re-report capacity + focus when tab becomes visible
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      try {
        // Same rule as the ResizeObserver: publish what we COULD draw; the pty's
        // actual size comes back via channel.grid. Calling fit() here would
        // stomp the pty-matched grid and resurrect the unpainted rows.
        const d = fitAddonRef.current?.proposeDimensions();
        if (!effGridRef.current) { try { fitAddonRef.current?.fit(); } catch { /* ignore */ } }
        if (channelIdRef.current && d?.rows && d?.cols) {
          client?.resize(channelIdRef.current, d.rows, d.cols);
        }
        // Only grab focus if the user isn't typing in another form field — e.g.
        // the bottom compose bar. Without this guard xterm's helper textarea
        // steals focus and keystrokes meant for the compose bar hit the terminal.
        if (!composeFieldFocused()) terminalRef.current?.focus();
      } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, client]);

  // Own scrollback in Unified mode: redirect wheel over the live xterm pane to
  // the React scroll container instead of letting it reach xterm/tmux. Otherwise
  // a mouse-mode tmux enters copy-mode on a scroll-back gesture — the "orange row
  // that breaks the pane midway". In alternate screen (vim/less/TUI) the app
  // legitimately wants the wheel, so pass it through there.
  useEffect(() => {
    const el = termRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const onWheel = (e: WheelEvent) => {
      // If an app in the pane has enabled mouse tracking (vim, less, a TUI), let
      // it have the wheel. Only at a plain shell prompt (no tracking) do we own
      // the scroll and route it into the history container. This relies on tmux
      // mouse-mode being OFF while sigil is attached (see the daemon's attach
      // command) — otherwise tmux itself enables tracking and swallows every
      // wheel into copy-mode (the "orange row" bug). Under tmux the xterm buffer
      // is always 'alternate', so buffer type can't be used to detect this.
      if (terminalRef.current?.modes.mouseTrackingMode !== 'none') return;
      e.preventDefault();
      e.stopPropagation();
      container.scrollTop += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // Track the container's visible height so the live pane fills it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => { setViewportH(el.clientHeight); setViewportW(el.clientWidth); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit the terminal (and resize the tmux pane) whenever the viewport height
  // changes, so the full-height live pane maps to a full-height tmux window.
  useEffect(() => {
    if (!viewportH) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        if (channelIdRef.current && terminalRef.current) {
          const { rows, cols } = terminalRef.current;
          client?.resize(channelIdRef.current, rows, cols);
        }
        if (stuckRef.current && containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [viewportH, client]);

  // Open find when ⌘F targets this channel (App bumps findNonce for the focused
  // channel via the input store).
  useEffect(() => useInputStore.subscribe((state, prev) => {
    const cid = channelIdRef.current;
    if (!cid) return;
    if ((state.findNonce[cid] ?? 0) !== (prev.findNonce[cid] ?? 0)) {
      setFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.select());
    }
  }), []);

  // Recompute matches when the query changes — highlight only, do NOT move the
  // view (the user pages with next/prev). Deliberately NOT keyed on `history`:
  // new output appends at the bottom, so top-indexed rows stay valid and we
  // don't re-scan on every output tick.
  useEffect(() => {
    if (!findOpen || !findQuery) { setFindMatchList([]); return; }
    setFindMatchList(findMatches(history.map(h => h.text), findQuery));
    setFindIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery]);

  // Step to the next/prev match and scroll it into view.
  const stepMatch = (delta: 1 | -1) => {
    if (!findMatchList.length) return;
    const n = (findIdx + delta + findMatchList.length) % findMatchList.length;
    setFindIdx(n);
    stuckRef.current = false; setStuck(false);
    requestAnimationFrame(() => virtualizer.scrollToIndex(findMatchList[n].row, { align: 'center' }));
  };

  const closeFind = useCallback(() => {
    setFindOpen(false); setFindQuery(''); setFindMatchList([]);
    if (!composeFieldFocused()) terminalRef.current?.focus();
  }, []);

  // Rows that contain a match + the active match's location, for render highlight.
  const findRowSet = useMemo(() => new Set(findMatchList.map(m => m.row)), [findMatchList]);
  const curMatch = findMatchList[findIdx];

  // ── Minimap + scroll rail ───────────────────────────────────────────────────
  // Draw one faint bar per history line (width ∝ length); find-match rows glow in
  // accent so the map doubles as a match-distribution overview (VS Code style). The
  // same paint drives the always-on thin rail (full height) and the optional wide
  // minimap; the narrow rail just uses a smaller pad.
  useEffect(() => {
    const paint = (cv: HTMLCanvasElement | null) => {
      if (!cv) return;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      const N = history.length || 1;
      const rowH = H / N;
      const barH = Math.min(1.5, Math.max(0.75, rowH));
      const step = rowH < 0.75 ? Math.ceil(0.75 / rowH) : 1;
      const cs = getComputedStyle(cv);
      const muted = cs.getPropertyValue('--color-muted').trim() || '#64748B';
      const accent = cs.getPropertyValue('--color-accent').trim() || '#818CF8';
      const PAD = W < 24 ? 1.5 : 6; // thin rail needs a tiny pad or bars vanish
      for (let i = 0; i < history.length; i++) {
        const isMatch = findRowSet.has(i);
        if (i % step !== 0 && !isMatch) continue;
        const len = history[i].text.trim().length;
        if (!len && !isMatch) continue;
        const y = (i / N) * H;
        const w = Math.min(1, len / 90) * (W - PAD * 2);
        const lineColor = history[i].color;
        ctx.fillStyle = isMatch ? accent : (lineColor || muted);
        ctx.globalAlpha = isMatch ? 0.85 : (lineColor ? 0.5 : 0.2);
        ctx.fillRect(PAD, y, isMatch ? W - PAD * 2 : Math.max(1.5, w), barH);
      }
    };
    paint(railRef.current);            // always-on rail
    if (showMinimap) paint(minimapRef.current);
  }, [showMinimap, minimapMode, history, findRowSet, viewportH, minimapFrac]);

  // Scrub either overview (rail or wide minimap) → scroll to that row.
  const scrubMinimap = (e: React.MouseEvent) => {
    if (!history.length) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    stuckRef.current = false; setStuck(false);
    virtualizer.scrollToIndex(Math.floor(frac * history.length), { align: 'start' });
  };
  // Drag the bottom grip to resize the minimap strip. It's anchored to the top,
  // so dragging the bottom edge down (dy>0) makes it taller by dy.
  const resizeDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const panelH = viewportH || 1;
    const startY = e.clientY;
    const startFrac = minimapFrac;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;           // drag down (dy>0) → taller
      setMinimapHeight(paneId, startFrac + dy / panelH);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Visible history range → minimap viewport lens. Use the virtualizer's TRUE
  // visible `range` (getVirtualItems is padded by overscan-30 and would draw the
  // lens larger than what's actually on screen).
  const vItems = virtualizer.getVirtualItems();
  const vRange = virtualizer.range;
  const vpFirst = vRange ? vRange.startIndex : (vItems.length ? vItems[0].index : 0);
  const vpLast = vRange ? vRange.endIndex : (vItems.length ? vItems[vItems.length - 1].index : 0);

  // ── Render ────────────────────────────────────────────────────────────────
  // The live pane fills the container's visible height (viewportH). Fallback to a
  // 24-row min while the viewport is being measured on first paint.
  const livePaneMinPx = viewportH || lineHeight * 24;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {findOpen && (
        <FindBar
          inputRef={findInputRef}
          query={findQuery}
          setQuery={setFindQuery}
          count={findMatchList.length}
          index={findIdx}
          onNext={() => stepMatch(1)}
          onPrev={() => stepMatch(-1)}
          onClose={closeFind}
        />
      )}
    <div
      ref={containerRef}
      onScroll={onContainerScroll}
      className="sigil-unified-scroll"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'auto',
        // The always-on rail (below) IS the scroll affordance (click-to-jump +
        // drag-scrub), so the native scrollbar beside it is redundant and would
        // crowd/overlay the last column. Hide it (Firefox here, WebKit via the
        // .sigil-unified-scroll rule in index.css) — content clears the rail via
        // railReserve instead.
        scrollbarWidth: 'none',
        // Transparent so an optional pane sigil backdrop shows through behind the
        // scrollback text; the pane area under it paints the terminal base colour.
        background: 'transparent',
        fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
        fontSize,
        lineHeight: `${lineHeight}px`,
        color: '#E2E8F0',
        // Shift the timestamp gutter left of the minimap when it's shown.
        // Timestamps sit left of the rail (always) + the wide minimap (when shown).
        ['--sigil-ts-right' as string]: `${railReserve + (showMinimap ? MINIMAP_W + 6 : 0)}px`,
      } as CSSProperties}
    >
      {/* Scroll-back paging indicator — pinned to the top of the scroll viewport. */}
      {(loadingOlder || atStart) && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3, textAlign: 'center',
          padding: '3px 0', fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
          color: 'var(--color-muted)', pointerEvents: 'none',
          background: 'color-mix(in srgb, var(--color-panel) 82%, transparent)',
          backdropFilter: 'blur(4px)',
        }}>
          {loadingOlder ? '⋯ loading earlier history' : '— beginning of session —'}
        </div>
      )}
      {/* Virtualized historical scrollback */}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(v => {
          const line = history[v.index];
          const base = (findOpen && findQuery && findRowSet.has(v.index))
            ? highlightLine(line.text, findQuery, curMatch && curMatch.row === v.index ? curMatch.start : -1)
            : line.html;
          // Timestamp gutter: show a label only at minute boundaries (a "sensible
          // interval") so it stays subtle; hover shows the exact time.
          const prevLine = history[v.index - 1];
          const showRowTs = showTimestamps && line.ts &&
            (!prevLine?.ts || Math.floor(line.ts / 60000) !== Math.floor(prevLine.ts / 60000));
          const rowHtml = showRowTs && line.ts
            ? `${base}<span class="sigil-ts" title="${fmtFull(line.ts)}">${fmtHM(line.ts)}</span>`
            : base;
          return (
            <div
              key={line.id}
              data-index={v.index}
              // Hover any timestamped row for its exact time (the visible gutter
              // labels only appear at minute boundaries to stay subtle).
              title={showTimestamps && line.ts ? fmtFull(line.ts) : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
                // Right padding reserves the docked overview column (scroll rail,
                // plus the wide minimap when docked) so a full-width scrollback row
                // wraps BEFORE it instead of running under it — the rail paints at
                // zIndex 6 and was clipping the last character column. It also keeps
                // the real wrap width identical to the `cols` math the virtualizer
                // sizes rows with (viewportW - 24 - dockReserve), so estimated and
                // actual row heights stay in lockstep.
                padding: `0 ${12 + dockReserve}px 0 12px`,
                // pre-wrap + break-all: a long LOGICAL line (tmux -J joined)
                // reflows at the exact column width, breaking mid-token like a
                // real terminal. Character-wrapping (not word-wrapping) makes the
                // visual-row count exactly ceil(len/cols) — which is what the
                // virtualizer's estimateSize computes, so rows never drift into
                // overlap or a black gap and no per-row measurement is needed.
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
              // Native browser ctrl-F finds this; native selection works.
              dangerouslySetInnerHTML={{ __html: rowHtml }}
            />
          );
        })}
      </div>

      {/* Live xterm.js pane. In soft-wrap shell mode the logical-line list above
          IS the live view, so the grid is taken out of flow and made invisible —
          but kept full-size so FitAddon still measures real rows/cols and the
          terminal keeps consuming output + carrying keystrokes (onData→sendInput).
          The instant a TUI grabs the alternate screen, altOn flips and it snaps
          back into flow as the shared grid. */}
      <div
        ref={termRef}
        style={liveAsLogical ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: livePaneMinPx,
          // Same reserve as the visible branch: this hidden grid is what FitAddon
          // measures to size tmux, and in soft-wrap mode the logical rows it feeds
          // are laid out with the dockReserve padding — so tmux must be sized to
          // the same visible width, not to the full pane.
          padding: `0 ${dockReserve}px 0 4px`,
          opacity: 0,
          pointerEvents: 'none',
          zIndex: -1,
        } : {
          width: '100%',
          minHeight: livePaneMinPx,
          // Reserve the whole docked overview column on the right (rail + docked
          // minimap) so the live grid — a TUI like claude/vim fills every column —
          // never renders under it. FitAddon measures this padded box, so tmux is
          // sized to what's actually visible.
          padding: `0 ${dockReserve}px 0 4px`,
        }}
      />

      {/* Jump-to-live — a frosted circular chevron. Kept mounted and faded/slid
          in when scrolled up (subtle), so it eases in/out instead of popping. */}
      {history.length > 0 && (
        <button
          onClick={() => {
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          title="Jump to live"
          aria-label="Jump to live"
          style={{
            position: 'sticky',
            bottom: 16,
            marginLeft: 'auto',
            // Sits left of the always-on rail; when the wide minimap is shown it
            // centres under that column (the minimap is top-anchored ≤50% so the
            // lower area is always free for the button).
            marginRight: showMinimap ? railReserve + 6 + (MINIMAP_W - 38) / 2 : railReserve + 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 38,
            height: 38,
            borderRadius: '50%',
            background: 'color-mix(in srgb, var(--color-accent) 30%, transparent)',
            backdropFilter: 'blur(10px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(10px) saturate(1.4)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)',
            color: 'var(--color-text)',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
            // Subtle ease in/out: fade + a small lift, non-interactive when hidden.
            opacity: stuck ? 0 : 1,
            transform: stuck ? 'translateY(6px) scale(0.94)' : 'translateY(0) scale(1)',
            pointerEvents: stuck ? 'none' : 'auto',
            transition: 'opacity 0.18s ease-out, transform 0.18s ease-out',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>

      {/* Thin scroll rail — full pane height, docked at the right edge; text wraps
            before it (railReserve). OFF by default: the unified scrollback already
            scrolls by wheel and drag-scrub, so the rail is a position cue you opt
            into rather than a column of width every pane pays. */}
        {showRail && history.length > 0 && (
        <div
          style={{
            position: 'absolute', right: 6, top: 8, bottom: 8, width: RAIL_W,
            zIndex: 6, cursor: 'pointer', overflow: 'hidden', borderRadius: 5,
            background: 'color-mix(in srgb, var(--color-bg) 28%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-border) 65%, transparent)',
          }}
          onMouseDown={scrubMinimap}
          onMouseMove={(e) => { if (e.buttons === 1) scrubMinimap(e); }}
          title="Scroll rail — click to jump"
        >
          <canvas ref={railRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          <div style={{
            position: 'absolute', left: 1, right: 1, pointerEvents: 'none',
            top: `${(vpFirst / history.length) * 100}%`,
            height: `max(8px, ${(Math.max(1, vpLast - vpFirst + 1) / history.length) * 100}%)`,
            background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 60%, transparent)',
            borderRadius: 2,
          }} />
        </div>
      )}

      {/* Wide minimap — optional (default OFF), to the LEFT of the rail, ≤50% tall
          (top-anchored, so the jump-to-live button always sits below it). Overlay
          floats over the text; docked reserves its own column. Grip resizes it. */}
      {showMinimap && history.length > 0 && (
        <div
          style={{
            position: 'absolute', right: railReserve + 6, top: 8,
            width: MINIMAP_W, height: `${Math.min(minimapFrac, 0.5) * 100}%`, maxHeight: '50%',
            zIndex: 6, cursor: 'pointer', overflow: 'hidden', borderRadius: 8,
            background: 'color-mix(in srgb, var(--color-bg) 30%, transparent)',
            backdropFilter: 'blur(8px) saturate(1.3)',
            WebkitBackdropFilter: 'blur(8px) saturate(1.3)',
            border: '1px solid color-mix(in srgb, var(--color-border) 80%, transparent)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.28)',
          }}
          onMouseDown={scrubMinimap}
          onMouseMove={(e) => { if (e.buttons === 1) scrubMinimap(e); }}
          title="Scrollback overview — click to jump"
        >
          <canvas ref={minimapRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          <div style={{
            position: 'absolute', left: 2, right: 2, pointerEvents: 'none',
            top: `${(vpFirst / history.length) * 100}%`,
            height: `max(6px, ${(Math.max(1, vpLast - vpFirst + 1) / history.length) * 100}%)`,
            background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 65%, transparent)',
            borderRadius: 3,
            boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent) 40%, transparent)',
          }} />
          <div
            onPointerDown={resizeDrag}
            onMouseDown={(e) => e.stopPropagation()}
            title="Drag to resize"
            style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, height: 10,
              cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div style={{ width: 22, height: 3, borderRadius: 2, background: 'color-mix(in srgb, var(--color-muted) 70%, transparent)' }} />
          </div>
        </div>
      )}
    </div>
  );
}

// FindBar — the slim find-in-pane overlay (top-right of the tile). Enter / ↓ next,
// Shift+Enter / ↑ prev, Esc close.
function FindBar({ inputRef, query, setQuery, count, index, onNext, onPrev, onClose }: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  setQuery: (v: string) => void;
  count: number;
  index: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute', top: 8, right: 14, zIndex: 30,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 6px 5px 10px', borderRadius: 8,
        background: 'color-mix(in srgb, var(--color-panel) 90%, transparent)',
        backdropFilter: 'blur(18px) saturate(1.6)', WebkitBackdropFilter: 'blur(18px) saturate(1.6)',
        border: '1px solid var(--color-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder="Find in pane…"
        spellCheck={false}
        style={{
          background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--color-text)', fontSize: 12, fontFamily: 'var(--font-mono)', width: 150,
        }}
      />
      <span style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', minWidth: 42, textAlign: 'right' }}>
        {count ? `${index + 1}/${count}` : (query ? '0/0' : '')}
      </span>
      <button onClick={onPrev} disabled={!count} title="Previous (Shift+Enter)" style={findBtn}>↑</button>
      <button onClick={onNext} disabled={!count} title="Next (Enter)" style={findBtn}>↓</button>
      <button onClick={onClose} title="Close (Esc)" style={findBtn}>✕</button>
    </div>
  );
}

const findBtn: CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--color-muted)', fontSize: 12, lineHeight: 1, padding: '2px 5px', borderRadius: 4,
};
