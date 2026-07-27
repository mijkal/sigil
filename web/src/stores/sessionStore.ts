import { create } from 'zustand';
import type { Host, Session, HostMetrics } from '../types';

interface SessionStore {
  hosts: Host[];
  sessions: Session[];
  metricsByHost: Record<string, HostMetrics>;
  setHosts: (hosts: Host[]) => void;
  setSessions: (sessions: Session[]) => void;
  updateHost: (name: string, status: string) => void;
  setHostMetrics: (m: HostMetrics) => void;
  setAllMetrics: (list: HostMetrics[]) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  hosts: [],
  sessions: [],
  metricsByHost: {},

  setHosts: (hosts: Host[]) => set({ hosts }),

  setSessions: (sessions: Session[]) => set({ sessions }),

  updateHost: (name: string, status: string) =>
    set((state) => ({
      hosts: state.hosts.map((h) =>
        h.name === name ? { ...h, status: status as Host['status'] } : h
      ),
    })),

  setHostMetrics: (m: HostMetrics) =>
    set((state) => ({ metricsByHost: { ...state.metricsByHost, [m.host]: m } })),

  setAllMetrics: (list: HostMetrics[]) =>
    set(() => ({
      metricsByHost: Object.fromEntries(list.map((m) => [m.host, m])),
    })),

  reset: () => set({ hosts: [], sessions: [], metricsByHost: {} }),
}));
