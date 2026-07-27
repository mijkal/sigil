import React, { useState, useEffect, useRef } from 'react';
import { useLayoutStore, paneMinimapMode, paneSigilBadge, paneSigilBackdrop } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import { ActivityDot } from './ActivityDot';
import { Sigil } from './Sigil';
import { useSessionColorStore, resolveSessionColor } from '../stores/sessionColorStore';
import { FolderIcon } from './icons';
import { PaneView } from './PaneView';
import { Sidebar } from './Sidebar';
import { SigilLogo } from './SigilLogo';
import { AboutMenu } from './AboutMenu';
import { IconFiles, IconPlus, IconMenu, IconSearch, IconSliders } from '../ui/Icons';
import { useInputStore } from '../stores/inputStore';
import type { LayoutMode } from '../hooks/useMobileLayout';
import { useKeyboardOpen } from '../hooks/useKeyboardOpen';

interface MobileLayoutProps {
  mode: LayoutMode; // 'phone' | 'tablet'
  onOpenSetup?: () => void;
  onOpenPreview?: () => void;
  onOpenSettings?: () => void;
}

// ─── Phone layout ─────────────────────────────────────────────────────────────
// Full-screen pane, bottom bar for navigation, sidebar as overlay drawer.

function PhoneLayout({ onOpenSetup, onOpenPreview, onOpenSettings }: { onOpenSetup?: () => void; onOpenPreview?: () => void; onOpenSettings?: () => void }) {
  const panes = useLayoutStore(s => s.panes);
  const focusedPane = useLayoutStore(s => s.focusedPane);
  const setFocusedPane = useLayoutStore(s => s.setFocusedPane);
  const activateTab = useLayoutStore(s => s.activateTab);
  const cycleTab = useLayoutStore(s => s.cycleTab);
  const sessions = useSessionStore(s => s.sessions);
  const sessionFor = (t: { hostName: string; sessionName: string }) =>
    sessions.find(s => s.host_name === t.hostName && s.name === t.sessionName);
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);
  const accentFor = (t: { hostName: string; sessionName: string }) =>
    resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, t.hostName, t.sessionName) ?? undefined;
  const toggleTimestamps = useLayoutStore(s => s.toggleTimestamps);
  const toggleMinimap = useLayoutStore(s => s.toggleMinimap);
  const toggleSoftWrap = useLayoutStore(s => s.toggleSoftWrap);
  const cycleSigilBadge = useLayoutStore(s => s.cycleSigilBadge);
  const toggleSigilBackdrop = useLayoutStore(s => s.toggleSigilBackdrop);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [viewOptsOpen, setViewOptsOpen] = useState(false);
  const kbOpen = useKeyboardOpen();

  const paneIds = React.useMemo(() => [...panes.keys()], [panes]);

  useEffect(() => {
    if (!focusedPane && paneIds.length > 0) setFocusedPane(paneIds[0]);
  }, [focusedPane, paneIds, setFocusedPane]);

  const activePaneId = focusedPane ?? paneIds[0] ?? null;
  const activePane = activePaneId ? panes.get(activePaneId) : null;
  const tabs = activePane?.tabs ?? [];
  const activeTab = activePane?.activeTab ?? 0;
  const current = tabs[activeTab];

  // Swipe between sessions: a mostly-horizontal drag over the terminal cycles
  // tabs. Threshold + horizontal-dominance guard so it doesn't fight the
  // terminal's own vertical scroll / text selection.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) { touch.current = null; return; }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s || !activePaneId || tabs.length < 2) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - s.t < 600) {
      cycleTab(activePaneId, dx < 0 ? 1 : -1); // swipe left → next session
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'var(--app-height, 100dvh)', width: '100dvw', overflow: 'hidden' }}>
      {/* Top bar — menu (nav sheet) · brand (About) · files */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: 'max(env(safe-area-inset-top), 4px) 6px 0', height: 'calc(46px + env(safe-area-inset-top))',
        flexShrink: 0, background: 'var(--color-panel)', borderBottom: '1px solid var(--color-border)',
      }}>
        <button onClick={() => setSheetOpen(true)} style={tapBtn} aria-label="Open menu — hosts, sessions, settings">
          <IconMenu size={22} />
        </button>
        {/* Logo + wordmark → About. Shown only when no session is open; once a
            session opens, the session header (below) owns this row and carries its
            own sigil, so the app logo would just be redundant. About stays reachable
            from the drawer. */}
        {!current && (
          <button onClick={() => setAboutOpen(true)} aria-label="About Sigil"
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}>
            <SigilLogo size={20} />
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--color-accent)' }}>SIGIL</span>
          </button>
        )}
        {/* Active session — this bar IS the session header now */}
        <span style={{
          flex: 1, minWidth: 0, marginLeft: 4, fontSize: 13, fontFamily: 'var(--font-mono)',
          display: 'flex', alignItems: 'center', gap: 6,
          color: 'var(--color-text)', overflow: 'hidden', whiteSpace: 'nowrap',
        }}>
          {current && <Sigil name={current.sessionName} color={accentFor(current)} size={16} />}
          {current && (() => { const s = sessionFor(current); return s ? <ActivityDot session={s} size={7} /> : null; })()}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {current ? current.sessionName : ''}
            {current && <span style={{ color: 'var(--color-muted)', fontSize: 11 }}>{' '}· {current.hostName}</span>}
          </span>
        </span>
        {current && (
          <button onClick={() => { const cid = current.channelId; if (cid) useInputStore.getState().requestFind(cid); }}
            style={tapBtn} aria-label="Find in session"><IconSearch size={20} /></button>
        )}
        {current && (
          <button onClick={() => setViewOptsOpen(o => !o)} style={tapBtn}
            aria-label="View options — timestamps, minimap, soft-wrap" aria-expanded={viewOptsOpen}>
            <IconSliders size={20} />
          </button>
        )}
        {onOpenPreview && (
          <button onClick={onOpenPreview} style={tapBtn} aria-label="Open files"><IconFiles size={20} /></button>
        )}
      </div>

      {/* View-options popover — per-pane scrollback toggles (the pane toolbar is
          hidden on phones). Tap-away scrim closes it. */}
      {viewOptsOpen && activePaneId && (
        <>
          <div onClick={() => setViewOptsOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: 'calc(46px + env(safe-area-inset-top))', right: 8, zIndex: 41,
            background: 'var(--color-panel)', border: '1px solid var(--color-border)',
            borderRadius: 10, padding: 6, minWidth: 200,
            boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
          }}>
            <ViewOptRow label="Timestamps" on={!!activePane?.showTimestamps}
              onClick={() => toggleTimestamps(activePaneId)} />
            <ViewOptRow label="Minimap" on={paneMinimapMode(activePane) !== 'off'}
              onClick={() => toggleMinimap(activePaneId)} />
            <ViewOptRow label="Soft-wrap" on={!!activePane?.softWrap}
              onClick={() => toggleSoftWrap(activePaneId)}
              hint="Shell tail reflows to this screen" />
            <ViewOptRow label="Sigil watermark" on={paneSigilBackdrop(activePane)}
              onClick={() => toggleSigilBackdrop(activePaneId)}
              hint="Faint session sigil behind the CLI" />
            <ViewOptRow label={`Sigil badge · ${paneSigilBadge(activePane)}`} on={paneSigilBadge(activePane) !== 'off'}
              onClick={() => cycleSigilBadge(activePaneId)}
              hint="Tap to cycle mark / labeled / off" />
          </div>
        </>
      )}

      {/* Terminal — swipeable */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {paneIds.length === 0 || tabs.length === 0 ? (
          <EmptyMobile onOpen={() => setSheetOpen(true)} />
        ) : (
          paneIds.map(id => (
            <div key={id} style={{
              position: 'absolute', inset: 0,
              visibility: id === activePaneId ? 'visible' : 'hidden',
              pointerEvents: id === activePaneId ? 'auto' : 'none',
              zIndex: id === activePaneId ? 1 : 0,
            }}>
              <PaneView paneId={id} />
            </div>
          ))
        )}
      </div>

      {/* Bottom session strip — thumb-reachable, one-tap switch, + opens picker.
          Hidden while the soft keyboard is open so the compose input sits right
          above the keyboard instead of behind this strip. */}
      {!kbOpen && (
      <div style={{
        display: 'flex', alignItems: 'stretch', flexShrink: 0,
        height: 'calc(48px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
        background: 'var(--color-panel)', borderTop: '1px solid var(--color-border)',
      }}>
        <div style={{ flex: 1, display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {tabs.map((tab, i) => {
            const active = i === activeTab;
            return (
              <button key={`${tab.sessionId}-${i}`} onClick={() => activePaneId && activateTab(activePaneId, i)}
                style={{
                  display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
                  minWidth: 76, maxWidth: 140, padding: '0 12px', flexShrink: 0,
                  background: active ? 'var(--color-bg)' : 'transparent',
                  border: 'none', borderTop: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                  cursor: 'pointer', textAlign: 'left',
                }}>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: active ? 600 : 400,
                  color: active ? 'var(--color-text)' : 'var(--color-muted)',
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}>
                  <Sigil name={tab.sessionName} color={accentFor(tab)} size={15} />
                  {(() => { const s = sessionFor(tab); return s ? <ActivityDot session={s} size={6} /> : null; })()}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.sessionName}</span>
                </span>
                <span style={{
                  fontSize: 9, color: 'var(--color-muted)', opacity: 0.7,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{tab.hostName}</span>
              </button>
            );
          })}
        </div>
        <button onClick={() => setSheetOpen(true)} aria-label="Open sessions"
          style={{ ...tapBtn, width: 52, borderLeft: '1px solid var(--color-border)', color: 'var(--color-accent)' }}>
          <IconPlus size={22} />
        </button>
      </div>
      )}

      {/* True left sidebar drawer — the Sidebar's own layout gives a fixed header
          (logo + SIGIL + close), a scrollable session tree, and an anchored footer. */}
      {sheetOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300 }}>
          <div
            onClick={() => setSheetOpen(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', animation: 'sigil-fade-in 0.2s ease' }}
          />
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            boxShadow: '2px 0 24px rgba(0,0,0,0.5)', animation: 'sigil-slide-in-left 0.22s ease',
          }}>
            <Sidebar onClose={() => setSheetOpen(false)} onOpenSetup={onOpenSetup} onOpenSettings={onOpenSettings} />
          </div>
        </div>
      )}

      {aboutOpen && <AboutMenu onClose={() => setAboutOpen(false)} />}
    </div>
  );
}


