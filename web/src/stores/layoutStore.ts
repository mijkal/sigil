import { create } from 'zustand';
import type { MosaicNode } from 'react-mosaic-component';

export interface TabConfig {
  sessionId: string;
  hostName: string;
  sessionName: string;
  channelId?: string;
  windowIndex?: number;  // undefined / -1 = current active window; >= 0 = specific window
  windowName?: string;   // display label for the window
}

// The WIDE minimap's display (a thin scroll rail is always shown separately, to
// its right): off (default — rail only); overlay (wide strip floats over the text,
// which wraps full-width under it); docked (wide strip in its own column, text
// wraps before it — no overlap). The wide minimap sits to the LEFT of the rail.
export type MinimapMode = 'off' | 'overlay' | 'docked';

// The floating session-sigil badge in the terminal area — a quick "what am I on"
// anchor. off (hidden); mark (just the generative constellation); labeled (mark +
// session/host name). Corner picks which pane corner it floats in (default top-right,
// clear of the scroll rail).
export type SigilBadgeMode = 'off' | 'mark' | 'labeled';
export type SigilBadgeCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface PaneConfig {
  tabs: TabConfig[];
  activeTab: number;
  showTimestamps?: boolean; // per-pane scrollback timestamp gutter
  showMinimap?: boolean;    // legacy on/off (migrated to minimapMode); kept for back-compat
  minimapMode?: MinimapMode;
  minimapHeight?: number;   // minimap strip height as a fraction of the panel (0.2–1), default 0.5
  softWrap?: boolean;       // per-client soft-wrap of the live tail on shell (non-TUI) sessions
  sigilBadge?: SigilBadgeMode;      // floating session-sigil badge (default 'labeled')
  sigilBadgeCorner?: SigilBadgeCorner; // which corner it floats in (default 'tr')
  sigilBackdrop?: boolean;          // large faint session sigil behind the CLI text (default off)
}

// Effective WIDE-minimap mode for a pane. Default is OFF (rail only); legacy 'thin'
// maps to off since the always-on rail replaces it.
export function paneMinimapMode(pane?: PaneConfig | null): MinimapMode {
  const m = pane?.minimapMode as string | undefined;
  return (m === 'overlay' || m === 'docked') ? m : 'off';
}

// Effective sigil-badge mode / corner for a pane (with defaults).
export function paneSigilBadge(pane?: PaneConfig | null): SigilBadgeMode {
  const m = pane?.sigilBadge;
  return (m === 'off' || m === 'mark' || m === 'labeled') ? m : 'mark';
}
export function paneSigilCorner(pane?: PaneConfig | null): SigilBadgeCorner {
  const c = pane?.sigilBadgeCorner;
  return (c === 'tl' || c === 'tr' || c === 'bl' || c === 'br') ? c : 'tr';
}
export function paneSigilBackdrop(pane?: PaneConfig | null): boolean {
  return pane?.sigilBackdrop !== false; // default ON; only an explicit false disables it
}

interface LayoutStore {
  panes: Map<string, PaneConfig>;
  mosaicLayout: MosaicNode<string> | null;
  focusedPane: string | null;

  // Tab operations
  addTab: (sessionId: string, hostName: string, sessionName: string, targetPane?: string | null, windowIndex?: number, windowName?: string) => void;
  closeTab: (paneId: string, tabIdx: number) => void;
  activateTab: (paneId: string, tabIdx: number) => void;
  cycleTab: (paneId: string, delta: 1 | -1) => void;
  reorderTab: (paneId: string, from: number, to: number) => void;
  toggleTimestamps: (paneId: string) => void;
  toggleMinimap: (paneId: string) => void;       // binary off<->overlay (mobile)
  cycleMinimap: (paneId: string) => void;         // off->overlay->docked->thin->off (desktop)
  setMinimapHeight: (paneId: string, frac: number) => void;
  toggleSoftWrap: (paneId: string) => void;
  cycleSigilBadge: (paneId: string) => void;    // labeled -> mark -> off
  cycleSigilCorner: (paneId: string) => void;   // tr -> br -> bl -> tl
  toggleSigilBackdrop: (paneId: string) => void; // large faint sigil behind the CLI
  setTabChannelId: (paneId: string, tabIdx: number, channelId: string | undefined) => void;

