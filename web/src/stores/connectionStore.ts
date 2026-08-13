import { create } from 'zustand';
import { SigilClient } from '../client/SigilClient';

// `connected` means AUTHENTICATED, not "socket is open".
//
// It used to flip true on the WebSocket `connect` event, which fires the instant
// the socket opens — before the server has judged the token. A rejected token
// therefore painted the same green "Connected" dot as a working one, while every
// REST call 401'd and the sidebar sat empty: the UI said healthy and the user had
// no way to learn otherwise. Auth failure is now a first-class, visible state.
interface ConnectionStore {
  client: SigilClient | null;
  /** True only once the server has accepted the token. */
  connected: boolean;
  /** True when the socket is open but auth has not resolved yet. */
  connecting: boolean;
  /** Server-supplied reason the token was refused; null when not refused. */
  authError: string | null;
  serverUrl: string;
  token: string;
  init: (serverUrl: string, token: string) => void;
  setConnected: (v: boolean) => void;
  reset: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  client: null,
  connected: false,
  connecting: false,
  authError: null,
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

    // Socket open ≠ authenticated: hold `connecting` until auth.result lands.
    client.on('connect', () => {
      set({ connecting: true });
    });
    client.on('disconnect', () => {
      set({ connected: false, connecting: false });
    });
    client.on('auth.result', (payload) => {
      const p = payload as { success: boolean; error?: string };
      if (p.success) {
        set({ connected: true, connecting: false, authError: null });
      } else {
        console.error('[connectionStore] Auth failed:', p.error);
        set({ connected: false, connecting: false, authError: p.error || 'invalid token' });
      }
    });

    client.connect();
    set({ client, serverUrl, token, connected: false, connecting: true, authError: null });
  },

  setConnected: (v: boolean) => set({ connected: v }),

  // reset tears the connection down for logout: disconnect the WS, drop the
  // client, and clear the token so App falls back to the setup screen.
  reset: () => {
    const existing = get().client;
    if (existing) existing.disconnect();
    localStorage.removeItem('sigil_token');
    set({ client: null, connected: false, connecting: false, authError: null, token: '' });
  },
}));
