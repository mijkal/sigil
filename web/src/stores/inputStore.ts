import { create } from 'zustand';
import { useLayoutStore } from './layoutStore';

// inputStore holds the per-channel state for the bottom InputBar, plus a small
// cross-component API so other panels (e.g. the media tray) can hand text to
// whichever input is currently focused — "insert these @paths into the prompt".
//
// State is keyed by channelId so each pane/tab keeps its own draft, and so a
// reattach (new channelId) starts clean.
interface InputStore {
  // channelId -> draft text the user is composing
  drafts: Record<string, string>;
  // channelId -> nonce; bump to ask that channel's InputBar to focus its textarea
  focusNonce: Record<string, number>;
  // channelId -> nonce; bump to ask that channel's terminal to re-stick to the
  // live bottom (exit scrollback overlay / scroll to bottom) after a submit
  stickNonce: Record<string, number>;
  // channelId -> nonce; bump to ask that channel's terminal to open find-in-pane
  findNonce: Record<string, number>;

  setDraft: (channelId: string, text: string) => void;
  appendToDraft: (channelId: string, text: string) => void;
  requestFocus: (channelId: string) => void;
  requestStick: (channelId: string) => void;
  requestFind: (channelId: string) => void;

  // Resolve the channelId of the currently focused pane's active tab (or undefined).
  focusedChannelId: () => string | undefined;
  // Append text to the focused channel's draft and focus it. Used by the media tray.
  insertIntoFocused: (text: string) => void;
}

export const useInputStore = create<InputStore>((set, get) => ({
  drafts: {},
  focusNonce: {},
  stickNonce: {},
  findNonce: {},

  setDraft: (channelId, text) =>
    set(s => ({ drafts: { ...s.drafts, [channelId]: text } })),

  appendToDraft: (channelId, text) =>
    set(s => {
      const cur = s.drafts[channelId] ?? '';
      const sep = cur && !/\s$/.test(cur) ? ' ' : '';
      return { drafts: { ...s.drafts, [channelId]: cur + sep + text } };
    }),

  requestFocus: (channelId) =>
    set(s => ({ focusNonce: { ...s.focusNonce, [channelId]: (s.focusNonce[channelId] ?? 0) + 1 } })),

  requestStick: (channelId) =>
    set(s => ({ stickNonce: { ...s.stickNonce, [channelId]: (s.stickNonce[channelId] ?? 0) + 1 } })),

  requestFind: (channelId) =>
    set(s => ({ findNonce: { ...s.findNonce, [channelId]: (s.findNonce[channelId] ?? 0) + 1 } })),

  focusedChannelId: () => {
    const { focusedPane, panes } = useLayoutStore.getState();
    if (!focusedPane) return undefined;
    const pane = panes.get(focusedPane);
    const tab = pane?.tabs[pane.activeTab];
    return tab?.channelId;
  },

  insertIntoFocused: (text) => {
    const cid = get().focusedChannelId();
    if (!cid) return;
    get().appendToDraft(cid, text);
    get().requestFocus(cid);
  },
}));
