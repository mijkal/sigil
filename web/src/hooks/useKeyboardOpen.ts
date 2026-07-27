import { useEffect, useState } from 'react';

// useKeyboardOpen reports whether the mobile soft keyboard is (probably) open, by
// watching how much the visual viewport has shrunk below the layout viewport.
// Used to collapse non-essential bottom chrome so the compose input sits right
// above the keyboard. Always false on desktop (no visualViewport shrink).
export function useKeyboardOpen(threshold = 140): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => setOpen(window.innerHeight - vv.height > threshold);
    check();
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, [threshold]);
  return open;
}
