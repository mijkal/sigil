import { create } from 'zustand';

// A sidebar widget. Two families share one config shape:
//   provider usage widgets — coding-agent burndown + quota metadata when exposed,
//       fed by the built-in aggregator; nothing to configure but the host.
//   'command' — a generic monitor: run `command` on `host` every `intervalSec`
//       and display its output. Point it at anything (df -h, docker ps, a usage
//       script of your own).
export type WidgetKind = 'claude-usage' | 'codex-usage' | 'agy-usage' | 'command';

export interface WidgetConfig {
  id: string;
  kind: WidgetKind;
  name: string;
  host: string;
  intervalSec: number;
  command?: string;     // kind === 'command'
  softTarget?: number;  // optional work-token soft budget for the 5h %-bar (usage widgets)
  warningPct?: number;  // early-warning threshold against softTarget (default 80)
  showModels?: boolean; // defaults true
  showSparkline?: boolean; // defaults true
  showCache?: boolean;  // defaults true
  compact?: boolean;    // quota/reset + current-window essentials only
}

const LS_KEY = 'sigil_widgets';
const LS_COLLAPSED = 'sigil_widgets_collapsed';

function load(): WidgetConfig[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function persist(widgets: WidgetConfig[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(widgets)); } catch { /* ignore */ }
}

let seq = 0;
function makeId() { return `w_${Date.now().toString(36)}_${++seq}`; }

interface WidgetStore {
  widgets: WidgetConfig[];
  collapsed: boolean;
  manageRequested: boolean;   // set when the dock asks Settings to open on Widgets
  add: (w: Omit<WidgetConfig, 'id'>) => string;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<WidgetConfig, 'id'>>) => void;
  move: (id: string, dir: -1 | 1) => void;
  toggleCollapsed: () => void;
  requestManage: () => void;
  consumeManage: () => boolean;
}

export const useWidgetStore = create<WidgetStore>((set, get) => ({
  widgets: load(),
  collapsed: (() => { try { return localStorage.getItem(LS_COLLAPSED) === '1'; } catch { return false; } })(),
  manageRequested: false,

  add: (w) => {
    const id = makeId();
    const widgets = [...get().widgets, { ...w, id }];
    persist(widgets);
    set({ widgets });
    return id;
  },

  remove: (id) => {
    const widgets = get().widgets.filter(x => x.id !== id);
    persist(widgets);
    set({ widgets });
  },

  update: (id, patch) => {
    const widgets = get().widgets.map(x => x.id === id ? { ...x, ...patch } : x);
    persist(widgets);
    set({ widgets });
  },

  move: (id, dir) => {
    const widgets = [...get().widgets];
    const i = widgets.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= widgets.length) return;
    [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
    persist(widgets);
    set({ widgets });
  },

  toggleCollapsed: () => set(s => {
    const collapsed = !s.collapsed;
    try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch { /* ignore */ }
    return { collapsed };
  }),

  requestManage: () => set({ manageRequested: true }),
  consumeManage: () => {
    const v = get().manageRequested;
    if (v) set({ manageRequested: false });
    return v;
  },
}));

// Formatting helpers shared by the widget renderers.
export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

// Trim a full model id to something legible in a tight column
// (claude-opus-4-8 → opus-4-8; claude-fable-5 → fable-5).
export function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
