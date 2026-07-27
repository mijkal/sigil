import { create } from 'zustand';
import { useConnectionStore } from './connectionStore';
import { rekeyScope } from '../lib/markScopes';

// Per-host / per-session identity customization — accent colour, plus (added) a
// custom uploaded image OR a picked line-icon, with optional adjustments. All of it
// lives server-side (sigild `prefs` + `assets`) so every client/device shares it;
// localStorage is an offline cache for instant load. Resolution: session override →
// host default → generative sigil.

export const PALETTE: { name: string; value: string }[] = [
  { name: 'Blue',   value: '#3b82f6' },
  { name: 'Cyan',   value: '#06b6d4' },
  { name: 'Teal',   value: '#14b8a6' },
  { name: 'Green',  value: '#22c55e' },
  { name: 'Amber',  value: '#eab308' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Red',    value: '#ef4444' },
  { name: 'Pink',   value: '#ec4899' },
  { name: 'Purple', value: '#a855f7' },
];

const HOSTS_KEY = 'sigil_host_colors';
const SESSIONS_KEY = 'sigil_session_colors';
const CUSTOM_KEY = 'sigil_customize'; // images/icons/adjust cache

function load(key: string): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(key) ?? '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ }
}

const sessionKey = (host: string, session: string) => `${host}::${session}`;
// Shared scope key (matches the server pref/asset keys): h:<host> / s:<host>::<session>.
export const scopeKeyFor = (host: string, session?: string) =>
  session ? `s:${host}::${session}` : `h:${host}`;

export interface ImageAdjust { sat: number; opacity: number; mono: boolean }
export const DEFAULT_ADJUST: ImageAdjust = { sat: 1, opacity: 1, mono: false };

export interface ColorPickerTarget {
  x: number; y: number;
  kind: 'host' | 'session';
  host: string;
  session?: string;
  current: string | null;
}

interface SessionColorStore {
  hosts: Record<string, string>;
  sessions: Record<string, string>;
  images: Record<string, 1>;             // scopeKey → has custom image
  icons: Record<string, string>;         // scopeKey → line-icon id
  adjust: Record<string, ImageAdjust>;   // scopeKey → image adjustments
  picker: ColorPickerTarget | null;
  setHostColor: (host: string, color: string | null) => void;
  setSessionColor: (host: string, session: string, color: string | null) => void;
  markImage: (scope: string) => void;
  unmarkImage: (scope: string) => void;
  setIcon: (scope: string, iconId: string | null) => void;
  setAdjust: (scope: string, adj: ImageAdjust) => void;
  migrateMarks: (from: string, to: string, withImage?: boolean) => void;
  hydrate: (
    hosts: Record<string, string>, sessions: Record<string, string>,
    all: Record<string, string>, images: string[],
  ) => void;
  openPicker: (p: ColorPickerTarget) => void;
  closePicker: () => void;
}

function pushColor(kind: 'host' | 'session', host: string, session: string | null, color: string | null) {
  useConnectionStore.getState().client?.setColorPref(kind, host, session, color).catch(() => {});
}
function pushPref(key: string, value: string) {
  useConnectionStore.getState().client?.setPref(key, value).catch(() => {});
}

const cachedCustom = (() => {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '{}'); } catch { return {}; }
})();

