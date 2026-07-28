import { modKey } from '../lib/platform';
import React, { useCallback, useState } from 'react';
import { useLayoutStore, paneMinimapMode, paneScrollRail, paneSigilBadge, paneSigilCorner, paneSigilBackdrop } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useTerminalStore } from '../stores/terminalStore';
import { LinkIcon, ServerIcon } from './icons';
import { OsIcon, classifyOs } from './OsIcon';
import { ActivityDot } from './ActivityDot';
import { ColorPickerMenu } from './ColorPickerMenu';
import { SummonOverlay } from './SummonOverlay';
import { useSessionColorStore, resolveSessionColor } from '../stores/sessionColorStore';
import { TerminalTile } from './TerminalTile';
import { UnifiedTerminalTile } from './UnifiedTerminalTile';
import { InputBar } from './InputBar';
import { LinksPopover } from './LinksPopover';
import { useMobileLayout } from '../hooks/useMobileLayout';
import { useInputStore } from '../stores/inputStore';
import { IconSearch } from '../ui/Icons';
import { IdentityMark } from './Sigil';
import { BrandMark } from './BrandMark';
import { PaneSigil, PaneSigilBackdrop } from './PaneSigil';
import { useSigilAnimStore } from '../stores/sigilAnimStore';
import type { TabConfig } from '../stores/layoutStore';
import type { Host, Session } from '../types';

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconSplitRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="2" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="2" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconSplitDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="2" y="1" width="10" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="8" width="10" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  // Guard against unset/zero timestamps (Go's zero time 0001-01-01 → ~739811d)
  // and unparseable values, which otherwise render as absurd "739811d ago".
  if (!iso || Number.isNaN(t) || t < 0) return '—';
  const secs = (Date.now() - t) / 1000;
  if (secs < 5) return 'just now';
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

interface TabProps {
  tab: TabConfig;
  active: boolean;
  session: Session | undefined;
  host: Host | undefined;
  index: number;
  accent: string | null;   // resolved per-session colour (null → theme accent)
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
  onReorder: (from: number, to: number) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function Tab({ tab, active, session, index, accent, onClick, onClose, onReorder, onContextMenu }: TabProps) {
  const [hovered, setHovered] = React.useState(false);
  const [dropEdge, setDropEdge] = React.useState<'left' | 'right' | null>(null);

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/x-sigil-tab', String(index));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes('application/x-sigil-tab')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDropEdge(e.clientX < r.left + r.width / 2 ? 'left' : 'right');
      }}
      onDragLeave={() => setDropEdge(null)}
      onDrop={e => {
        const raw = e.dataTransfer.getData('application/x-sigil-tab');
        setDropEdge(null);
        if (raw === '') return;
        e.preventDefault();
        const from = parseInt(raw, 10);
        if (Number.isNaN(from)) return;
        // Dropping on the right half of a tab inserts after it.
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        let to = e.clientX < r.left + r.width / 2 ? index : index + 1;
        if (from < to) to -= 1; // account for the removal shift
        onReorder(from, to);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 10px 0 12px',
        height: '100%',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        maxWidth: '220px',
        minWidth: '80px',
        position: 'relative',
        borderRight: '1px solid var(--color-border)',
        boxShadow: dropEdge === 'left' ? 'inset 2px 0 0 var(--color-accent)'
                 : dropEdge === 'right' ? 'inset -2px 0 0 var(--color-accent)' : 'none',
        background: active ? 'var(--color-bg)' : 'transparent',
        color: active ? 'var(--color-text)' : 'var(--color-muted)',
        transition: 'background 0.1s, color 0.1s',
        userSelect: 'none',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      title={`${tab.hostName} / ${tab.sessionName}${session ? `\nWindows: ${session.windows}  Status: ${session.status}` : ''}\nRight-click to set a colour`}
    >
      {/* Full-width colour bar. On the active tab it always shows (in the session
          colour, or the theme accent if none set). On inactive tabs it appears
          only when the session has a custom colour, dimmed — so coloured sessions
          stay identifiable across every tab without cluttering uncoloured ones. */}
      {(active || accent) && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: '2px',
          background: accent ?? 'var(--color-accent)',
          opacity: active ? 1 : 0.55,
          borderRadius: '0 0 1px 1px',
        }} />
      )}

      {/* The tab carries just the session's sigil — its mark, in its ink. When the
          session is actively working the mark breathes subtly (the same keyframe
          the activity dot uses), a calm "this one is live" cue; it settles the
          moment the session leaves 'working'. Other state lives in the status bar. */}
      <span style={{
        display: 'inline-flex', flexShrink: 0,
        animation: session?.activity === 'working' ? 'sigil-breathe 2.6s ease-in-out infinite' : undefined,
      }}>
        <IdentityMark host={tab.hostName} session={tab.sessionName} name={tab.sessionName} color={accent ?? undefined} size={14} glow={false} />
      </span>

      {/* Label */}
      <span style={{
        fontSize: '12px',
        fontFamily: 'var(--font-mono)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: 1,
        minWidth: 0,
      }}>
        <span style={{ color: active ? 'var(--color-accent)' : 'inherit', opacity: active ? 0.9 : 0.7 }}>
          {tab.hostName}
        </span>
        <span style={{ opacity: 0.4, margin: '0 2px' }}>/</span>
        <span>{tab.sessionName}</span>
        {tab.windowName && (
          <span style={{ opacity: 0.5, marginLeft: '3px' }}>:{tab.windowName}</span>
        )}
        {tab.windowIndex !== undefined && tab.windowIndex >= 0 && !tab.windowName && (
          <span style={{ opacity: 0.4, marginLeft: '3px' }}>:{tab.windowIndex}</span>
        )}
      </span>

      {/* Close button */}
      <button
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-muted)',
          borderRadius: '3px',
          opacity: hovered || active ? 1 : 0,
          transition: 'opacity 0.1s, background 0.1s, color 0.1s',
          flexShrink: 0,
          width: '16px',
          height: '16px',
        }}
        onClick={onClose}
        title="Close tab"
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-danger)';
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.12)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-muted)';
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }}
      >
        <IconClose />
      </button>
    </div>
  );
}

