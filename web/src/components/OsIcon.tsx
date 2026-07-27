// OsIcon — a small MONOCHROME OS/distro glyph derived from the host's os_pretty
// (metrics probe). Same colour for all (currentColor); distinct shapes per known
// distro, generic penguin otherwise. macOS → Finder face; Apple logo is reserved
// as the iOS/iPadOS fallback. Renders nothing for unknown/disconnected hosts.
import type { CSSProperties } from 'react';

type OsKind =
  | 'mac' | 'ios' | 'ubuntu' | 'debian' | 'fedora' | 'arch'
  | 'alpine' | 'bsd' | 'linux' | 'windows' | 'unknown';

export function classifyOs(osPretty?: string, os?: string): OsKind {
  const s = `${osPretty ?? ''} ${os ?? ''}`.toLowerCase();
  if (/ios|ipad|iphone/.test(s)) return 'ios';
  if (s.includes('mac') || s.includes('darwin')) return 'mac';
  if (s.includes('ubuntu')) return 'ubuntu';
  if (s.includes('debian')) return 'debian';
  if (/fedora|red hat|rhel|centos|rocky|alma/.test(s)) return 'fedora';
  if (s.includes('arch')) return 'arch';
  if (s.includes('alpine')) return 'alpine';
  if (s.includes('bsd')) return 'bsd';
  if (s.includes('linux')) return 'linux';
  if (s.includes('windows')) return 'windows';
  return 'unknown';
}

export function OsIcon({ osPretty, os, size = 14, opacity = 0.85, color = 'currentColor', title, style }: {
  osPretty?: string; os?: string; size?: number; opacity?: number; color?: string; title?: string; style?: CSSProperties;
}) {
  const kind = classifyOs(osPretty, os);
  if (kind === 'unknown') return null;
  const label = title ?? osPretty ?? os ?? kind;
  const c = { width: size, height: size, viewBox: '0 0 24 24', fill: color, style: { flexShrink: 0, opacity, ...style } as CSSProperties };
  const t = <title>{label}</title>;

  switch (kind) {
    case 'ios': // Apple logo (reserved for iOS/iPadOS)
      return <svg {...c} aria-label={label}>{t}<path d="M16.3 12.9c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6 1.2 0 1.5.6 2.5.6 1 0 1.7-1 2.3-2 .5-.7.7-1.4.8-1.5-.1 0-1.6-.6-1.6-2.4zM14.6 6.9c.6-.7 1-1.6.9-2.5-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.9 2.4.9.1 1.8-.4 2.4-1.1z" /></svg>;
    case 'mac': // Finder face (classic split face)
      return (
        <svg {...c} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-label={label}>{t}
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M12 4v11" />
          <path d="M6.5 9.5v1.5M10 9.5v1.5" />
          <path d="M14.5 15c1.6 1.3 3.4 1.3 5 0" />
        </svg>
      );
    case 'ubuntu': // circle of friends
      return (
        <svg {...c} fill="none" stroke={color} strokeWidth="1.6" aria-label={label}>{t}
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="4.2" r="1.9" fill={color} /><circle cx="5.2" cy="16" r="1.9" fill={color} /><circle cx="18.8" cy="16" r="1.9" fill={color} />
        </svg>
      );
    case 'debian': // swirl
      return (
        <svg {...c} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" aria-label={label}>{t}
          <path d="M15.5 6.2A7 7 0 1 0 18 12a5.4 5.4 0 1 1-4.2-5.3 4 4 0 1 0 1.3 6.1" />
        </svg>
      );
    case 'fedora': // f in a ring
      return (
        <svg {...c} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-label={label}>{t}
          <circle cx="12" cy="12" r="8.5" />
          <path d="M13.5 8.2a2 2 0 0 0-3.5 1.4V16" /><path d="M8.5 11.8h4" />
        </svg>
      );
    case 'arch': // mountain / chevron
      return <svg {...c} aria-label={label}>{t}<path d="M12 3 4 20l8-3.4L20 20 12 3zm0 5 4 8.5-4-1.6-4 1.6L12 8z" /></svg>;
    case 'alpine': // simple peak
      return <svg {...c} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" aria-label={label}>{t}<path d="M3 18 9 8l3 4 2-3 4 9H3z" /></svg>;
    case 'windows':
      return <svg {...c} aria-label={label}>{t}<path d="M3 5.5 11 4.3V11H3V5.5zM11 12.9V19.7L3 18.5V12.9h8zM12.2 4.1 21 3v8.9h-8.8V4.1zM21 12.9V21l-8.8-1.2v-6.9H21z" /></svg>;
    // generic Linux penguin (Tux silhouette)
    default:
      return <svg {...c} aria-label={label}>{t}<path d="M12 2c-2.2 0-3.8 1.7-3.8 4.2 0 1.1.1 1.8.1 2.6-.4.6-1.4 1.8-2.3 3.6-.8 1.6-1.6 3.2-2 3.8-.3.5 0 1 .5 1.1.6.1 1.2-.2 1.6-.6-.2.9-.4 1.9-.9 2.7-.3.6.1 1.1.7 1.1h1.7c.4 0 .7-.3.8-.6.2.3.5.6.9.6h1.6c.4 0 .7-.3.9-.6.1.3.4.6.8.6h1.7c.6 0 1-.5.7-1.1-.5-.8-.7-1.8-.9-2.7.4.4 1 .7 1.6.6.5-.1.8-.6.5-1.1-.4-.6-1.2-2.2-2-3.8-.9-1.8-1.9-3-2.3-3.6 0-.8.1-1.5.1-2.6C15.8 3.7 14.2 2 12 2zm-1.5 3.4c.4 0 .8.4.8.9s-.4.9-.8.9-.8-.4-.8-.9.4-.9.8-.9zm3 0c.4 0 .8.4.8.9s-.4.9-.8.9-.8-.4-.8-.9.4-.9.8-.9zm-1.5 1.7c.7 0 1.5.5 1.5.9 0 .3-.8.7-1.5.7s-1.5-.4-1.5-.7c0-.4.8-.9 1.5-.9z" /></svg>;
  }
}