export const useSessionColorStore = create<SessionColorStore>((set) => ({
  hosts: load(HOSTS_KEY),
  sessions: load(SESSIONS_KEY),
  images: cachedCustom.images ?? {},
  icons: cachedCustom.icons ?? {},
  adjust: cachedCustom.adjust ?? {},
  picker: null,
  openPicker: (p) => set({ picker: p }),
  closePicker: () => set({ picker: null }),

  hydrate: (hosts, sessions, all, images) => {
    const icons: Record<string, string> = {};
    const adjust: Record<string, ImageAdjust> = {};
    for (const [k, v] of Object.entries(all || {})) {
      if (!v) continue;
      if (k.startsWith('icon:')) icons[k.slice(5)] = v;
      else if (k.startsWith('adj:')) { try { adjust[k.slice(4)] = JSON.parse(v); } catch { /* skip */ } }
    }
    const img: Record<string, 1> = {};
    for (const s of images || []) img[s] = 1;
    save(HOSTS_KEY, hosts); save(SESSIONS_KEY, sessions);
    save(CUSTOM_KEY, { images: img, icons, adjust });
    set({ hosts, sessions, images: img, icons, adjust });
  },

  setHostColor: (host, color) => {
    set(s => { const hosts = { ...s.hosts }; if (color) hosts[host] = color; else delete hosts[host]; save(HOSTS_KEY, hosts); return { hosts }; });
    pushColor('host', host, null, color);
  },
  setSessionColor: (host, session, color) => {
    set(s => { const sessions = { ...s.sessions }; const k = sessionKey(host, session); if (color) sessions[k] = color; else delete sessions[k]; save(SESSIONS_KEY, sessions); return { sessions }; });
    pushColor('session', host, session, color);
  },

  markImage: (scope) => set(s => { const images = { ...s.images, [scope]: 1 as const }; save(CUSTOM_KEY, { images, icons: s.icons, adjust: s.adjust }); return { images }; }),
  unmarkImage: (scope) => set(s => { const images = { ...s.images }; delete images[scope]; save(CUSTOM_KEY, { images, icons: s.icons, adjust: s.adjust }); return { images }; }),
  setIcon: (scope, iconId) => {
    set(s => { const icons = { ...s.icons }; if (iconId) icons[scope] = iconId; else delete icons[scope]; save(CUSTOM_KEY, { images: s.images, icons, adjust: s.adjust }); return { icons }; });
    pushPref(`icon:${scope}`, iconId || '');
  },
  setAdjust: (scope, adj) => {
    set(s => { const adjust = { ...s.adjust, [scope]: adj }; save(CUSTOM_KEY, { images: s.images, icons: s.icons, adjust }); return { adjust }; });
    pushPref(`adj:${scope}`, JSON.stringify(adj));
  },

  // Carry a scope's marks onto a new scope key — a session rename changes the key,
  // so without this the mark is orphaned and the row falls back to its sigil. The
  // icon/adjust prefs are re-pushed under the new key and cleared under the old.
  // `withImage` is the caller's report on the server-side image copy: false leaves
  // the image flag on the old scope (the copy failed → don't promise an image that
  // isn't there).
  migrateMarks: (from, to, withImage = true) => {
    if (from === to) return;
    let icon: string | undefined, adj: ImageAdjust | undefined;
    set(s => {
      const images = withImage ? rekeyScope(s.images, from, to) : s.images;
      const icons = rekeyScope(s.icons, from, to);
      const adjust = rekeyScope(s.adjust, from, to);
      if (images === s.images && icons === s.icons && adjust === s.adjust) return {};
      icon = icons[to]; adj = adjust[to];
      save(CUSTOM_KEY, { images, icons, adjust });
      return { images, icons, adjust };
    });
    if (icon !== undefined) { pushPref(`icon:${to}`, icon); pushPref(`icon:${from}`, ''); }
    if (adj !== undefined) { pushPref(`adj:${to}`, JSON.stringify(adj)); pushPref(`adj:${from}`, ''); }
  },
}));

export function resolveSessionColor(
  maps: Pick<SessionColorStore, 'hosts' | 'sessions'>,
  host: string,
  session?: string,
): string | null {
  if (session) {
    const s = maps.sessions[sessionKey(host, session)];
    if (s) return s;
  }
  return maps.hosts[host] ?? null;
}

// Resolve the effective identity mark: a session's custom image/icon wins over the
// host's, which wins over the generative sigil.
export interface ResolvedIdentity { kind: 'image' | 'icon' | 'sigil'; scope: string; iconId?: string; adjust: ImageAdjust }
export function resolveIdentity(
  store: Pick<SessionColorStore, 'images' | 'icons' | 'adjust'>,
  host: string, session?: string,
): ResolvedIdentity {
  const scopes = session ? [scopeKeyFor(host, session), scopeKeyFor(host)] : [scopeKeyFor(host)];
  for (const scope of scopes) {
    if (store.images[scope]) return { kind: 'image', scope, adjust: store.adjust[scope] ?? DEFAULT_ADJUST };
    if (store.icons[scope]) return { kind: 'icon', scope, iconId: store.icons[scope], adjust: store.adjust[scope] ?? DEFAULT_ADJUST };
  }
  return { kind: 'sigil', scope: scopes[0], adjust: DEFAULT_ADJUST };
}
