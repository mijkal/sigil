import { create } from 'zustand';

// Session-sigil animation preferences (per-device, localStorage). Two independent
// switches, mirroring the terminalStore toggle pattern:
//   summon  — the SummonOverlay ritual when a session opens into a tab.
//   ambient — a gentle continuous breathe on the large empty-pane / hero sigil.
// Turning both off is the "no sigil animation" state.
const SUMMON_KEY = 'sigil_anim_summon';
const AMBIENT_KEY = 'sigil_anim_ambient';

interface SigilAnimStore {
  summon: boolean;
  ambient: boolean;
  toggleSummon: () => void;
  toggleAmbient: () => void;
}

export const useSigilAnimStore = create<SigilAnimStore>((set) => ({
  // Summon overlay defaults ON (the current behaviour); explicit '0' opts out.
  summon: localStorage.getItem(SUMMON_KEY) !== '0',
  // Ambient breathe defaults OFF (the empty-pane sigil has been static); '1' opts in.
  ambient: localStorage.getItem(AMBIENT_KEY) === '1',

  toggleSummon: () => set(s => {
    const n = !s.summon;
    localStorage.setItem(SUMMON_KEY, n ? '1' : '0');
    return { summon: n };
  }),

  toggleAmbient: () => set(s => {
    const n = !s.ambient;
    localStorage.setItem(AMBIENT_KEY, n ? '1' : '0');
    return { ambient: n };
  }),
}));
