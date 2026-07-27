import { useEffect } from 'react';

// useKeyboardInset keeps the app's usable height in sync with the *visual*
// viewport so a bottom-pinned input bar rides above the mobile soft keyboard
// instead of being hidden behind it.
//
// It sets two CSS custom properties on <html>:
//   --app-height : the visible viewport height in px (shrinks when the keyboard
//                  opens). The app container reads height: var(--app-height,100dvh)
//                  so it falls back to 100dvh on desktop / unsupported browsers.
//   --kb-offset  : visualViewport.offsetTop — non-zero when iOS scrolls the page
//                  under the keyboard; lets fixed elements compensate.
//
// On desktop the visualViewport height equals the window height and never
// changes (no keyboard), so this is a no-op there.
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // unsupported — 100dvh fallback applies

    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--kb-offset', `${Math.round(vv.offsetTop)}px`);
    };

    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--kb-offset');
    };
  }, []);
}
