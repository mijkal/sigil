import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollbackPanel } from './ScrollbackPanel';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useUnwrapCopy } from '../hooks/useUnwrapCopy';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import type { ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useConnectionStore } from '../stores/connectionStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useInputStore } from '../stores/inputStore';
import { stripDeviceAttrReports } from '../lib/termReports';

interface TerminalTileProps {
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
  background: '#0A0A0C',
  foreground: '#E2E8F0',
  cursor: '#6366F1',
  cursorAccent: '#0A0A0C',
  selectionBackground: 'rgba(99, 102, 241, 0.3)',
  black: '#1E2330',
  red: '#EF4444',
  green: '#22C55E',
  yellow: '#F59E0B',
  blue: '#6366F1',
  magenta: '#A855F7',
  cyan: '#06B6D4',
  white: '#E2E8F0',
  brightBlack: '#64748B',
  brightRed: '#F87171',
  brightGreen: '#4ADE80',
  brightYellow: '#FCD34D',
  brightBlue: '#818CF8',
  brightMagenta: '#C084FC',
  brightCyan: '#22D3EE',
  brightWhite: '#F1F5F9',
};


export function TerminalTile({
  paneId,
  tabIdx,
  hostName,
  sessionName,
  sessionId,
  windowIndex,
  visible,
}: TerminalTileProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const channelIdRef = useRef<string | null>(null);
  // Replay cursor: seq of the last channel.output/replay byte consumed for
  // this session. Sent on re-attach so the hub replays only the missed tail.
  const lastSeqRef = useRef<number | null>(null);
  // Resize that arrived before channel.attached — flushed once channel is known
  const pendingResizeRef = useRef<{ rows: number; cols: number } | null>(null);
  // EFFECTIVE pty grid from the hub. Viewers of one session share a tmux client
  // sized to the smallest of them, so the pty can be smaller than this tile.
  // tmux paints only `rows` lines; every row below keeps its previous contents
  // forever. Sizing our grid to the pty makes that dead region cease to exist.
  const effGridRef = useRef<{ rows: number; cols: number } | null>(null);
  // Repair wrap-broken URLs on copy — a selected login link must paste whole.
  useUnwrapCopy(termRef, terminalRef, 0);

  const client = useConnectionStore(s => s.client);
  const setTabChannelId = useLayoutStore(s => s.setTabChannelId);
  const fontSize = useTerminalStore(s => s.fontSize);

  // Scroll mode: show a server-captured scrollback overlay over the live terminal.
  // The terminal keeps running underneath; no xterm buffer switching needed.
  const [scrollMode, setScrollMode] = useState(false);
  const scrollModeRef = useRef(false);
  // Ref to the exit function defined inside the effect (needs terminal in closure for focus)
  const exitScrollModeFnRef = useRef<(() => void) | null>(null);

  // Select mode: an overlay div captures mouse events and drives xterm's
  // selection API directly, bypassing PTY mouse-reporting entirely.
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(false);
  const selectStartRef = useRef<{ col: number; row: number } | null>(null);
  const [copied, setCopied] = useState(false);


  // URL detection moved to the status-bar "links" control (LinksPopover), which
  // scans the raw pipe-pane log for exact, wrap-proof URLs. The old bottom-overlay
  // URL bar that scanned the wrapped xterm grid is gone (it obscured the live pane
  // and truncated/malformed wrapped links). Inline click-to-open links are kept
  // below via registerLinkProvider.

  // Update font size on all live terminals when the store changes
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      try { fitAddonRef.current.fit(); } catch { /* ignore */ }
    }
  }, [fontSize]);

  // Re-fit and focus when tab becomes visible
  useEffect(() => {
    if (visible) {
      const raf = requestAnimationFrame(() => {
        try {
          const d = fitAddonRef.current?.proposeDimensions();
          if (!effGridRef.current) { try { fitAddonRef.current?.fit(); } catch { /* ignore */ } }
          // Flush capacity in case dimensions changed while hidden
          if (channelIdRef.current && d?.rows && d?.cols) {
            client?.resize(channelIdRef.current, d.rows, d.cols);
          }
          terminalRef.current?.focus();
        } catch { /* ignore */ }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [visible, client]);

  useEffect(() => {
    if (!termRef.current || !client) return;

    const terminal = new Terminal({
      theme: TERM_THEME,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
      fontSize,
      lineHeight: 1.3,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    fitAddonRef.current = fitAddon;

    // Inline link provider — handles terminal-wrapped lines (click to open).
    // Multi-line URLs split by actual \n are detected via the raw-text buffer
    // and surfaced in the URL panel widget — no xterm coordinate acrobatics.
    const INLINE_URL_RE = /https?:\/\/[^\s\]'"`)>]+/g;
    terminal.registerLinkProvider({
      provideLinks(lineIndex: number, callback: (links: ILink[] | undefined) => void) {
        const buffer = terminal.buffer.active;
        const cols = terminal.cols;
        // Collect the full terminal-wrap group for this line
        let startBufY = lineIndex - 1;
        while (startBufY > 0 && buffer.getLine(startBufY)?.isWrapped) startBufY--;
        const parts: string[] = [];
        for (let y = startBufY; y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (!line) break;
          parts.push(line.translateToString(false));
          if (!buffer.getLine(y + 1)?.isWrapped) break;
        }
        const joined = parts.join('');
        const startY1 = startBufY + 1;
        INLINE_URL_RE.lastIndex = 0;
        const links: ILink[] = [];
        let m: RegExpExecArray | null;
        while ((m = INLINE_URL_RE.exec(joined)) !== null) {
          const s = m.index, e = s + m[0].length - 1;
          const uri = m[0];
          links.push({
            range: {
              start: { x: (s % cols) + 1, y: startY1 + Math.floor(s / cols) },
              end:   { x: (e % cols) + 2, y: startY1 + Math.floor(e / cols) },
            },
            text: uri,
            activate(_ev: MouseEvent) { window.open(uri, '_blank'); },
            hover() { if (termRef.current) termRef.current.style.cursor = 'pointer'; },
            leave() { if (termRef.current) termRef.current.style.cursor = ''; },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    terminal.open(termRef.current);

    // ── Scrollback overlay ────────────────────────────────────────────────────
    // On scroll-up in alternate screen we show a ScrollbackPanel overlay that
    // fetches rendered output via tmux capture-pane. The live terminal keeps
    // running underneath — no xterm buffer switching, no output buffering.
    function enterScrollMode() {
      if (scrollModeRef.current) return;
      scrollModeRef.current = true;
      setScrollMode(true);
    }

    function exitScrollMode() {
      if (!scrollModeRef.current) return;
      scrollModeRef.current = false;
      setScrollMode(false);
      terminal.focus();
    }
    exitScrollModeFnRef.current = exitScrollMode;

    // Custom key handlers (return false = don't forward to PTY)
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Cmd-K / Ctrl-K: clear terminal (mirrors iTerm2 behaviour)
      if ((event.metaKey || event.ctrlKey) && event.key === 'k' && event.type === 'keydown') {
        event.stopPropagation();
        terminal.clear();
        return false;
      }
      // Ctrl+Shift+C: toggle select mode
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown') {
        event.stopPropagation();
        event.preventDefault();
        const next = !selectModeRef.current;
        selectModeRef.current = next;
        setSelectMode(next);
        if (!next) terminal.focus();
        return false;
      }
      // Escape: exit scroll mode or select mode (when active)
      if (event.key === 'Escape' && event.type === 'keydown') {
        if (scrollModeRef.current) {
          exitScrollMode();
          return false;
        }
        if (selectModeRef.current) {
          selectModeRef.current = false;
          setSelectMode(false);
          terminal.focus();
          return false;
        }
      }
      return true;
    });

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // canvas fallback
    }

    // Fit NOW before attaching so PTY is created at correct dimensions
    try { fitAddon.fit(); } catch { /* ignore */ }
    terminal.focus();
    terminalRef.current = terminal;

    const doAttach = () => {
      if (channelIdRef.current) return; // already attached
      const { rows, cols } = terminalRef.current ?? terminal;
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
    // A channel must survive this long before we call the attach a success. The
    // hub emits channel.attached as soon as the remote process spawns, which is
    // *before* `tmux attach` can fail — so a dead session still produces a brief
    // attached/closed pair. Resetting the counter on attach alone therefore made
    // the backoff below dead code: every cycle reset it to 500ms and MAX_REATTACH
    // was never reached, spinning ~2 attaches/sec against a session that no longer
    // exists (which starves the host's sshd MaxSessions and hides its other
    // sessions from the sidebar).
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

    // When WS disconnects, all server-side channels are dead — clear the ref
    // so doAttach() will re-attach when the connection comes back up.
    const unsubDisconnect = client.on('disconnect', () => {
      channelIdRef.current = null;
      setTabChannelId(paneId, tabIdx, undefined);
    });

    // Attach immediately if WS is already open, otherwise wait for connect event
    if (client.isConnected()) {
      doAttach();
    }
    // Also re-attach whenever the connection comes up (initial or after reconnect)
    const unsubConnect = client.on('connect', () => doAttach());

    const applyEffectiveGrid = (rows?: number, cols?: number) => {
      if (!rows || !cols) return;
      effGridRef.current = { rows, cols };
      const t = terminalRef.current;
      if (t && (t.rows !== rows || t.cols !== cols)) {
        try { t.resize(cols, rows); } catch { /* ignore */ }
      }
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
        // Flush any resize that arrived before the channel was known
        if (pendingResizeRef.current) {
          client.resize(cid, pendingResizeRef.current.rows, pendingResizeRef.current.cols);
          pendingResizeRef.current = null;
        }
        applyEffectiveGrid(p.rows, p.cols);
      }
    });

    // Effective grid moved (co-viewer joined, left, or resized).
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
      // Terminal receives output even when scrollback overlay is visible —
      // it stays current underneath, no buffering or flushing needed.
      terminal.write(bytes);
      if (typeof p.seq === 'number' && p.seq > 0) lastSeqRef.current = p.seq;
    });

    const unsubClosed = client.on('channel.closed', (payload, chId) => {
      if (chId !== channelIdRef.current) return;
      const p = payload as { reason?: string };
      // Only a channel that stayed up counts as a successful attach; see
      // DURABLE_MS. A short-lived one means the session is gone, so we let the
      // counter keep climbing until MAX_REATTACH stops us.
      if (attachedAt && Date.now() - attachedAt >= DURABLE_MS) reattachAttempts = 0;
      attachedAt = 0;
      channelIdRef.current = null;
      const givingUp = reattachAttempts >= MAX_REATTACH;
      terminal.writeln(
        givingUp
          ? `\r\n\x1b[2m(session closed${p.reason ? ': ' + p.reason : ''} — gave up reconnecting; the session may no longer exist)\x1b[0m`
          : `\r\n\x1b[2m(session closed${p.reason ? ': ' + p.reason : ''} — reconnecting…)\x1b[0m`
      );
      // Resurrect the live channel — the tmux session is usually still alive and
      // only the sigil channel dropped. If it isn't, the backoff above gives up.
      scheduleReattach();
    });

    const onData = terminal.onData((data: string) => {
      if (!channelIdRef.current) return;
      // Strip DA1/DA2/DA3 identity reports (see lib/termReports) so xterm's
      // auto-replies to replayed/live device-attribute probes don't leak onto
      // the shell prompt as `1;2c0;276;0c`.
      const clean = stripDeviceAttrReports(data);
      if (!clean) return;
      const encoder = new TextEncoder();
      client.sendInput(channelIdRef.current, encoder.encode(clean));
    });

    const onBinary = terminal.onBinary((data: string) => {
      if (!channelIdRef.current) return;
      const clean = stripDeviceAttrReports(data);
      if (!clean) return;
      const bytes = new Uint8Array(clean.length);
      for (let i = 0; i < clean.length; i++) bytes[i] = clean.charCodeAt(i);
      client.sendInput(channelIdRef.current, bytes);
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        // Publish what this tile COULD draw and let the hub pick the effective
        // grid (it must satisfy co-viewers too). Not fit(): that would resize
        // the terminal to our container and undo the pty-matched size, bringing
        // back rows tmux never paints. fit() only runs before the first answer.
        const d = fitAddon.proposeDimensions();
        const r = d?.rows, c = d?.cols;
        if (!r || !c || !Number.isFinite(r) || !Number.isFinite(c)) return;
        if (!effGridRef.current) { try { fitAddon.fit(); } catch { /* ignore */ } }
        if (channelIdRef.current) {
          client.resize(channelIdRef.current, r, c);
        } else {
          // Channel not yet known — store for flush after attach
          pendingResizeRef.current = { rows: r, cols: c };
        }
      } catch { /* ignore */ }
    });

    resizeObserver.observe(termRef.current);

    // Wheel interceptor: when tmux is in alternate screen, wheel events would
    // normally be forwarded as arrow keys (DECSET 1007), causing bash history
    // navigation instead of scrolling.
    //
    // Use capture phase so we intercept BEFORE xterm.js processes the event.
    // In alternate screen: prevent xterm from ever seeing the event, then show
    // the scrollback overlay. In normal screen: do nothing (xterm scrolls its
    // own viewport buffer as usual).
    const el = termRef.current;
    const wheelHandler = (e: WheelEvent) => {
      if (scrollModeRef.current) {
        // Overlay is visible — let the overlay div handle its own scroll.
        return;
      }
      if (terminal.buffer.active.type === 'alternate') {
        // Alternate screen (tmux/vim/etc): prevent forwarding wheel as arrow keys,
        // and open the scrollback overlay on wheel-up.
        e.preventDefault();
        e.stopPropagation();
        if (e.deltaY < 0 && channelIdRef.current) {
          enterScrollMode();
        }
      }
    };
    el.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    // Touch scroll support for iPad/mobile.
    // xterm.js only processes mouse events — touch events are silently ignored,
    // so swiping does nothing out of the box.
    let touchStartY = 0;
    let touchLastY = 0;
    const touchStartHandler = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
      touchLastY = touchStartY;
    };
    const touchMoveHandler = (e: TouchEvent) => {
      const currentY = e.touches[0].clientY;
      const deltaY = touchLastY - currentY; // positive = finger moving up = scroll down
      touchLastY = currentY;
      if (scrollModeRef.current) {
        // Overlay is visible — it's a regular scrollable div, touch events
        // bubble up to it naturally; nothing to do here.
        return;
      } else if (terminal.buffer.active.type === 'alternate') {
        e.preventDefault();
        // Upward swipe → open scrollback overlay (same as wheel-up)
        const totalDelta = touchStartY - currentY;
        if (totalDelta > 30 && channelIdRef.current) {
          enterScrollMode();
        }
      } else {
        e.preventDefault();
        const pixelsPerLine = (terminal.options.lineHeight ?? 1.3) * (terminal.options.fontSize ?? 14);
        terminal.scrollLines(Math.round(deltaY / pixelsPerLine));
      }
    };
    el.addEventListener('touchstart', touchStartHandler, { passive: true });
    el.addEventListener('touchmove', touchMoveHandler, { passive: false });

    return () => {
      unsubDisconnect();
      unsubConnect();
      unsubAttached();
      unsubGrid();
      unsubReplay();
      unsubOutput();
      unsubClosed();
      onData.dispose();
      onBinary.dispose();
      if (reattachTimer) clearTimeout(reattachTimer);
      resizeObserver.disconnect();
      el.removeEventListener('wheel', wheelHandler, { capture: true });
      el.removeEventListener('touchstart', touchStartHandler);
      el.removeEventListener('touchmove', touchMoveHandler);
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

  const exitScrollModeCallback = useCallback(() => {
    exitScrollModeFnRef.current?.();
  }, []);

  // Re-stick to live when the InputBar submits: close any scrollback overlay so
  // a submit from scrolled-back history drops the user back to the live pane.
  useEffect(() => useInputStore.subscribe((state, prev) => {
    const cid = channelIdRef.current;
    if (!cid) return;
    if ((state.stickNonce[cid] ?? 0) !== (prev.stickNonce[cid] ?? 0)) {
      exitScrollModeFnRef.current?.();
    }
  }), []);

  const captureScrollback = useCallback(async (sid: string) => {
    if (!client) throw new Error('not connected');
    // The classic tile only needs the rendered text (alt-screen state is a
    // unified-mode soft-wrap concern).
    return (await client.captureScrollback(sid)).text;
  }, [client]);

  const getPipedScrollback = useCallback(async (sid: string) => {
    if (!client) throw new Error('not connected');
    return client.getPipedScrollback(sid);
  }, [client]);

  const exitSelect = () => {
    selectModeRef.current = false;
    selectStartRef.current = null;
    setSelectMode(false);
    terminalRef.current?.focus();
  };

  const doSelectMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const term = terminalRef.current;
    const div = e.currentTarget;
    if (!term) return;
    const rect = div.getBoundingClientRect();
    const col = Math.max(0, Math.floor((e.clientX - rect.left)  / (rect.width  / term.cols)));
    const row = Math.max(0, Math.floor((e.clientY - rect.top)   / (rect.height / term.rows)));
    selectStartRef.current = { col, row };
    term.clearSelection();
  };

  const doSelectMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const term = terminalRef.current;
    const start = selectStartRef.current;
    if (!term || !start || !e.buttons) return;
    const div = e.currentTarget;
    const rect = div.getBoundingClientRect();
    const cols = term.cols;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rect.left)  / (rect.width  / cols))));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((e.clientY - rect.top) / (rect.height / term.rows))));
    const s = start.row * cols + start.col;
    const cur = row * cols + col;
    if (cur >= s) term.select(start.col, start.row, cur - s + 1);
    else          term.select(col, row, s - cur + 1);
  };

  const doSelectMouseUp = () => {
    selectStartRef.current = null;
    const text = terminalRef.current?.getSelection() ?? '';
    if (!text) return;
    const copy = (t: string) => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
      } else {
        fallbackCopy(t);
      }
    };
    const fallbackCopy = (t: string) => {
      const ta = document.createElement('textarea');
      ta.value = t;
      Object.assign(ta.style, { position: 'fixed', top: '-9999px', opacity: '0' });
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch { /* best effort */ }
      document.body.removeChild(ta);
    };
    copy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={termRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Select-mode overlay — sits above the terminal, intercepts all mouse
          events and drives xterm's selection API directly so PTY mouse-reporting
          is never involved. */}
      {selectMode && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 20, cursor: 'text', userSelect: 'none' }}
          onMouseDown={doSelectMouseDown}
          onMouseMove={doSelectMouseMove}
          onMouseUp={doSelectMouseUp}
        />
      )}

      {/* SELECT badge — top-right */}
      {selectMode && (
        <div onClick={exitSelect} style={{
          position: 'absolute', top: 8, right: 8, zIndex: 30,
          background: copied ? 'rgba(34,197,94,0.9)' : 'rgba(99,102,241,0.9)',
          color: '#fff', fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
          padding: '3px 8px', borderRadius: 4, cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 6,
          transition: 'background 0.2s',
        }}>
          <span>{copied ? 'COPIED!' : 'SELECT'}</span>
          {!copied && <span style={{ opacity: 0.7, fontWeight: 400 }}>✕</span>}
        </div>
      )}

      {/* Scrollback overlay — fetches tmux capture-pane, fully scrollable */}
      {scrollMode && (
        <ScrollbackPanel
          sessionId={sessionId}
          onClose={exitScrollModeCallback}
          captureScrollback={captureScrollback}
          getPipedScrollback={getPipedScrollback}
        />
      )}
    </div>
  );
}
