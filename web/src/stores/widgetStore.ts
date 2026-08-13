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

// One-time repair for usage widgets stranded by the hub moving hosts.
//
// A usage widget stores the host whose transcripts it reads. Widgets created
// while sigild ran on the same box as the coding agents were pinned to that box
// by name — and when the hub moves to a machine that runs no agent sessions, the
// pin survives in localStorage and every widget quietly reports 0 files / 0
// tokens. There is no error to see: the scan succeeds, the directory is simply
// empty.
//
// So re-point, but only in exactly that broken shape: the widget is a usage
// widget, its current host is NOT tagged `agent`, and some connected host IS.
// A widget already aimed at an agent host is never touched, and neither is a
// setup whose hub genuinely is the agent host (there, no other candidate wins).
// Fully reversible — the host dropdown in Settings → Widgets still governs.
export function repointStaleUsageHosts(
  widgets: WidgetConfig[],
  hosts: Array<{ name: string; status?: string; tags?: string[] }>,
): { widgets: WidgetConfig[]; changed: Array<{ name: string; from: string; to: string }> } {
  const agents = hosts.filter(h => h.status === 'connected' && h.tags?.includes('agent'));
  const target =
    agents.find(h => h.tags?.includes('local') || h.tags?.includes('lan'))?.name
    || agents[0]?.name;
  const changed: Array<{ name: string; from: string; to: string }> = [];
  if (!target) return { widgets, changed };

  const isAgent = (name: string) => agents.some(h => h.name === name);
  const next = widgets.map(w => {
    if (w.kind === 'command' || !w.host || isAgent(w.host)) return w;
    // Only re-point a host we can actually see and judge; an unknown name may be
    // a host this client simply has not loaded.
    if (!hosts.some(h => h.name === w.host)) return w;
    changed.push({ name: w.name, from: w.host, to: target });
    return { ...w, host: target };
  });
  return { widgets: changed.length ? next : widgets, changed };
}

interface WidgetStore {
  widgets: WidgetConfig[];
  collapsed: boolean;
  manageRequested: boolean;   // set when the dock asks Settings to open on Widgets
  repointStale: (hosts: Array<{ name: string; status?: string; tags?: string[] }>) => Array<{ name: string; from: string; to: string }>;
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

  repointStale: (hosts) => {
    const { widgets, changed } = repointStaleUsageHosts(get().widgets, hosts);
    if (changed.length) {
      persist(widgets);
      set({ widgets });
    }
    return changed;
  },

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
  // Drop the vendor prefix and any trailing build date. Only `claude-` was
  // stripped before, so codex/gemini rows ("gpt-5-codex", "gemini-3-pro") kept
  // their full names and were the first to clip in a narrow sidebar.
  return m
    .replace(/^(claude|anthropic|openai|google)[-/]/, '')
    .replace(/^gpt-/, '')
    .replace(/^gemini-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
}
