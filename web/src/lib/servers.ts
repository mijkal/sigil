// Saved sigil server instances. The web client can hold several (label + URL +
// token) and switch between them; one is "active" at a time. The active server's
// URL/token are mirrored into the legacy `sigil_server_url` / `sigil_token` keys
// so the rest of the app (and the mixed-content guard in serverUrl.ts) keeps
// working unchanged — switching just repoints those and reloads.

export interface SigilServer {
  id: string;
  label: string;
  url: string;
  token: string;
}

const SERVERS_KEY = 'sigil_servers';
const ACTIVE_KEY = 'sigil_active_server';
const LEGACY_URL = 'sigil_server_url';
const LEGACY_TOKEN = 'sigil_token';

// serverLabelFromUrl derives a friendly default label (the host[:port]).
export function serverLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'server';
  }
}

// dedupeServers collapses entries that point at the same URL (case-insensitive,
// trailing slash ignored), keeping the last (most recently written) token/label.
export function dedupeServers(list: SigilServer[]): SigilServer[] {
  const byUrl = new Map<string, SigilServer>();
  for (const s of list) {
    const key = s.url.trim().replace(/\/$/, '').toLowerCase();
    byUrl.set(key, s);
  }
  return [...byUrl.values()];
}

export function upsertServer(list: SigilServer[], s: SigilServer): SigilServer[] {
  return dedupeServers([...list.filter((x) => x.id !== s.id), s]);
}

export function removeFromList(list: SigilServer[], id: string): SigilServer[] {
  return list.filter((s) => s.id !== id);
}

function newId(): string {
  // Prefer crypto.randomUUID; fall back to a timestamp-free random string so this
  // stays deterministic-free without Date.now (fine for a client id).
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'srv_' + Math.random().toString(36).slice(2, 10);
}

// makeServer builds a new entry, defaulting the label to the URL's host.
export function makeServer(url: string, token: string, label?: string): SigilServer {
  return { id: newId(), url: url.trim().replace(/\/$/, ''), token: token.trim(), label: (label || '').trim() || serverLabelFromUrl(url) };
}

// ── localStorage glue ───────────────────────────────────────────────────────

function readList(): SigilServer[] {
  try {
    const raw = localStorage.getItem(SERVERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && typeof s.url === 'string' && typeof s.token === 'string');
  } catch {
    return [];
  }
}

// loadServers returns the saved servers and the active id, migrating a legacy
// single-server setup (sigil_server_url + sigil_token) into the list on first run.
export function loadServers(): { servers: SigilServer[]; activeId: string | null } {
  let servers = readList();
  let activeId = localStorage.getItem(ACTIVE_KEY);

  if (servers.length === 0) {
    const url = localStorage.getItem(LEGACY_URL);
    const token = localStorage.getItem(LEGACY_TOKEN);
    if (url && token) {
      const s = makeServer(url, token);
      servers = [s];
      activeId = s.id;
      persist(servers, activeId);
    }
  }
  if (activeId && !servers.some((s) => s.id === activeId)) activeId = servers[0]?.id ?? null;
  return { servers, activeId };
}

function persist(servers: SigilServer[], activeId: string | null): void {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  else localStorage.removeItem(ACTIVE_KEY);
  // Mirror the active server into the legacy keys the rest of the app reads.
  const active = servers.find((s) => s.id === activeId);
  if (active) {
    localStorage.setItem(LEGACY_URL, active.url);
    localStorage.setItem(LEGACY_TOKEN, active.token);
  }
}

export function saveServers(servers: SigilServer[], activeId: string | null): void {
  persist(servers, activeId);
}

// clearActive logs out: drops the active pointer and the legacy creds so the
// setup modal reappears. The saved server list is kept for quick re-login.
export function clearActive(): void {
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem(LEGACY_TOKEN);
  localStorage.removeItem(LEGACY_URL);
}
