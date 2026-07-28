import { create } from 'zustand';

// Machine-created sessions that clutter the sidebar.
//
// Drydock spawns a tmux session per shell command (`hostsh-<id>`) and per task
// worker (`mctask-<id>`). They are single-shot: created, read, deleted. At any
// moment a handful are legitimately live, but they carry no meaning for a human
// browsing hosts — and they can swamp the real work (2026-07-27: 51 of jupiter's
// 58 sessions were these).
//
// Hiding is purely a VIEW concern: patterns live per-browser in localStorage,
// nothing is killed, and the sidebar always offers a one-click reveal. Session
// LIFECYCLE is a separate, server-side policy (sigild's ephemeral_patterns,
// which governs auto-resurrect) — deliberately not coupled to this, so changing
// what you look at can never change what runs.
const LS_PATTERNS = 'sigil_hidden_session_patterns';
const LS_REVEAL = 'sigil_hidden_sessions_revealed';

export const DEFAULT_HIDDEN_PATTERNS = ['hostsh-*', 'mctask-*'];

function loadPatterns(): string[] {
  try {
    const raw = localStorage.getItem(LS_PATTERNS);
    if (raw === null) return DEFAULT_HIDDEN_PATTERNS;  // first run — seed defaults
    const parsed = JSON.parse(raw);
    // An explicitly saved [] means "hide nothing"; honour it rather than
    // re-seeding the defaults the user just cleared.
    return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : DEFAULT_HIDDEN_PATTERNS;
  } catch { return DEFAULT_HIDDEN_PATTERNS; }
}
function persistPatterns(patterns: string[]) {
  try { localStorage.setItem(LS_PATTERNS, JSON.stringify(patterns)); } catch { /* ignore */ }
}

/**
 * Compile a glob ("hostsh-*") to an anchored RegExp. Only `*` and `?` are
 * special; every other character is escaped, so a pattern can never be a
 * partial/substring match — "hostsh-*" must not swallow "my-hostsh-notes".
 * Returns null for an unusable pattern so a typo hides nothing rather than
 * everything.
 */
export function globToRegExp(pattern: string): RegExp | null {
  if (!pattern) return null;
  try {
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${body}$`);
  } catch { return null; }
}

/** True when `name` matches any pattern. An empty list hides nothing. */
export function matchesHidden(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const re = globToRegExp(p);
    if (re && re.test(name)) return true;
  }
  return false;
}

interface HiddenSessionStore {
  patterns: string[];
  /** Temporary "show them anyway" reveal. Persisted so a reload doesn't
   *  silently re-hide sessions the user is actively looking at. */
  revealed: boolean;
  addPattern: (p: string) => void;
  removePattern: (p: string) => void;
  resetPatterns: () => void;
  setRevealed: (v: boolean) => void;
  toggleRevealed: () => void;
}

export const useHiddenSessionStore = create<HiddenSessionStore>((set, get) => ({
  patterns: loadPatterns(),
  revealed: (() => { try { return localStorage.getItem(LS_REVEAL) === '1'; } catch { return false; } })(),

  addPattern: (p) => {
    const trimmed = p.trim();
    if (!trimmed || get().patterns.includes(trimmed)) return;
    const patterns = [...get().patterns, trimmed];
    persistPatterns(patterns);
    set({ patterns });
  },
  removePattern: (p) => {
    const patterns = get().patterns.filter(x => x !== p);
    persistPatterns(patterns);
    set({ patterns });
  },
  resetPatterns: () => {
    persistPatterns(DEFAULT_HIDDEN_PATTERNS);
    set({ patterns: [...DEFAULT_HIDDEN_PATTERNS] });
  },
  setRevealed: (v) => {
    try { localStorage.setItem(LS_REVEAL, v ? '1' : '0'); } catch { /* ignore */ }
    set({ revealed: v });
  },
  toggleRevealed: () => get().setRevealed(!get().revealed),
}));