// ─── Session Status Bar ───────────────────────────────────────────────────────

interface StatusBarProps {
  tab: TabConfig | undefined;
  session: Session | undefined;
  host: Host | undefined;
  accent?: string | null;
  linksOpen: boolean;
  onToggleLinks: () => void;
}

function SessionStatusBar({ tab, session, host, accent, linksOpen, onToggleLinks }: StatusBarProps) {
  const hostMetrics = useSessionStore(s => (host ? s.metricsByHost[host.name] : undefined));
  const hostColor =
    host?.status === 'connected' ? 'var(--color-success)' :
    host?.status === 'error'     ? 'var(--color-danger)'  :
                                   'var(--color-muted)';

  const sessColor =
    session?.status === 'active'   ? 'var(--color-success)' :
    session?.status === 'detached' ? 'var(--color-warning)' :
                                     'var(--color-muted)';

  return (
    <div style={{
      height: '22px',
      background: 'var(--color-panel)',
      // The top edge doubles as the session's accent line when a colour is set.
      borderTop: accent ? `2px solid ${accent}` : '1px solid var(--color-border)',
      display: 'flex',
      alignItems: 'center',
      gap: '0',
      flexShrink: 0,
      overflow: 'hidden',
      fontSize: '11px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--color-muted)',
    }}>
      {/* Host — OS/distro glyph (server fallback) identifies the machine, coloured
          by connection state. */}
      <Segment>
        <span style={{ display: 'inline-flex', color: hostColor, marginRight: '5px' }}>
          {classifyOs(hostMetrics?.info.os_pretty, hostMetrics?.info.os) !== 'unknown'
            ? <OsIcon osPretty={hostMetrics?.info.os_pretty} os={hostMetrics?.info.os} size={12} opacity={1} color={hostColor} />
            : <ServerIcon size={11} />}
        </span>
        <span style={{ color: host ? 'var(--color-text)' : 'var(--color-muted)' }}>
          {tab?.hostName ?? '—'}
        </span>
        {host?.status && (
          <span style={{ opacity: 0.5, marginLeft: '4px' }}>{host.status}</span>
        )}
      </Segment>

      <Divider />

      {/* Session — the live-activity indicator lives here (working breathes;
          waiting/error/done pop; else active/detached), freeing the tab to carry
          just the sigil. */}
      <Segment>
        {session
          ? <span style={{ display: 'inline-flex', marginRight: '5px' }}><ActivityDot session={session} size={7} /></span>
          : <span style={{ color: sessColor, marginRight: '4px', fontSize: '8px' }}>⬤</span>}
        <span style={{ color: session ? 'var(--color-text)' : 'var(--color-muted)' }}>
          {tab?.sessionName ?? '—'}
        </span>
        {session && (
          <span style={{ opacity: 0.6, marginLeft: '4px' }}>{session.activity ?? session.status}</span>
        )}
      </Segment>

      {session && (
        <>
          <Divider />
          <Segment>
            <span style={{ opacity: 0.5, marginRight: '3px' }}>⬡</span>
            {session.windows} {session.windows === 1 ? 'window' : 'windows'}
          </Segment>

          <Divider />
          <Segment>
            <span style={{ opacity: 0.5, marginRight: '3px' }}>↺</span>
            {relativeTime(session.last_active)}
          </Segment>
        </>
      )}

      {/* Spacer + links + channel id */}
      <div style={{ flex: 1 }} />
      {tab?.channelId && (
        <button
          onClick={onToggleLinks}
          title="Links in this session"
          style={{
            background: linksOpen ? 'var(--color-border)' : 'transparent',
            border: 'none', cursor: 'pointer', height: '100%',
            padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px',
            fontSize: '11px', fontFamily: 'var(--font-mono)',
            color: linksOpen ? 'var(--color-accent)' : 'var(--color-muted)',
          }}
        >
          <LinkIcon size={12} /> links
        </button>
      )}
      {tab?.channelId && (
        <Segment style={{ opacity: 0.3 }}>
          {tab.channelId.slice(0, 13)}
        </Segment>
      )}
    </div>
  );
}

