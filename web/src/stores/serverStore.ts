import { create } from 'zustand';
import {
  loadServers, saveServers, makeServer, upsertServer, removeFromList, clearActive,
  type SigilServer,
} from '../lib/servers';
import { useConnectionStore } from './connectionStore';
import { useSessionStore } from './sessionStore';
import { useLayoutStore } from './layoutStore';
import { useWorkspaceStore, setWorkspaceApiCreds } from './workspaceStore';
import { pickServerUrl } from '../lib/serverUrl';

// Multi-instance connection manager. Holds the saved sigil servers and which one
// is active. Switching / logging out reconnects IN PLACE (no page reload): the
// stale server's state is cleared and the connection re-initialised, which the
// App's client-keyed effect picks up to re-subscribe and re-fetch.

// applyServer tears down the previous server's state and connects the new one.
function applyServer(url: string, token: string): void {
  useLayoutStore.getState().reset();
  useSessionStore.getState().reset();
  // Drop the previous server's workspaces + active id so the layout auto-save
  // can't write the (now empty) layout back to the old workspace before the new
  // server's workspaces load.
  useWorkspaceStore.setState({ workspaces: [], activeId: null });

  const resolved = pickServerUrl(url, window.location.protocol, window.location.host);
  setWorkspaceApiCreds(resolved, token);
  // New client → App's [client]-keyed effect re-subscribes and re-fetches.
  useConnectionStore.getState().init(resolved, token);
}

// teardown disconnects for logout (no active server left).
function teardown(): void {
  useLayoutStore.getState().reset();
  useSessionStore.getState().reset();
  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  useConnectionStore.getState().reset();
}

interface ServerStore {
  servers: SigilServer[];
  activeId: string | null;
  refresh: () => void;
  // Register (or update) a server + make it active, WITHOUT connecting — used by
  // the setup modal, which inits the client itself.
  registerActive: (url: string, token: string, label?: string) => void;
  // Register a new server and connect to it in place.
  addAndConnect: (url: string, token: string, label?: string) => void;
  update: (s: SigilServer) => void;
  switchTo: (id: string) => void;
  remove: (id: string) => void;
  logout: () => void;
}

export const useServerStore = create<ServerStore>((set, get) => ({
  ...loadServers(),

  refresh: () => set(loadServers()),

  registerActive: (url, token, label) => {
    const s = makeServer(url, token, label);
    const servers = upsertServer(get().servers, s);
    saveServers(servers, s.id);
    set({ servers, activeId: s.id });
  },

  addAndConnect: (url, token, label) => {
    const s = makeServer(url, token, label);
    const servers = upsertServer(get().servers, s);
    saveServers(servers, s.id);
    set({ servers, activeId: s.id });
    applyServer(s.url, s.token);
  },

  update: (s) => {
    const servers = upsertServer(get().servers, s);
    saveServers(servers, get().activeId);
    set({ servers });
  },

  switchTo: (id) => {
    const { servers, activeId } = get();
    const target = servers.find((s) => s.id === id);
    if (!target || id === activeId) return;
    saveServers(servers, id);
    set({ activeId: id });
    applyServer(target.url, target.token);
  },

  remove: (id) => {
    const { servers, activeId } = get();
    const next = removeFromList(servers, id);
    if (activeId === id) {
      const fallback = next[0] ?? null;
      saveServers(next, fallback?.id ?? null);
      set({ servers: next, activeId: fallback?.id ?? null });
      if (fallback) applyServer(fallback.url, fallback.token);
      else { clearActive(); teardown(); }
      return;
    }
    saveServers(next, activeId);
    set({ servers: next });
  },

  logout: () => {
    clearActive();
    set({ activeId: null });
    teardown();
  },
}));
