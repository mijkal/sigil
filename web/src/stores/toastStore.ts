import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  durationMs?: number;
  at: number; // sequence stamp for stable ordering (monotonic, not wall-clock)
  ts: number; // wall-clock ms — for the history panel's relative-time label
  // How many identical events this toast represents. 1 unless coalesced.
  count?: number;
  // Identity used for coalescing. Defaults to type|title|message; a caller can
  // pass something coarser (e.g. per-session) so near-identical churn collapses.
  dedupeKey?: string;
}

// HISTORY_CAP bounds the retained notification list so a chatty session can't
// grow it without limit; the scrollable panel shows the most recent CAP.
const HISTORY_CAP = 200;
const HISTORY_KEY = 'sigil_notif_history';

// History is persisted to localStorage so it survives reloads — the whole point
// is to review connect/disconnect churn and past toasts "over time".
function loadHistory(): Toast[] {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch { return []; }
}
function saveHistory(h: Toast[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_CAP))); } catch { /* quota */ }
}

// Coalescing and caps.
//
// WHY — the 2026-07-29 attach storm: a pane re-attached to a pruned session
// roughly once a second for 45 minutes. Every failure pushed its own toast, so
// the UI became unusable and the notification history (capped at 200) was
// flooded with one repeating event, evicting everything worth reading.
//
// The server-side breaker (internal/session/attachguard.go) stops the storm at
// source, but the UI must not be the thing that falls over when a burst does
// happen. Identical events now collapse into one toast carrying a count, and the
// on-screen stack is bounded.
const MAX_VISIBLE = 4;

// Live dismiss timers, so a coalesced hit can extend the existing toast instead
// of leaving a stale timer to remove it early.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function keyOf(t: { type: ToastType; title: string; message?: string; dedupeKey?: string }): string {
  return t.dedupeKey ?? `${t.type}|${t.title}|${t.message ?? ''}`;
}

interface ToastStore {
  toasts: Toast[];   // currently on-screen (auto-dismissing)
  history: Toast[];  // recent notifications, newest last, capped + persisted
  panelOpen: boolean;
  unseen: number;    // history entries added since the panel was last opened
  push: (t: Omit<Toast, 'id' | 'at' | 'ts'>) => string;
  record: (t: Omit<Toast, 'id' | 'at' | 'ts'>) => void; // log to history WITHOUT an on-screen toast
  dismiss: (id: string) => void;
  openPanel: () => void;
  closePanel: () => void;
  clearHistory: () => void;
}

let seq = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  history: loadHistory(),
  panelOpen: false,
  unseen: 0,

  push: (t) => {
    const key = keyOf(t);
    const duration = t.durationMs ?? 5000;

    // Coalesce onto a matching toast that is still on screen. A burst of the same
    // event becomes "Channel error ×47", not 47 stacked cards.
    const existing = get().toasts.find(x => keyOf(x) === key);
    if (existing) {
      const now = Date.now();
      set(s => {
        const bump = (x: Toast) =>
          x.id === existing.id ? { ...x, count: (x.count ?? 1) + 1, ts: now } : x;
        // Mirror the count into history rather than appending, so one repeating
        // event cannot evict the rest of the log.
        const history = s.history.map(h => (h.id === existing.id ? bump(h) : h));
        saveHistory(history);
        return { toasts: s.toasts.map(bump), history };
      });
      // Restart the dismiss timer so the count stays visible while it is climbing.
      const prev = timers.get(existing.id);
      if (prev) clearTimeout(prev);
      if (duration > 0) {
        timers.set(existing.id, setTimeout(() => {
          timers.delete(existing.id);
          set(s => ({ toasts: s.toasts.filter(x => x.id !== existing.id) }));
        }, duration));
      }
      return existing.id;
    }

    const id = `toast_${++seq}`;
    const toast: Toast = { ...t, id, at: seq, ts: Date.now(), durationMs: duration, count: 1 };
    set(s => {
      const history = [...s.history, toast].slice(-HISTORY_CAP);
      saveHistory(history);
      // Bound the on-screen stack; oldest goes first. History still has them all.
      const toasts = [...s.toasts, toast].slice(-MAX_VISIBLE);
      return { toasts, history, unseen: s.panelOpen ? 0 : s.unseen + 1 };
    });
    if (duration > 0) {
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        set(s => ({ toasts: s.toasts.filter(x => x.id !== id) }));
      }, duration));
    }
    return id;
  },

  // History-only: for routine events (host connect/disconnect churn) that should
  // be reviewable in the log but must NOT pop a toast and spam the user.
  record: (t) => set(s => {
    const entry: Toast = { ...t, id: `evt_${++seq}`, at: seq, ts: Date.now(), durationMs: 0 };
    const history = [...s.history, entry].slice(-HISTORY_CAP);
    saveHistory(history);
    return { history, unseen: s.panelOpen ? 0 : s.unseen + 1 };
  }),

  dismiss: (id) => {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    return set(s => ({ toasts: s.toasts.filter(x => x.id !== id) }));
  },
  openPanel: () => set({ panelOpen: true, unseen: 0 }),
  closePanel: () => set({ panelOpen: false }),
  clearHistory: () => { saveHistory([]); return set({ history: [], panelOpen: false, unseen: 0 }); },
}));
