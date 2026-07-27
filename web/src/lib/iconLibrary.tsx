import type { CSSProperties } from 'react';

// A curated set of monochrome line marks a user can pick as a host/session identity
// instead of the generative sigil or an uploaded image. Each is a single 24×24
// stroke path drawn in the accent ink (currentColor). Kept geometric + high-tech to
// match the sigil aesthetic.
export interface LineIcon {
  id: string;
  label: string;
  paths?: string[]; // stroked paths (24×24 viewBox)
  fills?: string[]; // optional filled paths
}

export const ICON_LIBRARY: LineIcon[] = [
  { id: 'terminal', label: 'Terminal', paths: ['M4 6h16v12H4z', 'M7 10l2.5 2L7 14', 'M12.5 14H16'] },
  { id: 'cpu', label: 'CPU', paths: ['M8 8h8v8H8z', 'M4 8h1M4 12h1M4 16h1M19 8h1M19 12h1M19 16h1M8 4v1M12 4v1M16 4v1M8 19v1M12 19v1M16 19v1', 'M6 6h12v12H6z'] },
  { id: 'server', label: 'Server', paths: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7 7.5h.01M7 16.5h.01'] },
  { id: 'database', label: 'Database', paths: ['M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'] },
  { id: 'cloud', label: 'Cloud', paths: ['M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17 18H7z'] },
  { id: 'globe', label: 'Globe', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18'] },
  { id: 'bolt', label: 'Bolt', fills: ['M13 2L4 14h6l-1 8 9-12h-6z'] },
  { id: 'rocket', label: 'Rocket', paths: ['M12 3c3 1 5 4 5 8l-2 3H9l-2-3c0-4 2-7 5-8z', 'M9 14l-2 4M15 14l2 4', 'M12 8.5h.01'] },
  { id: 'anchor', label: 'Anchor', paths: ['M12 7v13', 'M9 4.5a3 3 0 1 1 6 0 3 3 0 0 1-6 0z', 'M5 13a7 7 0 0 0 14 0', 'M4 13h3M17 13h3'] },
  { id: 'compass', label: 'Compass', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M15.5 8.5l-2 5-5 2 2-5z'] },
  { id: 'hexagon', label: 'Hexagon', paths: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z'] },
  { id: 'triangle', label: 'Triangle', paths: ['M12 4l8 15H4z'] },
  { id: 'circuit', label: 'Circuit', paths: ['M5 12h4M15 12h4', 'M9 12a3 3 0 0 1 6 0', 'M5 12v-4h4M19 12v4h-4', 'M5 12h.01M19 12h.01'] },
  { id: 'signal', label: 'Signal', paths: ['M5 18v-3M10 18v-6M15 18v-9M20 18V6'] },
  { id: 'shield', label: 'Shield', paths: ['M12 3l7 2.5V11c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V5.5z'] },
  { id: 'key', label: 'Key', paths: ['M14 7a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z', 'M11 12L4 19l1.5 1.5M7 16l2 2'] },
  { id: 'flask', label: 'Flask', paths: ['M9 3h6', 'M10 3v6l-4.5 8A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 9V3', 'M8 15h8'] },
  { id: 'atom', label: 'Atom', paths: ['M12 12h.01', 'M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z', 'M6.5 6.5c3.5-3.5 8.5-4.6 11-2s1.5 7.5-2 11-8.5 4.6-11 2-1.5-7.5 2-11z'] },
  { id: 'wave', label: 'Wave', paths: ['M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0'] },
  { id: 'grid', label: 'Grid', paths: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'] },
  { id: 'moon', label: 'Moon', paths: ['M20 14a8 8 0 1 1-9-11 6.5 6.5 0 0 0 9 11z'] },
  { id: 'star', label: 'Star', paths: ['M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.9 6.7 19.5l1.1-6L3.4 9.3l6-.8z'] },
  { id: 'eye', label: 'Eye', paths: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z', 'M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'] },
  { id: 'ship', label: 'Drydock', paths: ['M6 11V6h5M18 11V6h-5', 'M6 21v-5h5M18 21v-5h-5'], fills: ['M12 7l-2 10h4z'] },
];

export function LineIconGlyph({
  icon, size = 20, color, style,
}: { icon: LineIcon; size?: number; color?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      style={{ color: color ?? 'var(--color-accent)', flexShrink: 0, ...style }} aria-hidden>
      {(icon.paths ?? []).map((d, i) => (
        <path key={`s${i}`} d={d} stroke="currentColor" strokeWidth={1.7}
          strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {(icon.fills ?? []).map((d, i) => <path key={`f${i}`} d={d} fill="currentColor" />)}
    </svg>
  );
}

export const ICON_BY_ID: Record<string, LineIcon> = Object.fromEntries(ICON_LIBRARY.map(i => [i.id, i]));