function Segment({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '0 10px',
      height: '100%',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div style={{
      width: '1px',
      height: '12px',
      background: 'var(--color-border)',
      flexShrink: 0,
    }} />
  );
}

// ─── PaneView ─────────────────────────────────────────────────────────────────

interface PaneViewProps {
  paneId: string;
}

export function PaneView({ paneId }: PaneViewProps) {
  const pane = useLayoutStore(s => s.panes.get(paneId));
  const focusedPane = useLayoutStore(s => s.focusedPane);
  const closeTab = useLayoutStore(s => s.closeTab);
  const closePane = useLayoutStore(s => s.closePane);
  const paneCount = useLayoutStore(s => s.panes.size);
  const setFocusedPane = useLayoutStore(s => s.setFocusedPane);
  const sessions = useSessionStore(s => s.sessions);
  const hosts = useSessionStore(s => s.hosts);
  const unified = useTerminalStore(s => s.unified);
  const sigilAmbient = useSigilAnimStore(s => s.ambient);

  const [linksOpen, setLinksOpen] = useState(false);
  const toggleLinks = useCallback(() => setLinksOpen(o => !o), []);

  // Per-session accent colours — for the status bar's accent line.
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);

  const isFocused = focusedPane === paneId;
  // On phones the tab bar (controls live in the top header now) and the status
  // bar (its info is in the top header + bottom session strip) are dropped to
  // keep the chrome compact — no empty control strip, no duplicate session line.
  const isMobile = useMobileLayout() === 'phone';

  const handlePaneClick = useCallback(() => {
    setFocusedPane(paneId);
  }, [paneId, setFocusedPane]);

  if (!pane) return null;

  const activeTab = pane.tabs[pane.activeTab] as TabConfig | undefined;
  const activeSession = activeTab
    ? sessions.find(s => s.host_name === activeTab.hostName && s.name === activeTab.sessionName)
    : undefined;
  const activeHost = activeTab
    ? hosts.find(h => h.name === activeTab.hostName)
    : undefined;

  if (pane.tabs.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          background: 'var(--color-bg)',
          outline: isFocused ? '1px solid var(--color-accent)' : '1px solid transparent',
          outlineOffset: '-1px',
        }}
        onClick={handlePaneClick}
      >
        {!isMobile && <TabBar paneId={paneId} pane={pane} isFocused={isFocused} sessions={sessions} hosts={hosts} />}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontSize: '24px', opacity: 0.15, color: 'var(--color-accent)' }}>⬡</div>
          <div style={{ fontSize: '12px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
            Open a session from the sidebar
          </div>
          {/* Empty panes persist after their last tab closes; when the layout has
              more than one pane, offer an explicit way to remove this one. */}
          {paneCount > 1 && (
            <button
              onClick={e => { e.stopPropagation(); closePane(paneId); }}
              style={{
                marginTop: '4px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: '4px',
                color: 'var(--color-muted)',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                padding: '4px 10px',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-danger)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-danger)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-muted)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)';
              }}
            >
              <IconClose /> Close this pane
            </button>
          )}
        </div>
        {!isMobile && <SessionStatusBar tab={undefined} session={undefined} host={undefined} linksOpen={false} onToggleLinks={() => {}} />}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--color-bg)',
        outline: isFocused ? '1px solid rgba(99,102,241,0.4)' : '1px solid transparent',
        outlineOffset: '-1px',
      }}
      onClick={handlePaneClick}
    >
      {/* Tab bar (desktop/tablet only — mobile controls live in the top header) */}
      {!isMobile && <TabBar paneId={paneId} pane={pane} isFocused={isFocused} sessions={sessions} hosts={hosts} />}

      {/* Terminal area — all mounted, only active visible. Paints the terminal
          base colour so the optional sigil backdrop (below) can sit between it and
          the transparent scrollback text. */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0A0A0C' }}>
        {activeTab && paneSigilBackdrop(pane) && (
          <PaneSigilBackdrop
            sessionName={activeTab.sessionName}
            hostName={activeTab.hostName}
            accent={resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, activeTab.hostName, activeTab.sessionName)}
            opacity={isMobile ? 0.2 : 0.13}
          />
        )}
        {pane.tabs.map((tab, idx) => {
          const isActive = idx === pane.activeTab;
          return (
            <div
              key={`${paneId}-tab-${idx}-${tab.sessionId}`}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <TabBody
                paneId={paneId}
                tabIdx={idx}
                tab={tab}
                isActive={isActive}
                onClose={() => closeTab(paneId, idx)}
              />
            </div>
          );
        })}
        {pane.tabs.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16, opacity: 0.5,
          }}>
            <span style={{ display: 'inline-flex', animation: sigilAmbient ? 'sigil-breathe 6s ease-in-out infinite' : undefined }}>
              <BrandMark size={112} glow />
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
              no session &middot; open one from the sidebar
            </div>
          </div>
        )}

        {/* Floating "what am I on" sigil badge (per-pane, persisted) */}
        {activeTab && paneSigilBadge(pane) !== 'off' && (
          <PaneSigil
            paneId={paneId}
            session={activeSession}
            sessionName={activeTab.sessionName}
            hostName={activeTab.hostName}
            accent={resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, activeTab.hostName, activeTab.sessionName)}
            mode={paneSigilBadge(pane)}
            corner={paneSigilCorner(pane)}
            minimapInset={unified && paneMinimapMode(pane) !== 'off' ? 70 : 0}
          />
        )}
      </div>

      {/* Compose / input bar — always at the bottom, above the status bar, so it
          stays put while browsing scrollback and works with either terminal. */}
      {/* Links list — in the flex flow above the input, never overlays content */}
      {linksOpen && activeTab && (
        <LinksPopover sessionId={activeTab.sessionId} onClose={() => setLinksOpen(false)} />
      )}

      <InputBar
        channelId={activeTab?.channelId}
        accent={activeTab ? resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, activeTab.hostName, activeTab.sessionName) : null}
      />

      {/* Session status bar (desktop/tablet only — mobile shows session in the
          top header + bottom strip) */}
      {!isMobile && (
        <SessionStatusBar
          tab={activeTab}
          session={activeSession}
          host={activeHost}
          accent={activeTab ? resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, activeTab.hostName, activeTab.sessionName) : null}
          linksOpen={linksOpen}
          onToggleLinks={toggleLinks}
        />
      )}
    </div>
  );
}