// ─── Tablet layout ────────────────────────────────────────────────────────────
// Collapsible sidebar + full-height single pane (no mosaic splits on tablet).

function TabletLayout({ onOpenSetup, onOpenPreview, onOpenSettings }: { onOpenSetup?: () => void; onOpenPreview?: () => void; onOpenSettings?: () => void }) {
  const panes = useLayoutStore(s => s.panes);
  const focusedPane = useLayoutStore(s => s.focusedPane);
  const setFocusedPane = useLayoutStore(s => s.setFocusedPane);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const paneIds = React.useMemo(() => [...panes.keys()], [panes]);

  useEffect(() => {
    if (!focusedPane && paneIds.length > 0) {
      setFocusedPane(paneIds[0]);
    }
  }, [focusedPane, paneIds, setFocusedPane]);

  const activePaneId = focusedPane ?? paneIds[0] ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: 'var(--app-height, 100dvh)', width: '100dvw', overflow: 'hidden' }}>
      {/* Collapsible sidebar */}
      {sidebarOpen && (
        <div style={{ width: '220px', flexShrink: 0, position: 'relative', zIndex: 10 }}>
          <Sidebar onClose={() => setSidebarOpen(false)} onOpenSetup={onOpenSetup} onOpenSettings={onOpenSettings} />
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top bar when sidebar is collapsed */}
        {!sidebarOpen && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '0 12px', height: '36px', flexShrink: 0,
            background: 'var(--color-panel)', borderBottom: '1px solid var(--color-border)',
          }}>
            <button onClick={() => setSidebarOpen(true)} style={btnStyle} aria-label="Open sidebar">
              ☰
            </button>
            <SigilLogo size={18} />
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.15em', color: 'var(--color-accent)' }}>
              SIGIL
            </span>
            <div style={{ flex: 1 }} />
            {onOpenPreview && (
              <button onClick={onOpenPreview} style={{ ...btnStyle, display: 'flex', alignItems: 'center' }} aria-label="Open files">
                <FolderIcon size={17} />
              </button>
            )}
          </div>
        )}

        {/* Pane area — single active pane */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {paneIds.length === 0 ? (
            <EmptyMobile onOpen={() => setSidebarOpen(true)} />
          ) : (
            paneIds.map(id => (
              <div
                key={id}
                style={{
                  position: 'absolute', inset: 0,
                  visibility: id === activePaneId ? 'visible' : 'hidden',
                  pointerEvents: id === activePaneId ? 'auto' : 'none',
                }}
              >
                <PaneView paneId={id} />
              </div>
            ))
          )}
        </div>

        {/* Pane switcher strip */}
        {paneIds.length > 1 && (
          <PaneSwitcher paneIds={paneIds} activePaneId={activePaneId} onSwitch={setFocusedPane} panes={panes} />
        )}
      </div>
    </div>
  );
}

