import { create } from 'zustand';
import { useLayoutStore, bumpPaneSeq } from './layoutStore';
import type { MosaicNode } from 'react-mosaic-component';
import type { PaneConfig, MinimapMode, SigilBadgeMode, SigilBadgeCorner } from './layoutStore';

// Per-pane view prefs that ride along with the layout so they survive reloads and
// follow the device's auto-workspace. Tabs + activeTab are the structural core;
// the rest are display toggles (minimap, timestamps, soft-wrap, sigil badge).
interface WorkspacePane {
  tabs: Array<{ sessionId: string; hostName: string; sessionName: string }>;
  activeTab: number;
  minimapMode?: MinimapMode;
  minimapHeight?: number;
  showTimestamps?: boolean;
  softWrap?: boolean;
  sigilBadge?: SigilBadgeMode;
  sigilBadgeCorner?: SigilBadgeCorner;
  sigilBackdrop?: boolean;
}

export interface WorkspaceConfig {
  panes: Record<string, WorkspacePane>;
  layout: MosaicNode<string> | null;
}

export interface Workspace {
  id: string;
  name: string;
  config: string; // JSON WorkspaceConfig
  created_at: string;
  updated_at: string;
}

const ACTIVE_WS_KEY = 'sigil_active_workspace';
const DEVICE_ID_KEY = 'sigil_device_id';

// getOrCreateDeviceId returns a stable per-browser-profile UUID. It's how we
// key the "auto" workspace so each device/profile gets its own layout history
// without competing with named workspaces that are explicitly shared across
// devices. Lives in localStorage, so wiping browser data resets it.
export function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// autoWorkspaceId returns the deterministic workspace ID owned by this device.
// Prefix makes it easy to recognize / filter in the UI without an extra DB
// column. Named workspaces (created via the WorkspaceSelector) never collide
// with this prefix in practice.
export function autoWorkspaceId(deviceId?: string): string {
  return `auto-${deviceId ?? getOrCreateDeviceId()}`;
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeId: string | null;
  saving: boolean;

  setWorkspaces: (ws: Workspace[]) => void;
  setActiveId: (id: string | null) => void;

  // Serialize current layout into a WorkspaceConfig blob
  serializeCurrent: () => WorkspaceConfig;

  // Apply a workspace config to the layout store
  applyCurrent: (config: WorkspaceConfig) => void;

  // High-level: save current layout as named workspace (creates if new)
  saveWorkspace: (id: string, name: string) => Promise<void>;
  loadWorkspace: (id: string) => void;
}

// Expose baseUrl/token for fetch calls — set from connectionStore on init
let _baseUrl = '';
let _token = '';
export function setWorkspaceApiCreds(baseUrl: string, token: string) {
  _baseUrl = baseUrl;
  _token = token;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeId: localStorage.getItem(ACTIVE_WS_KEY),
  saving: false,

  setWorkspaces: (ws) => set({ workspaces: ws }),
  setActiveId: (id) => {
    set({ activeId: id });
    if (id) localStorage.setItem(ACTIVE_WS_KEY, id);
    else localStorage.removeItem(ACTIVE_WS_KEY);
  },

  serializeCurrent: () => {
    const { panes, mosaicLayout } = useLayoutStore.getState();
    const panesObj: WorkspaceConfig['panes'] = {};
    for (const [id, pane] of panes.entries()) {
      panesObj[id] = {
        tabs: pane.tabs.map(t => ({
          sessionId: t.sessionId,
          hostName:  t.hostName,
          sessionName: t.sessionName,
        })),
        activeTab: pane.activeTab,
        minimapMode: pane.minimapMode,
        minimapHeight: pane.minimapHeight,
        showTimestamps: pane.showTimestamps,
        softWrap: pane.softWrap,
        sigilBadge: pane.sigilBadge,
        sigilBadgeCorner: pane.sigilBadgeCorner,
        sigilBackdrop: pane.sigilBackdrop,
      };
    }
    return { panes: panesObj, layout: mosaicLayout };
  },

  applyCurrent: (config) => {
    if (!config || !config.panes) return;
    // Bump pane counter to avoid ID collisions with restored pane IDs
    const ids = Object.keys(config.panes);
    const maxSeq = ids.reduce((m, k) => {
      const match = k.match(/^pane_(\d+)$/);
      return match ? Math.max(m, parseInt(match[1])) : m;
    }, 0);
    bumpPaneSeq(maxSeq);

    const newPanes = new Map<string, PaneConfig>(
      ids.map(id => [id, config.panes[id] as PaneConfig])
    );
    useLayoutStore.setState({
      panes: newPanes,
      mosaicLayout: config.layout,
      focusedPane: null,
    });
  },

  saveWorkspace: async (id, name) => {
    if (!_baseUrl || !_token) return;
    set({ saving: true });
    try {
      const config = get().serializeCurrent();
      const body: Workspace = {
        id,
        name,
        config: JSON.stringify(config),
        created_at: '',
        updated_at: '',
      };
      const res = await fetch(`${_baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: Workspace };
      const saved = json.data;
      set(s => ({
        workspaces: s.workspaces.some(w => w.id === saved.id)
          ? s.workspaces.map(w => w.id === saved.id ? saved : w)
          : [...s.workspaces, saved],
        activeId: saved.id,
      }));
      localStorage.setItem(ACTIVE_WS_KEY, saved.id);
    } finally {
      set({ saving: false });
    }
  },

  loadWorkspace: (id) => {
    const ws = get().workspaces.find(w => w.id === id);
    if (!ws) return;
    try {
      const config: WorkspaceConfig = JSON.parse(ws.config);
      get().applyCurrent(config);
      set({ activeId: id });
      localStorage.setItem(ACTIVE_WS_KEY, id);
    } catch {
      console.error('[WorkspaceStore] failed to parse workspace config');
    }
  },
}));
