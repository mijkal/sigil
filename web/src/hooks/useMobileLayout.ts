import { useEffect, useState } from 'react';

export type LayoutMode = 'phone' | 'tablet' | 'desktop';

function getMode(width: number): LayoutMode {
  if (width <= 640) return 'phone';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

export function useMobileLayout(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => getMode(window.innerWidth));

  useEffect(() => {
    const handler = () => setMode(getMode(window.innerWidth));
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return mode;
}
