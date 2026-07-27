// Icons — small inline-SVG glyphs (currentColor, 1em) for the UI kit. Replaces
// the emoji iconography that read as unfinished and rendered inconsistently
// across platforms. Each is 24x24, stroke-based, inherits color + size.
import type { CSSProperties } from 'react';

type P = { size?: number; style?: CSSProperties; strokeWidth?: number };

function svg(size: number, sw: number, style: CSSProperties | undefined, children: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }} aria-hidden>
      {children}
    </svg>
  );
}

export const IconMenu = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>);

export const IconSessions = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /></>);

export const IconFiles = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />);

export const IconPlus = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const IconClose = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>);

export const IconSearch = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);

export const IconChevronLeft = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <path d="M15 6l-6 6 6 6" />);

export const IconChevronRight = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <path d="M9 6l6 6-6 6" />);

export const IconTerminal = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>);

export const IconSliders = ({ size = 22, strokeWidth = 2, style }: P) =>
  svg(size, strokeWidth, style, <><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h2" /><path d="M10 17h10" /><circle cx="8" cy="17" r="2" /></>);