  // Pane operations
  createEmptyPane: () => string;
  splitPane: (paneId: string, direction: 'row' | 'column') => void;
  closePane: (paneId: string) => void;
  setMosaicLayout: (layout: MosaicNode<string> | null) => void;
  setFocusedPane: (paneId: string | null) => void;
  reset: () => void;
}

let paneSeq = 0;
// Allow workspaceStore to bump the counter after a restore so new panes don't collide
export function bumpPaneSeq(n: number) { if (n > paneSeq) paneSeq = n; }
function makePaneId() { return `pane_${++paneSeq}`; }

function insertIntoLayout(
  existing: MosaicNode<string> | null,
  newKey: string
): MosaicNode<string> {
  if (existing === null) return newKey;
  return { direction: 'row', first: existing, second: newKey, splitPercentage: 50 };
}

function splitInLayout(
  node: MosaicNode<string> | null,
  targetKey: string,
  newKey: string,
  direction: 'row' | 'column'
): MosaicNode<string> | null {
  if (node === null) return null;
  if (typeof node === 'string') {
    if (node === targetKey) {
      return { direction, first: targetKey, second: newKey, splitPercentage: 50 };
    }
    return node;
  }
  const newFirst = splitInLayout(node.first, targetKey, newKey, direction);
  const newSecond = splitInLayout(node.second, targetKey, newKey, direction);
  return { ...node, first: newFirst ?? node.first, second: newSecond ?? node.second };
}

