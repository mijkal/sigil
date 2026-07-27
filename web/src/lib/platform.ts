// Display-only shortcut modifier: ⌘ on macOS, Ctrl everywhere else. The key
// handlers accept metaKey || ctrlKey, so both physically work — this only keeps
// the on-screen hints honest per OS.
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test((navigator.platform || navigator.userAgent || '') as string);

export const MOD = IS_MAC ? '⌘' : 'Ctrl';

// A full combo label, e.g. modKey('K') → "⌘K" (mac) / "Ctrl+K" (win/linux).
export const modKey = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