// ─── TabBody — picks classic xterm or unified-scrollback prototype ───────────

interface TabBodyProps {
  paneId: string;
  tabIdx: number;
  tab: TabConfig;
  isActive: boolean;
  onClose: () => void;
}

function TabBody({ paneId, tabIdx, tab, isActive, onClose }: TabBodyProps) {
  const unified = useTerminalStore(s => s.unified);
  const Component = unified ? UnifiedTerminalTile : TerminalTile;
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);
  const accent = resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, tab.hostName, tab.sessionName);
  return (
    <>
      <Component
        paneId={paneId}
        tabIdx={tabIdx}
        hostName={tab.hostName}
        sessionName={tab.sessionName}
        sessionId={tab.sessionId}
        windowIndex={tab.windowIndex}
        visible={isActive}
        onClose={onClose}
      />
      <SummonOverlay key={tab.sessionId} name={tab.sessionName} color={accent ?? undefined} />
    </>
  );
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

interface TabBarProps {
  paneId: string;
  pane: import('../stores/layoutStore').PaneConfig;
  isFocused: boolean;
  sessions: import('../types').Session[];
  hosts: import('../types').Host[];
}

function TabBar({ paneId, pane, isFocused: _isFocused, sessions, hosts }: TabBarProps) {
  const activateTab = useLayoutStore(s => s.activateTab);
  const closeTab = useLayoutStore(s => s.closeTab);
  const reorderTab = useLayoutStore(s => s.reorderTab);
  const splitPane = useLayoutStore(s => s.splitPane);
  const closePane = useLayoutStore(s => s.closePane);
  const panes = useLayoutStore(s => s.panes);
  const { fontSize, increase, decrease, reset, unified, toggleUnified, binaryWs, toggleBinaryWs } = useTerminalStore();
  const client = useConnectionStore(s => s.client);
  const toggleTimestamps = useLayoutStore(s => s.toggleTimestamps);
  const cycleMinimap = useLayoutStore(s => s.cycleMinimap);
  const toggleSoftWrap = useLayoutStore(s => s.toggleSoftWrap);
  const toggleScrollRail = useLayoutStore(s => s.toggleScrollRail);
  const cycleSigilBadge = useLayoutStore(s => s.cycleSigilBadge);
  const cycleSigilCorner = useLayoutStore(s => s.cycleSigilCorner);
  const toggleSigilBackdrop = useLayoutStore(s => s.toggleSigilBackdrop);
  const showTimestamps = !!pane.showTimestamps;
  const minimapMode = paneMinimapMode(pane);
  const showMinimap = minimapMode !== 'off';
  const softWrap = !!pane.softWrap;
  const showRail = paneScrollRail(pane);
  const sigilBadge = paneSigilBadge(pane);
  const sigilCorner = paneSigilCorner(pane);
  const sigilBackdrop = paneSigilBackdrop(pane);
  // Per-session accent colours (right-click a tab to set).
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);
  const setSessionColor = useSessionColorStore(s => s.setSessionColor);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number; host: string; session: string; current: string | null } | null>(null);
  // On phones the bottom session strip (MobileLayout) is the tab switcher, so the
  // in-pane tab list and split/close controls are redundant — hide them and keep
  // just the zoom + terminal-mode toggle in a slim control row.
  const isMobile = useMobileLayout() === 'phone';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      height: '34px',
      background: 'var(--color-panel)',
      borderBottom: '1px solid var(--color-border)',
      flexShrink: 0,
      overflow: 'hidden',
      justifyContent: isMobile ? 'flex-end' : undefined,
    }}>
      {/* Scrollable tab list — desktop/tablet only */}
      {!isMobile && (
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
      }}>
        {pane.tabs.map((tab, idx) => {
          const sess = sessions.find(s => s.host_name === tab.hostName && s.name === tab.sessionName);
          const host = hosts.find(h => h.name === tab.hostName);
          const accent = resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, tab.hostName, tab.sessionName);
          return (
            <Tab
              key={`${paneId}-tab-${idx}-${tab.sessionId}`}
              tab={tab}
              active={idx === pane.activeTab}
              session={sess}
              host={host}
              index={idx}
              accent={accent}
              onClick={() => activateTab(paneId, idx)}
              onClose={e => { e.stopPropagation(); closeTab(paneId, idx); }}
              onReorder={(from, to) => reorderTab(paneId, from, to)}
              onContextMenu={e => {
                e.preventDefault();
                setColorPicker({ x: e.clientX, y: e.clientY, host: tab.hostName, session: tab.sessionName,
                  current: sessionColors[`${tab.hostName}::${tab.sessionName}`] ?? null });
              }}
            />
          );
        })}
        {pane.tabs.length === 0 && (
          <div style={{
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            fontSize: '11px',
            color: 'var(--color-muted)',
            fontFamily: 'var(--font-mono)',
            opacity: 0.5,
          }}>
            empty pane
          </div>
        )}
      </div>
      )}

      {colorPicker && (
        <ColorPickerMenu
          x={colorPicker.x} y={colorPicker.y} current={colorPicker.current}
          label={`Colour · ${colorPicker.session}`}
          onPick={c => setSessionColor(colorPicker.host, colorPicker.session, c)}
          onClose={() => setColorPicker(null)}
        />
      )}

      {/* Split controls + zoom + close pane */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        padding: '0 6px',
        borderLeft: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        {/* Find in pane */}
        <SplitButton
          title={`Find in pane (${modKey('F')})`}
          onClick={() => {
            const cid = pane.tabs[pane.activeTab]?.channelId;
            if (cid) useInputStore.getState().requestFind(cid);
          }}
          icon={<IconSearch size={13} strokeWidth={2} />}
        />
        {/* Zoom out */}
        <SplitButton
          title={`Zoom out (Cmd+−)  [${fontSize}px]`}
          onClick={decrease}
          icon={<span style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1 }}>A−</span>}
        />
        {/* Font size readout — click to reset */}
        <button
          title="Reset font size (Cmd+0)"
          onClick={reset}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--color-muted)', fontSize: '10px', fontFamily: 'var(--font-mono)',
            padding: '0 2px', lineHeight: 1, minWidth: '22px', textAlign: 'center',
          }}
        >{fontSize}</button>
        {/* Zoom in */}
        <SplitButton
          title={`Zoom in (Cmd+=)  [${fontSize}px]`}
          onClick={increase}
          icon={<span style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1 }}>A+</span>}
        />
        <div style={{ width: '1px', height: '14px', background: 'var(--color-border)', margin: '0 2px' }} />
        <button
          title={unified ? 'Unified scrollback ON — click to use classic terminal' : 'Classic terminal — click to try unified scrollback (prototype)'}
          onClick={toggleUnified}
          style={{
            background: unified ? 'rgba(99,102,241,0.18)' : 'transparent',
            border: '1px solid ' + (unified ? 'rgba(99,102,241,0.5)' : 'var(--color-border)'),
            color: unified ? 'var(--color-accent)' : 'var(--color-muted)',
            fontSize: '9px', fontFamily: 'var(--font-mono)', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
            padding: '0 6px', borderRadius: '3px', lineHeight: 1, height: '20px',
          }}
        >{unified ? 'UNI' : 'TTY'}</button>
        {/* Binary WS hot-path toggle (applies live, no reconnect) */}
        <button
          title={binaryWs ? 'Binary WS ON — channel output/input as raw frames (no base64/JSON). Click to use JSON.' : 'JSON WS (base64) — click for the binary hot-path (less bandwidth/CPU under load)'}
          onClick={() => { toggleBinaryWs(); client?.setBinary(!binaryWs); }}
          style={{
            background: binaryWs ? 'rgba(34,197,94,0.18)' : 'transparent',
            border: '1px solid ' + (binaryWs ? 'rgba(34,197,94,0.5)' : 'var(--color-border)'),
            color: binaryWs ? 'var(--color-success)' : 'var(--color-muted)',
            fontSize: '9px', fontFamily: 'var(--font-mono)', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
            padding: '0 6px', borderRadius: '3px', lineHeight: 1, height: '20px',
          }}
        >BIN</button>
        {/* Timestamp gutter toggle (per-pane) */}
        <button title={showTimestamps ? 'Hide timestamps' : 'Show timestamps in scrollback'}
          onClick={() => toggleTimestamps(paneId)} style={toggleBtnStyle(showTimestamps)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7.5v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* Minimap mode (per-pane): cycle off → overlay → docked → thin */}
        <button title={`Minimap: ${minimapMode} — click to cycle (off / overlay / docked). A thin scroll rail is always shown.`}
          onClick={() => cycleMinimap(paneId)} style={toggleBtnStyle(showMinimap)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            {/* the always-on rail */}
            <rect x="19" y="3" width="2" height="18" rx="1" fill="currentColor" opacity="0.6" />
            {/* the wide minimap (filled when docked) */}
            <rect x="11" y="3" width="6" height="18" rx="1" stroke="currentColor" strokeWidth="2"
              fill={minimapMode === 'docked' ? 'currentColor' : 'none'} />
            <path d="M4 6h4M4 10h4M4 14h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {/* Soft-wrap toggle (per-pane) — reflow the live tail to each client's
            width on shell sessions; auto-ignored while a full-screen TUI runs. */}
        <button title={softWrap ? 'Soft-wrap ON — live shell tail reflows to this client (TUIs keep the shared grid)' : 'Soft-wrap the live tail per client (shell sessions only)'}
          onClick={() => toggleSoftWrap(paneId)} style={toggleBtnStyle(softWrap)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0l2-2m-2 2l2 2M4 18h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* Scroll-rail toggle (per-pane). Off by default — it reserves a column of
            text width whether or not you look at it. */}
        <button title={showRail ? 'Scroll rail ON — click to hide it and give the column back to text' : 'Show the thin scroll rail (reserves a little width)'}
          onClick={() => toggleScrollRail(paneId)} style={toggleBtnStyle(showRail)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="16" y="3" width="4" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
            <rect x="16.5" y="7" width="3" height="7" rx="1.5" fill="currentColor" />
            <path d="M4 6h8M4 12h8M4 18h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {/* Sigil badge (per-pane): click cycles mark → labeled → off; shift-click
            moves corner; alt/option-click toggles the large backdrop watermark. */}
        <button title={`Session sigil: badge ${sigilBadge} (${sigilCorner})${sigilBackdrop ? ' · backdrop on' : ''}. Click cycles off / mark / labeled · Shift-click moves corner · Alt-click toggles the background watermark.`}
          onClick={e => { e.altKey ? toggleSigilBackdrop(paneId) : e.shiftKey ? cycleSigilCorner(paneId) : cycleSigilBadge(paneId); }}
          style={toggleBtnStyle(sigilBadge !== 'off' || sigilBackdrop)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            {/* a tiny constellation, echoing the badge */}
            <circle cx="6" cy="7" r="1.4" fill="currentColor" />
            <circle cx="16" cy="5" r="1.4" fill="currentColor" />
            <circle cx="12" cy="13" r="1.6" fill="currentColor" />
            <circle cx="18" cy="16" r="1.4" fill="currentColor" />
            <circle cx="8" cy="17" r="1.4" fill="currentColor" />
            <path d="M6 7l6 6l4-8M12 13l6 3M12 13l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
          </svg>
        </button>
        {!isMobile && (
          <>
            <div style={{ width: '1px', height: '14px', background: 'var(--color-border)', margin: '0 2px' }} />
            <SplitButton
              title="Split Right (Ctrl+\)"
              onClick={() => splitPane(paneId, 'row')}
              icon={<IconSplitRight />}
            />
            <SplitButton
              title="Split Down (Ctrl+Shift+\)"
              onClick={() => splitPane(paneId, 'column')}
              icon={<IconSplitDown />}
            />
            {panes.size > 1 && (
              <SplitButton
                title="Close Pane"
                onClick={() => closePane(paneId)}
                icon={<IconClose />}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Shared style for the small on/off toggle chips in the tab bar (UNI-style).
function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'rgba(99,102,241,0.18)' : 'transparent',
    border: '1px solid ' + (active ? 'rgba(99,102,241,0.5)' : 'var(--color-border)'),
    color: active ? 'var(--color-accent)' : 'var(--color-muted)',
    cursor: 'pointer', padding: '0 5px', borderRadius: '3px', height: '20px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

function SplitButton({ title, onClick, icon }: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--color-border)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: hovered ? 'var(--color-text)' : 'var(--color-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        borderRadius: '4px',
        transition: 'background 0.1s, color 0.1s',
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
}
