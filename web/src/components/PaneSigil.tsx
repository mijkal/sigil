import { useState } from 'react';
import type { CSSProperties } from 'react';
import { IdentityMark } from './Sigil';
import { activityStyle } from './ActivityDot';
import { useLayoutStore } from '../stores/layoutStore';
import type { SigilBadgeMode, SigilBadgeCorner } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { OsIcon } from './OsIcon';

// PaneSigil — a passive "what am I on" anchor floating in a corner of the terminal
// area. It shows the active session's generative sigil (in its accent ink) plus,
// in labeled mode, the session + host name. Calm by default: dim when the session
// is idle, brightening on live activity or hover. Click hops it to the next corner
// (so it can dodge whatever you're reading). Non-blocking otherwise — only the small
// chip itself takes pointer events, never the surrounding terminal.

interface Props {
  paneId: string;
  session?: Session;
  sessionName: string;
  hostName: string;
  accent?: string | null;
  mode: SigilBadgeMode;        // 'mark' | 'labeled' (caller filters out 'off')
  corner: SigilBadgeCorner;
  minimapInset?: number;       // extra right-inset so right-corner marks clear the wide minimap
}

const cornerPos: Record<SigilBadgeCorner, CSSProperties> = {
  // Generous inset so the mark breathes; right corners clear the always-on
  // scroll rail (~10px) with room to spare.
  tl: { top: 20, left: 22, alignItems: 'flex-start' },
  tr: { top: 20, right: 28, alignItems: 'flex-end' },
  bl: { bottom: 20, left: 22, alignItems: 'flex-start' },
  br: { bottom: 20, right: 28, alignItems: 'flex-end' },
};

// PaneSigilBackdrop — a large, very faint session sigil sitting BEHIND the CLI
// text as an ambient identity layer. It lives between the terminal's base colour
// and the (transparent) scrollback text, so text always composites cleanly on top
// and the live xterm pane stays crisp. Non-interactive; opacity kept low enough to
// never fight legibility.
export function PaneSigilBackdrop({ sessionName, hostName, accent, opacity = 0.13 }: { sessionName: string; hostName?: string; accent?: string | null; opacity?: number }) {
  const ink = accent ?? 'var(--color-accent)';
  // Lift the ink toward a light tone so a dark accent still registers on the
  // near-black terminal. The mark is sparse (thin lines + a few stars) so a higher
  // opacity reads as ambient identity without blanketing — text stays legible.
  const wash = `color-mix(in srgb, ${ink} 62%, #cbd5e1)`;
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    }} aria-hidden>
      <div style={{ opacity, transition: 'opacity 0.4s ease' }}>
        <IdentityMark host={hostName} session={sessionName} name={sessionName} color={wash} size={560} glow />
      </div>
    </div>
  );
}

export function PaneSigil({ paneId, session, sessionName, hostName, accent, mode, corner, minimapInset = 0 }: Props) {
  const cycleCorner = useLayoutStore(s => s.cycleSigilCorner);
  const info = useSessionStore(s => s.metricsByHost[hostName]?.info);
  const [hover, setHover] = useState(false);

  const activity = session?.activity;
  const act = activityStyle(activity);
  // "Live" = actively working/waiting/error/done — those states earn full presence;
  // a plain idle session stays quiet.
  const live = !!activity;
  const ink = accent ?? 'var(--color-accent)';
  const labeled = mode === 'labeled';
  // Mark mode = a large, calm watermark of the pane's own sigil (no redundant
  // text or status pip — the tab and status bar already carry those). Labeled
  // mode stays chip-sized.
  const size = labeled ? 22 : 76;
  const opacity = labeled
    ? (hover ? 1 : live ? 0.92 : 0.4)
    : (hover ? 0.95 : live ? 0.68 : 0.42);

  // On a right corner, push inward past the wide minimap (when shown) so the mark
  // sits to its left rather than under it.
  const isRight = corner === 'tr' || corner === 'br';
  const base = cornerPos[corner];
  const wrap: CSSProperties = {
    position: 'absolute', zIndex: 6, display: 'flex',
    pointerEvents: 'none', // container is inert; the chip re-enables itself
    ...base,
    ...(isRight && minimapInset ? { right: (base.right as number) + minimapInset } : {}),
    transition: 'opacity 0.25s ease, right 0.2s ease, top 0.2s ease, bottom 0.2s ease',
  };

  const chip: CSSProperties = {
    pointerEvents: 'auto', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
    opacity, transition: 'opacity 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease',
    transform: hover ? 'translateY(-1px)' : 'none',
    ...(mode === 'labeled'
      ? {
          padding: '5px 10px 5px 7px', borderRadius: 9,
          background: 'color-mix(in srgb, var(--color-panel) 78%, transparent)',
          border: `1px solid ${hover ? ink : 'var(--color-border)'}`,
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          boxShadow: hover ? `0 6px 20px rgba(0,0,0,0.35)` : '0 2px 8px rgba(0,0,0,0.2)',
        }
      : {}),
  };

  const title = `${sessionName} · ${hostName}${act.title ? ` — ${act.title}` : ''}  (click to move)`;

  return (
    <div style={wrap} aria-hidden>
      <div
        style={chip}
        title={title}
        onClick={() => cycleCorner(paneId)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
          <IdentityMark host={hostName} session={sessionName} name={sessionName} color={ink} size={size} glow animate={false} />
        </span>
        {mode === 'labeled' && (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, lineHeight: 1.15 }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--color-text)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
            }}>{sessionName}</span>
            <span style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
            }}>
              {info && <OsIcon osPretty={info.os_pretty} os={info.os} size={11} />}
              {hostName}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
