import { create } from 'zustand';

const KEY = 'sigil_font_size';
const UNIFIED_KEY = 'sigil_unified_terminal';
const BINARY_KEY = 'sigil_binary_ws';
const OVERSCAN_KEY = 'sigil_overscan';
const PAUSE_SCROLL_KEY = 'sigil_pause_scroll_refresh';
const DEFAULT = 14;
const MIN = 8;
const MAX = 32;
const OVERSCAN_DEFAULT = 160;
const OVERSCAN_MIN = 20;
const OVERSCAN_MAX = 500;

interface TerminalStore {
  fontSize: number;
  unified: boolean;
  // Binary WS hot-path (channel.output/input as raw frames vs base64-in-JSON).
  binaryWs: boolean;
  // Scrollback virtualizer overscan — pre-rendered rows above/below the viewport.
  // Bigger = less black flash on fast scroll, at the cost of more DOM.
  overscan: number;
  // Freeze the scrollback rebuild while the user is scrolled up reading history
  // (the list only grows at the bottom, which they aren't looking at) so a fast
  // scroll glides over stable content instead of the list churning underfoot.
  pauseScrollRefresh: boolean;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
  toggleUnified: () => void;
  toggleBinaryWs: () => void;
  setOverscan: (n: number) => void;
  togglePauseScrollRefresh: () => void;
  // Effective pty grid width per session, published by the terminal tile.
  //
  // Link extraction has to rejoin URLs the terminal hard-wrapped, and it used to
  // INFER the wrap column by finding a line length that recurs 3+ times. That
  // works on a busy pane but fails on a quiet one: a 340-char URL fills 4 rows at
  // 80 cols but only 2 at 120, so on a wide pane an auth URL printed to an
  // otherwise clean screen produced no repeats and was never rejoined — the exact
  // case (a login URL, alone on screen) where you reach for the Links list.
  // The pty width is authoritative, so publish it rather than guessing.
  sessionCols: Record<string, number>;
  setSessionCols: (sessionId: string, cols: number) => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessionCols: {},
  setSessionCols: (sessionId: string, cols: number) => set((st) => (
    !sessionId || !cols || st.sessionCols[sessionId] === cols
      ? st
      : { sessionCols: { ...st.sessionCols, [sessionId]: cols } }
  )),
  fontSize: Math.max(MIN, Math.min(MAX, parseInt(localStorage.getItem(KEY) ?? String(DEFAULT)) || DEFAULT)),
  // Unified (seamless scroll) is now the default; only an explicit opt-out ('0')
  // falls back to the classic wheel-up-overlay tile.
  unified: localStorage.getItem(UNIFIED_KEY) !== '0',
  // Binary WS is now the default; explicit '0' opts back to JSON (base64).
  binaryWs: localStorage.getItem(BINARY_KEY) !== '0',
  overscan: Math.max(OVERSCAN_MIN, Math.min(OVERSCAN_MAX,
    parseInt(localStorage.getItem(OVERSCAN_KEY) ?? String(OVERSCAN_DEFAULT)) || OVERSCAN_DEFAULT)),
  // Default ON — smoother, and the frozen tail catches up the moment you re-stick.
  pauseScrollRefresh: localStorage.getItem(PAUSE_SCROLL_KEY) !== '0',

  increase: () => set(s => {
    const n = Math.min(s.fontSize + 1, MAX);
    localStorage.setItem(KEY, String(n));
    return { fontSize: n };
  }),

  decrease: () => set(s => {
    const n = Math.max(s.fontSize - 1, MIN);
    localStorage.setItem(KEY, String(n));
    return { fontSize: n };
  }),

  reset: () => {
    localStorage.setItem(KEY, String(DEFAULT));
    return { fontSize: DEFAULT };
  },

  toggleUnified: () => set(s => {
    const n = !s.unified;
    localStorage.setItem(UNIFIED_KEY, n ? '1' : '0');
    return { unified: n };
  }),

  toggleBinaryWs: () => set(s => {
    const n = !s.binaryWs;
    localStorage.setItem(BINARY_KEY, n ? '1' : '0');
    return { binaryWs: n };
  }),

  setOverscan: (n) => set(() => {
    const v = Math.max(OVERSCAN_MIN, Math.min(OVERSCAN_MAX, Math.round(n) || OVERSCAN_DEFAULT));
    localStorage.setItem(OVERSCAN_KEY, String(v));
    return { overscan: v };
  }),

  togglePauseScrollRefresh: () => set(s => {
    const n = !s.pauseScrollRefresh;
    localStorage.setItem(PAUSE_SCROLL_KEY, n ? '1' : '0');
    return { pauseScrollRefresh: n };
  }),
}));