// ─── Pane switcher strip (tablet) ────────────────────────────────────────────

function PaneSwitcher({
  paneIds, activePaneId, onSwitch, panes,
}: {
  paneIds: string[];
  activePaneId: string | null;
  onSwitch: (id: string) => void;
  panes: Map<string, import('../stores/layoutStore').PaneConfig>;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      height: '36px', flexShrink: 0,
      background: 'var(--color-panel)', borderTop: '1px solid var(--color-border)',
      overflowX: 'auto',
    }}>
      {paneIds.map((id, i) => {
        const pane = panes.get(id);
        const tab = pane?.tabs[pane.activeTab];
        const label = tab ? `${tab.hostName}/${tab.sessionName}` : `Pane ${i + 1}`;
        const active = id === activePaneId;
        return (
          <button
            key={id}
            onClick={() => onSwitch(id)}
            style={{
              background: active ? 'var(--color-bg)' : 'transparent',
              border: 'none', borderRight: '1px solid var(--color-border)',
              borderTop: active ? '2px solid var(--color-accent)' : '2px solid transparent',
              cursor: 'pointer', padding: '0 14px',
              fontSize: '11px', fontFamily: 'var(--font-mono)',
              color: active ? 'var(--color-text)' : 'var(--color-muted)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyMobile({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '16px', background: 'var(--color-bg)',
    }}>
      <SigilLogo size={48} />
      <div style={{ fontSize: '14px', color: 'var(--color-muted)', textAlign: 'center' }}>
        Tap the menu to open a session
      </div>
      <button
        onClick={onOpen}
        style={{
          background: 'var(--color-accent)', border: 'none', borderRadius: '6px',
          color: '#fff', cursor: 'pointer', padding: '10px 20px',
          fontSize: '14px', fontFamily: 'var(--font-ui)',
        }}
      >
        Open Sessions
      </button>
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function MobileLayout({ mode, onOpenSetup, onOpenPreview, onOpenSettings }: MobileLayoutProps) {
  if (mode === 'phone') return <PhoneLayout onOpenSetup={onOpenSetup} onOpenPreview={onOpenPreview} onOpenSettings={onOpenSettings} />;
  return <TabletLayout onOpenSetup={onOpenSetup} onOpenPreview={onOpenPreview} onOpenSettings={onOpenSettings} />;
}

const btnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--color-text)', fontSize: '18px', lineHeight: 1,
  padding: '4px', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// 44px minimum touch target (Apple HIG).
const tapBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--color-text)', flexShrink: 0,
  minWidth: 44, minHeight: 44,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// A single row in the mobile view-options popover: label (+ optional hint) on
// the left, an iOS-style on/off pill switch on the right.
function ViewOptRow({ label, on, onClick, hint }: { label: string; on: boolean; onClick: () => void; hint?: string }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
      background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
      padding: '9px 8px', borderRadius: 7,
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, color: 'var(--color-text)' }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--color-muted)', marginTop: 1 }}>{hint}</span>}
      </span>
      <span style={{
        width: 38, height: 22, borderRadius: 11, flexShrink: 0, position: 'relative',
        background: on ? 'var(--color-accent)' : 'var(--color-muted-dim)',
        transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </span>
    </button>
  );
}
