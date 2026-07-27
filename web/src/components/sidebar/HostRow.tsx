import React from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useMobileLayout } from '../../hooks/useMobileLayout';
import { HostBadge } from '../HostBadge';
import { HostStatsPopover } from '../HostStatsPopover';
import { OsIcon, classifyOs } from '../OsIcon';
import { ServerIcon } from '../icons';
import { st } from './styles';
import { useSessionColorStore } from '../../stores/sessionColorStore';
import type { Host } from '../../types';

export function HostRow({ host, sessionCount, pinned, onPin, onNewSession, onEdit, onRemove }: {
  host: Host; sessionCount: number; pinned: boolean;
  onPin: () => void; onNewSession: () => void; onEdit: () => void; onRemove: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const [statsAnchor, setStatsAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const [statsMode, setStatsMode] = React.useState<'hover' | 'click' | null>(null);
  const metrics = useSessionStore((s) => s.metricsByHost[host.name]);
  const isMobile = useMobileLayout() !== 'desktop';
  const hostAccent = useSessionColorStore((s) => s.hosts[host.name] ?? null);
  const openPicker = useSessionColorStore((s) => s.openPicker);

  // Popover open/close. Click opens persistently (dismissed by outside-click);
  // hover opens after a short delay and closes when the mouse leaves both the
  // badge and the popover. openReason distinguishes the two so a hover-leave
  // doesn't dismiss a click-opened panel.
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openReason = React.useRef<'hover' | 'click' | null>(null);
  const anchorFrom = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  };
  const openClick = (e: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    openReason.current = 'click';
    setStatsMode('click');
    setStatsAnchor(anchorFrom(e));
  };
  const openHover = (e: React.MouseEvent) => {
    if (isMobile) return;
    const anchor = anchorFrom(e);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (openReason.current !== 'click') {
        openReason.current = 'hover';
        setStatsMode('hover');
        setStatsAnchor(anchor);
      }
    }, 220);
  };
  const closeHover = () => {
    if (isMobile) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (openReason.current === 'hover') {
        openReason.current = null;
        setStatsMode(null);
        setStatsAnchor(null);
      }
    }, 340);
  };
  const cancelClose = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };
  const closeNow = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    openReason.current = null;
    setStatsMode(null);
    setStatsAnchor(null);
  };

  const dotColor =
    host.status === 'connected' ? 'var(--color-success)'
    : host.status === 'error'   ? 'var(--color-danger)'
    :                             'var(--color-muted-dim)';

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center',
        padding: '5px 8px 5px 11px', gap: '6px',
        // Host default colour as a left edge (its sessions inherit this).
        borderLeft: `3px solid ${hostAccent ?? 'transparent'}`,
        background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: 'background 0.1s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={e => {
        e.preventDefault();
        openPicker({ x: e.clientX, y: e.clientY, kind: 'host', host: host.name, current: hostAccent });
      }}
    >
      {/* Host indicator: the OS/distro glyph identifies the machine (Debian, macOS,
          …); a generic server rack is the fallback when the OS is unknown. Coloured
          by connection state, so identity + status read in one mark — distinct from
          a session's constellation sigil. */}
      <span style={{
        display: 'inline-flex', flexShrink: 0, color: dotColor, transition: 'color 0.3s',
        filter: host.status === 'connected' ? `drop-shadow(0 0 3px ${dotColor})` : undefined,
      }}>
        {classifyOs(metrics?.info.os_pretty, metrics?.info.os) !== 'unknown'
          ? <OsIcon osPretty={metrics?.info.os_pretty} os={metrics?.info.os} size={15} opacity={1} color={dotColor} />
          : <ServerIcon size={14} />}
      </span>

      {/* Name (shrinks/ellipsizes; does not grow, so the pin hugs it) */}
      <span style={{
        flexShrink: 1, minWidth: 0, fontSize: '12px', fontWeight: 500,
        color: host.status === 'connected' ? 'var(--color-text)' : 'var(--color-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
      }} title={`${host.user}@${host.hostname}:${host.port}`}>
        {host.name}
      </span>

      {/* Pin indicator — right of the name. Filled when pinned; outline on hover. */}
      {(pinned || hovered) && (
        <button
          style={{ ...st.iconBtn, flexShrink: 0, color: pinned ? 'var(--color-warning)' : 'var(--color-muted)', opacity: pinned ? 1 : 0.6 }}
          onClick={e => { e.stopPropagation(); onPin(); }}
          title={pinned ? 'Unpin host' : 'Pin to top'}
        >
          {pinned ? '★' : '☆'}
        </button>
      )}

      {/* Flex spacer keeps the right cluster pinned to the far edge, aligned across rows */}
      <div style={{ flex: 1 }} />

      {/* Right cluster: [actions overlay] · session-count · stats badge (rightmost, always) */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {/* Action buttons — absolutely positioned to the LEFT of the cluster so
            revealing them on hover never shifts the badges (stable, no flash). */}
        <div
          style={{
            position: 'absolute', right: '100%', top: 0, bottom: 0, marginRight: 4,
            display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 18,
            background: 'linear-gradient(to right, transparent, var(--color-panel) 16px)',
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity 0.12s',
          }}
        >
          <button style={st.iconBtn} onClick={e => { e.stopPropagation(); onNewSession(); }} title="New session">+</button>
          <button style={st.iconBtn} onClick={e => { e.stopPropagation(); onEdit(); }} title="Edit host">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
              <path d="M7.5 1.5L9.5 3.5L3.5 9.5H1.5V7.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            </svg>
          </button>
          <button style={{ ...st.iconBtn, opacity: 0.6 }}
            onClick={e => { e.stopPropagation(); onRemove(); }} title="Remove host">✕</button>
        </div>

        {/* Session count badge — left of the stats badge */}
        {sessionCount > 0 && (
          <span style={{
            fontSize: '10px', color: 'var(--color-muted)',
            background: 'rgba(99,102,241,0.15)', borderRadius: '8px',
            padding: '1px 5px', flexShrink: 0,
          }}>{sessionCount}</span>
        )}

        {/* Health/stats badge — always far right, fixed width → aligned across all hosts */}
        <HostBadge metrics={metrics} onOpen={openClick} onHoverOpen={openHover} onHoverClose={closeHover} />
      </div>

      {statsAnchor && (
        <HostStatsPopover
          host={host.name}
          address={`${host.user}@${host.hostname}:${host.port}`}
          anchor={statsAnchor}
          isMobile={isMobile}
          persistent={statsMode === 'click'}
          onClose={closeNow}
          onPointerEnter={cancelClose}
          onPointerLeave={closeHover}
        />
      )}
    </div>
  );
}