function removeFromLayout(
  node: MosaicNode<string> | null,
  key: string
): MosaicNode<string> | null {
  if (node === null) return null;
  if (typeof node === 'string') return node === key ? null : node;
  const newFirst = removeFromLayout(node.first, key);
  const newSecond = removeFromLayout(node.second, key);
  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;
  return { ...node, first: newFirst, second: newSecond };
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  panes: new Map(),
  mosaicLayout: null,
  focusedPane: null,

  addTab: (sessionId, hostName, sessionName, targetPane = null, windowIndex?: number, windowName?: string) => {
    set(state => {
      const tab: TabConfig = { sessionId, hostName, sessionName, windowIndex, windowName };
      const newPanes = new Map(state.panes);
      const dest = targetPane ?? state.focusedPane;

      if (dest && newPanes.has(dest)) {
        const pane = newPanes.get(dest)!;
        newPanes.set(dest, { tabs: [...pane.tabs, tab], activeTab: pane.tabs.length });
        return { panes: newPanes, focusedPane: dest };
      }

      // No focused pane — create new one
      const paneId = makePaneId();
      newPanes.set(paneId, { tabs: [tab], activeTab: 0 });
      const newLayout = insertIntoLayout(state.mosaicLayout, paneId);
      return { panes: newPanes, mosaicLayout: newLayout, focusedPane: paneId };
    });
  },

  closeTab: (paneId, tabIdx) => {
    set(state => {
      const newPanes = new Map(state.panes);
      const pane = newPanes.get(paneId);
      if (!pane) return {};

      const newTabs = pane.tabs.filter((_, i) => i !== tabIdx);
      // Keep the pane alive even when its last tab closes — it becomes an empty
      // pane (empty state + a Close Pane control). Previously the split collapsed
      // the instant its last tab closed, which was surprising when arranging a
      // multi-pane layout; the user removes an empty pane explicitly instead.
      const newActive = Math.min(pane.activeTab, Math.max(0, newTabs.length - 1));
      newPanes.set(paneId, { ...pane, tabs: newTabs, activeTab: newActive });
      return { panes: newPanes, focusedPane: paneId };
    });
  },

  activateTab: (paneId, tabIdx) => {
    set(state => {
      const newPanes = new Map(state.panes);
      const pane = newPanes.get(paneId);
      if (!pane || tabIdx < 0 || tabIdx >= pane.tabs.length) return {};
      newPanes.set(paneId, { ...pane, activeTab: tabIdx });
      return { panes: newPanes, focusedPane: paneId };
    });
  },

  cycleTab: (paneId, delta) => {
    const pane = get().panes.get(paneId);
    if (!pane || pane.tabs.length <= 1) return;
    const next = (pane.activeTab + delta + pane.tabs.length) % pane.tabs.length;
    get().activateTab(paneId, next);
  },

  reorderTab: (paneId, from, to) => {
    set(state => {
      const pane = state.panes.get(paneId);
      if (!pane) return {};
      const n = pane.tabs.length;
      if (from === to || from < 0 || from >= n || to < 0 || to >= n) return {};
      const tabs = [...pane.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      // Keep the same tab active by following it to its new index.
      let activeTab = pane.activeTab;
      if (activeTab === from) activeTab = to;
      else if (from < activeTab && to >= activeTab) activeTab -= 1;
      else if (from > activeTab && to <= activeTab) activeTab += 1;
      const newPanes = new Map(state.panes);
      newPanes.set(paneId, { ...pane, tabs, activeTab });
      return { panes: newPanes };
    });
  },

  setTabChannelId: (paneId, tabIdx, channelId) => {
    set(state => {
      const newPanes = new Map(state.panes);
      const pane = newPanes.get(paneId);
      if (!pane) return {};
      const newTabs = [...pane.tabs];
      if (!newTabs[tabIdx]) return {};
      newTabs[tabIdx] = { ...newTabs[tabIdx], channelId };
      newPanes.set(paneId, { ...pane, tabs: newTabs });
      return { panes: newPanes };
    });
  },

  createEmptyPane: () => {
    const id = makePaneId();
    set(state => {
      const newPanes = new Map(state.panes);
      newPanes.set(id, { tabs: [], activeTab: 0 });
      return { panes: newPanes, focusedPane: id };
    });
    return id;
  },

  splitPane: (paneId, direction) => {
    set(state => {
      const id2 = makePaneId();
      const newPanes = new Map(state.panes);
      newPanes.set(id2, { tabs: [], activeTab: 0 });
      const newLayout = splitInLayout(state.mosaicLayout, paneId, id2, direction);
      return { panes: newPanes, mosaicLayout: newLayout ?? state.mosaicLayout, focusedPane: id2 };
    });
  },

  closePane: (paneId) => {
    set(state => {
      const newPanes = new Map(state.panes);
      newPanes.delete(paneId);
      const newLayout = removeFromLayout(state.mosaicLayout, paneId);
      const newFocused = state.focusedPane === paneId ? null : state.focusedPane;
      return { panes: newPanes, mosaicLayout: newLayout, focusedPane: newFocused };
    });
  },

  setMosaicLayout: (layout) => set({ mosaicLayout: layout }),
  setFocusedPane: (paneId) => set({ focusedPane: paneId }),
  reset: () => set({ panes: new Map(), mosaicLayout: null, focusedPane: null }),

  toggleTimestamps: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, showTimestamps: !pane.showTimestamps });
    return { panes: newPanes };
  }),

  toggleMinimap: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const newPanes = new Map(state.panes);
    // Binary off<->overlay (mobile view options).
    const cur = paneMinimapMode(pane);
    newPanes.set(paneId, { ...pane, minimapMode: cur === 'off' ? 'overlay' : 'off' });
    return { panes: newPanes };
  }),

  cycleMinimap: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const order: MinimapMode[] = ['off', 'overlay', 'docked'];
    const next = order[(order.indexOf(paneMinimapMode(pane)) + 1) % order.length];
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, minimapMode: next });
    return { panes: newPanes };
  }),

  setMinimapHeight: (paneId, frac) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const clamped = Math.max(0.2, Math.min(1, frac));
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, minimapHeight: clamped });
    return { panes: newPanes };
  }),

  toggleSoftWrap: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, softWrap: !pane.softWrap });
    return { panes: newPanes };
  }),

  cycleSigilBadge: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const order: SigilBadgeMode[] = ['mark', 'labeled', 'off'];
    const next = order[(order.indexOf(paneSigilBadge(pane)) + 1) % order.length];
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, sigilBadge: next });
    return { panes: newPanes };
  }),

  cycleSigilCorner: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const order: SigilBadgeCorner[] = ['tr', 'br', 'bl', 'tl'];
    const next = order[(order.indexOf(paneSigilCorner(pane)) + 1) % order.length];
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, sigilBadgeCorner: next });
    return { panes: newPanes };
  }),

  toggleSigilBackdrop: (paneId) => set(state => {
    const pane = state.panes.get(paneId);
    if (!pane) return {};
    const newPanes = new Map(state.panes);
    newPanes.set(paneId, { ...pane, sigilBackdrop: !paneSigilBackdrop(pane) });
    return { panes: newPanes };
  }),
}));
