import { create } from 'zustand';

// mediaTrayStore — a persistent "cart" of files/dirs the user has selected while
// browsing the PreviewPanel. It survives directory navigation so you can gather
// items from several places, then act on all of them at once — the main action
// today being "insert these @paths into the focused input" to hand files to
// Claude Code. Transfer actions (download/move/upload) arrive with the Phase 6
// backend.
export interface TrayItem {
  hostName: string;
  path: string;
  isDir: boolean;
}

interface MediaTrayStore {
  items: TrayItem[];
  toggle: (item: TrayItem) => void;
  add: (item: TrayItem) => void;
  remove: (hostName: string, path: string) => void;
  clear: () => void;
}

const same = (a: TrayItem, h: string, p: string) => a.hostName === h && a.path === p;

export const useMediaTrayStore = create<MediaTrayStore>((set) => ({
  items: [],
  toggle: (item) => set(s => {
    const exists = s.items.some(i => same(i, item.hostName, item.path));
    return {
      items: exists
        ? s.items.filter(i => !same(i, item.hostName, item.path))
        : [...s.items, item],
    };
  }),
  add: (item) => set(s =>
    s.items.some(i => same(i, item.hostName, item.path)) ? {} : { items: [...s.items, item] }
  ),
  remove: (hostName, path) => set(s => ({ items: s.items.filter(i => !same(i, hostName, path)) })),
  clear: () => set({ items: [] }),
}));
