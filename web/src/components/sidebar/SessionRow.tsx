import React from 'react';
import type { Session, TmuxWindow } from '../../types';
import { SessionGlyph } from '../Sigil';
import { SessionEditModal } from './SessionEditModal';
import { useSessionColorStore, resolveSessionColor } from '../../stores/sessionColorStore';
import { activityTint } from '../ActivityDot';

function WindowRow({ win, onClick }: {
  win: TmuxWindow;
  onClick: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center',
        padding: '3px 12px 3px 40px', cursor: 'pointer', gap: '6px',
        background: hovered ? 'rgba(99,102,241,0.08)' : 'transparent',
        transition: 'background 0.1s',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{
        fontSize: '10px', color: 'var(--color-muted)', flexShrink: 0,
        fontFamily: 'var(--font-mono)', minWidth: '14px', textAlign: 'right',
      }}>{win.index}</span>
      <div style={{
        width: '4px', height: '4px', borderRadius: '50%', flexShrink: 0,
        background: win.active ? 'var(--color-accent)' : 'var(--color-muted-dim)',
      }} />
      <span style={{
        flex: 1, fontSize: '11px', color: win.active ? 'var(--color-text)' : 'var(--color-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
      }}>{win.name}</span>
      {win.panes > 1 && (
        <span style={{ fontSize: '10px', color: 'var(--color-muted-dim)' }}>{win.panes}p</span>
      )}
    </div>
  );
}

// ─── Session row ───────────────────────────────────────────────────────────────

export function SessionRow({ session, onOpen, onOpenWindow, onDelete, onRename, onResurrect }: {
  session: Session;
  onOpen: (windowIndex?: number, windowName?: string) => void;
  onOpenWindow: (windowIndex: number, windowName: string) => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
  onResurrect: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);
  const openPicker = useSessionColorStore(s => s.openPicker);
  const accent = resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, session.host_name, session.name);
  const [editOpen, setEditOpen] = React.useState(false);
  const windows = session.window_list ?? [];
  const hasWindows = windows.length > 1;
  const [expanded, setExpanded] = React.useState(false);

  return (
    <>
      <div
        style={{
          display: 'flex', alignItems: 'center',
          padding: '4px 8px 4px 25px', cursor: 'pointer', gap: '6px',
          borderRadius: '4px', margin: '1px 4px',
          // Session accent as a left edge (transparent keeps the row aligned).
          borderLeft: `3px solid ${accent ?? 'transparent'}`,
          background: activityTint(session.activity, hovered),
          transition: 'background 0.18s ease',
        }}
        onClick={() => {
          if (hasWindows && !expanded) setExpanded(true);
          const activeWin = windows.find(w => w.active);
          onOpen(activeWin?.index, activeWin?.name);
        }}
        onContextMenu={e => {
          e.preventDefault();
          openPicker({ x: e.clientX, y: e.clientY, kind: 'session', host: session.host_name, session: session.name,
            current: sessionColors[`${session.host_name}::${session.name}`] ?? null });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Expand chevron */}
        <span
          style={{
            fontSize: '9px', color: 'var(--color-muted)', flexShrink: 0,
            visibility: hasWindows ? 'visible' : 'hidden',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s', display: 'inline-block', cursor: 'pointer',
          }}
          onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
        >▾</span>
        <SessionGlyph host={session.host_name} session={session.name} name={session.name} color={accent ?? undefined} size={15}
          activity={session.activity} active={session.status === 'active'} />

        {/* Session name — a tap selects/opens the session (row onClick). Editing is
            explicit via the ✎ button; no double-click behaviour. */}
        <span
          style={{
            flex: 1, fontSize: '12px', color: 'var(--color-text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
          }}
        >{session.name}</span>

        {/* Window count / action buttons */}
        {hovered ? (
          <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <button
              title="Edit session — rename, colour, sigil"
              aria-label="Edit session"
              onClick={e => { e.stopPropagation(); setEditOpen(true); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
                color: 'var(--color-muted)', fontSize: '11px', lineHeight: 1,
                borderRadius: '3px',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-muted)')}
            >✎</button>
            <button
              title={`Resurrect session${session.start_dir ? ` at ${session.start_dir}` : ''} (idempotent — no-op if already alive)`}
              onClick={onResurrect}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
                color: 'var(--color-muted)', fontSize: '11px', lineHeight: 1,
                borderRadius: '3px',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-muted)')}
            >⟳</button>
            <button
              title="Delete session"
              onClick={() => { if (confirm(`Kill session "${session.name}"?`)) onDelete(); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
                color: 'var(--color-muted)', fontSize: '11px', lineHeight: 1,
                borderRadius: '3px',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-danger)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-muted)')}
            >✕</button>
          </div>
        ) : (
          <>
            {windows.length > 1 ? (
              <span style={{ fontSize: '10px', color: 'var(--color-muted)', flexShrink: 0 }}>{windows.length}w</span>
            ) : session.windows > 1 ? (
              <span style={{ fontSize: '10px', color: 'var(--color-muted)', flexShrink: 0 }}>{session.windows}w</span>
            ) : null}
          </>
        )}
      </div>

      {/* Expanded window list */}
      {expanded && hasWindows && windows.map(win => (
        <WindowRow
          key={win.id || win.index}
          win={win}
          onClick={() => onOpenWindow(win.index, win.name)}
        />
      ))}

      {editOpen && (
        <SessionEditModal session={session} onClose={() => setEditOpen(false)} onRename={onRename} />
      )}
    </>
  );
}
