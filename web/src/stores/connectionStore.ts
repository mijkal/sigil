import { create } from 'zustand';
import { SigilClient } from '../client/SigilClient';

interface ConnectionStore {
  client: SigilClient | null;
  connected: boolean;
  serverUrl: string;
  token: string;
  init: (serverUrl: string, token: string) => void;
  setConnected: (v: boolean) => void;
  reset: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  client: null,
  connected: false,
  serverUrl: `${window.location.protocol}//${window.location.host}`,
  token: localStorage.getItem('sigil_token') || '',

  init: (serverUrl: string, token: string) => {
    // Disconnect existing client
    const existing = get().client;
    if (existing) {
      existing.disconnect();
    }

    localStorage.setItem('sigil_token', token);

    const client = new SigilClient(serverUrl, token);

    client.on('connect', () => {
      set({ connected: true });
    });
    client.on('disconnect', () => {
      set({ connected: false });
    });
    client.on('auth.result', (payload) => {
      const p = payload as { success: boolean };
      if (!p.success) {
        console.error('[connectionStore] Auth failed');
      }
    });

    client.connect();
    set({ client, serverUrl, token, connected: false });
  },

  setConnected: (v: boolean) => set({ connected: v }),

  // reset tears the connection down for logout: disconnect the WS, drop the
  // client, and clear the token so App falls back to the setup screen.
  reset: () => {
    const existing = get().client;
    if (existing) existing.disconnect();
    localStorage.removeItem('sigil_token');
    set({ client: null, connected: false, token: '' });
  },
}));
