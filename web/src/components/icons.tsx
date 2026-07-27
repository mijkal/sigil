// Monochrome line icons. Project rule: prefer an icon over an emoji for UI chrome
// (emoji render inconsistently across platforms and can't inherit currentColor).
// Each icon is a plain inline SVG that inherits `color` via stroke=currentColor,
// so callers control size (props) and colour (surrounding `color`).
import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}

function svg(size: number, children: React.ReactNode, strokeWidth = 1.8) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden>
      {children}
    </svg>
  );
}

export function BellIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </>, strokeWidth);
}

export function GearIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>, strokeWidth ?? 1.5);
}

export function LinkIcon({ size = 13, strokeWidth }: IconProps) {
  return svg(size, <>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </>, strokeWidth);
}

// A 2U server/rack — the host indicator, so a machine reads distinctly from a
// session's constellation sigil. Colour (via currentColor) encodes connection state.
export function ServerIcon({ size = 14, strokeWidth }: IconProps) {
  return svg(size, <>
    <rect x="3.5" y="4" width="17" height="7" rx="1.6" />
    <rect x="3.5" y="13" width="17" height="7" rx="1.6" />
    <circle cx="7" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="7" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
  </>, strokeWidth ?? 1.6);
}

export function FolderIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z" />
  </>, strokeWidth);
}

// ── File-type glyphs (PreviewPanel file browser) ──────────────────────────────
// A shared page-with-folded-corner base, differentiated by a small body mark.
const page = <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" />;

export function FileIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>{page}<path d="M8 13.5h5M8 17h8" /></>, strokeWidth ?? 1.6);
}

export function FileCodeIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>{page}<path d="M9.5 13.5 8 15.3l1.5 1.7M14.5 13.5l1.5 1.8-1.5 1.7" /></>, strokeWidth ?? 1.6);
}

export function FileDataIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>{page}<path d="M8 13.5h.01M10.5 13.5H16M8 17h.01M10.5 17H16" /></>, strokeWidth ?? 1.6);
}

export function ScriptIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9.5 10 12l-3 2.5M13.5 15H17" />
  </>, strokeWidth ?? 1.6);
}

export function FileImageIcon({ size = 15, strokeWidth }: IconProps) {
  return svg(size, <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M21 15.5 16 11 5 20" />
  </>, strokeWidth ?? 1.6);
}

// Theme control: sun (light), moon (dark), split contrast circle (auto/system).
export function ThemeIcon({ theme, size = 15 }: { theme: 'light' | 'dark' | 'auto'; size?: number }) {
  if (theme === 'light') {
    return svg(size, <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>);
  }
  if (theme === 'dark') {
    return svg(size, <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />);
  }
  // auto — a circle half-filled to read as "adapts to system".
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.8} style={{ display: 'block' }} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
