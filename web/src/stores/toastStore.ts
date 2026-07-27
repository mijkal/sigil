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

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  history: loadHistory(),
  panelOpen: false,
  unseen: 0,

  push: (t) => {
    const id = `toast_${++seq}`;
    const toast: Toast = { ...t, id, at: seq, ts: Date.now(), durationMs: t.durationMs ?? 5000 };
    set(s => {
      const history = [...s.history, toast].slice(-HISTORY_CAP);
      saveHistory(history);
      return { toasts: [...s.toasts, toast], history, unseen: s.panelOpen ? 0 : s.unseen + 1 };
    });
    if ((toast.durationMs ?? 0) > 0) {
      setTimeout(() => {
        set(s => ({ toasts: s.toasts.filter(x => x.id !== id) }));
      }, toast.durationMs);
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

  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
  openPanel: () => set({ panelOpen: true, unseen: 0 }),
  closePanel: () => set({ panelOpen: false }),
  clearHistory: () => { saveHistory([]); return set({ history: [], panelOpen: false, unseen: 0 }); },
}));
