import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// ui/Popover — a glass anchored floating card. Owns click-outside, Escape, and
// on-screen clamping; the frosted surface matches the Modal. Used for the accent
// colour menu, host-stats, links, etc. — one place to style every popover.
export function Popover({
  x, y, width = 220, align = 'start', maxHeight = 320, onClose, children, style,
}: {
  x: number; y: number;
  width?: number;
  align?: 'start' | 'center';
  maxHeight?: number;
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Defer the outside-click listener so the opening click doesn't self-close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const dx = align === 'center' ? width / 2 : 0;
  const left = Math.max(8, Math.min(x - dx, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(maxHeight, window.innerHeight - 16)));

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ ...card, left, top, width, maxHeight, ...style }}>
      {children}
    </div>
  );
}

const card: CSSProperties = {
  position: 'fixed', zIndex: 10000, padding: 12, borderRadius: 12, overflowY: 'auto',
  background: 'color-mix(in srgb, var(--color-panel) 82%, transparent)',
  backdropFilter: 'blur(20px) saturate(1.5)', WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
  border: '1px solid color-mix(in srgb, var(--color-border) 85%, transparent)',
  boxShadow: '0 14px 44px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
  fontFamily: 'var(--font-ui)',
};
