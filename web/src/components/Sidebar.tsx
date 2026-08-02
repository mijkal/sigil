import { modKey } from '../lib/platform';
import React from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useToastStore } from '../stores/toastStore';
import { SigilLogo } from './SigilLogo';
import { SessionGlyph } from './Sigil';
import { OsIcon } from './OsIcon';
import { BellIcon, GearIcon, ThemeIcon } from './icons';
import { ColorPickerMenu } from './ColorPickerMenu';
import { useSessionColorStore, resolveSessionColor } from '../stores/sessionColorStore';
import { AboutMenu } from './AboutMenu';
import { WorkspaceSelector } from './WorkspaceSelector';
import { useTheme } from '../hooks/useTheme';
import type { Host, HostInput, Session } from '../types';
import { groupHosts } from './sidebar/hostGrouping';
import type { GroupKey } from './sidebar/hostGrouping';
import { HostModal } from './sidebar/HostModal';
import { GroupSection } from './sidebar/GroupSection';
import { EmptyState } from './sidebar/EmptyState';
import { st } from './sidebar/styles';
import { HostRow } from './sidebar/HostRow';
import { SessionRow } from './sidebar/SessionRow';
import { NewSessionInput } from './sidebar/NewSessionInput';
import { WidgetDock } from './widgets/WidgetDock';
import { useWidgetStore } from '../stores/widgetStore';
import { isEphemeralSession } from '../lib/sessionVisibility';

export function Sidebar({ onClose, onOpenSetup, onOpenSettings }: { onClose?: () => void; onOpenSetup?: () => void; onOpenSettings?: () => void } = {}) {
  const hosts      = useSessionStore(s => s.hosts);
  const sessions   = useSessionStore(s => s.sessions);
  const setSessions = useSessionStore(s => s.setSessions);
  const setHosts   = useSessionStore(s => s.setHosts);
  const addTile    = useLayoutStore(s => s.addTab);
  const { connected, client, serverUrl } = useConnectionStore();

  const { theme, toggle: toggleTheme } = useTheme();
  const openPanel = useToastStore(s => s.openPanel);
  const unseen = useToastStore(s => s.unseen);
  const colorPicker = useSessionColorStore(s => s.picker);
  const closePicker = useSessionColorStore(s => s.closePicker);
  const setHostColor = useSessionColorStore(s => s.setHostColor);
  const setSessionColor = useSessionColorStore(s => s.setSessionColor);
  const hostColors = useSessionColorStore(s => s.hosts);
  const sessionColors = useSessionColorStore(s => s.sessions);
  const metricsByHost = useSessionStore(s => s.metricsByHost);
  const panes = useLayoutStore(s => s.panes);
  const [showAddHost, setShowAddHost]   = React.useState(false);
  const [aboutOpen, setAboutOpen]       = React.useState(false);
  const [editingHost, setEditingHost]   = React.useState<Host | null>(null);
  const [newSessionFor, setNewSessionFor] = React.useState<string | null>(null);
  const [showEphemeral, setShowEphemeral] = React.useState<boolean>(() => {
    try { return localStorage.getItem('sigil_show_ephemeral') === '1'; } catch { return false; }
  });
  const toggleEphemeral = () => setShowEphemeral(prev => {
    const next = !prev;
    try { localStorage.setItem('sigil_show_ephemeral', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<GroupKey>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('sigil_collapsed_groups') ?? '[]') as GroupKey[];
      return new Set(saved);
    } catch { return new Set(); }
  });

  const [pinnedNames, setPinnedNames] = React.useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('sigil_pinned_hosts') ?? '[]') as string[];
      return new Set(saved);
    } catch { return new Set(); }
  });

  // Collapsed = a thin rail (desktop only). Persisted per-device in localStorage,
  // like collapsedGroups / pinnedHosts — a rail width is a per-screen preference.
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem('sigil_sidebar_collapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(prev => {
    const next = !prev;
    try { localStorage.setItem('sigil_sidebar_collapsed', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  // Sessions currently open in some pane — highlighted in the rail.
  const openSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const p of panes.values()) for (const t of p.tabs) ids.add(t.sessionId);
    return ids;
  }, [panes]);

  const sessionsByHost = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      if (!showEphemeral && isEphemeralSession(s)) continue;
      if (!map.has(s.host_name)) map.set(s.host_name, []);
      map.get(s.host_name)!.push(s);
    }
    for (const [k, v] of map) {
      map.set(k, [...v].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
    }
    return map;
  }, [sessions, showEphemeral]);

  const grouped = React.useMemo(() => groupHosts(hosts), [hosts]);

  const togglePin = (name: string) => {
    setPinnedNames(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      localStorage.setItem('sigil_pinned_hosts', JSON.stringify([...next]));
      return next;
    });
  };

  const toggleGroup = (g: GroupKey) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      localStorage.setItem('sigil_collapsed_groups', JSON.stringify([...next]));
      return next;
    });
  };

  const handleCreateSession = async (hostName: string, name: string, startDir: string, startCmd: string) => {
    if (!client) throw new Error('not connected to sigild — reload the page');
    const session = await client.createSession(hostName, name, startDir, startCmd);
    setSessions([...sessions, session]);
    setNewSessionFor(null);
    addTile(session.id, session.host_name, session.name);
  };

  const handleDeleteSession = async (s: Session) => {
    if (!client) return;
    await client.deleteSession(s.id);
    setSessions(sessions.filter(x => x.id !== s.id));
  };

  const handleRenameSession = async (s: Session, newName: string) => {
    if (!client) return;
    await client.renameSession(s.id, newName);
    setSessions(sessions.map(x => x.id === s.id ? { ...x, name: newName, id: `${x.host_name}:${newName}` } : x));
  };

  const handleResurrectSession = async (s: Session) => {
    if (!client) return;
    const pushToast = useToastStore.getState().push;
    try {
      await client.resurrectSession(s.id);
      pushToast({
        type: 'success',
        title: `Resurrected ${s.name}`,
        message: s.start_dir ? `cwd: ${s.start_dir}` : 'started in default cwd',
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: `Resurrect failed: ${s.name}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSessionOpen = (s: Session, winIdx?: number, winName?: string) => {
    const { panes, focusedPane } = useLayoutStore.getState();
    if (focusedPane) {
      const pane = panes.get(focusedPane);
      if (pane && pane.tabs.length > 0) {
        const active = pane.tabs[pane.activeTab];
        // No-op if focused tile is already showing this session (and same window if specified)
        if (active.sessionId === s.id &&
            (winIdx === undefined || active.windowIndex === winIdx)) {
          onClose?.();
          return;
        }
      }
    }
    addTile(s.id, s.host_name, s.name, null, winIdx, winName);
    onClose?.(); // close drawer on mobile after opening session
  };

  const handleAddHost = async (input: HostInput) => {
    if (!client) throw new Error('Not connected');
    const host = await client.addHost(input);
    setHosts([...hosts, host]);
  };

  const handleEditHost = async (name: string, input: Omit<HostInput, 'name'>) => {
    if (!client) throw new Error('Not connected');
    const updated = await client.updateHost(name, input);
    setHosts(hosts.map(h => h.name === name ? { ...h, ...updated } : h));
  };

  const handleRemoveHost = async (name: string) => {
    if (!client || !confirm(`Remove "${name}" from Sigil?`)) return;
    await client.removeHost(name);
    setHosts(hosts.filter(h => h.name !== name));
    setSessions(sessions.filter(s => s.host_name !== name));
  };

  // ── Collapsed rail (desktop only; the mobile drawer fully closes instead) ──
  if (collapsed && !onClose) {
    const railBtn: React.CSSProperties = {
      background: 'none', border: 'none', cursor: 'pointer', display: 'flex',
      alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)',
      padding: 4, lineHeight: 1,
    };
    const railHosts = [...hosts].sort((a, b) => {
      const ap = pinnedNames.has(a.name) ? 0 : 1, bp = pinnedNames.has(b.name) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return (
      <div style={{ ...st.sidebar, width: 56, alignItems: 'center' }}>
        {/* Top: logo (expand) + connection dot */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '12px 0 9px', width: '100%', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
          <button title="Expand sidebar" aria-label="Expand sidebar" onClick={toggleCollapsed} style={{ ...railBtn, padding: 0 }}>
            <SigilLogo size={26} />
          </button>
          <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: connected ? 'var(--color-success)' : 'var(--color-muted-dim)',
            boxShadow: connected ? '0 0 6px var(--color-success)' : 'none' }}
            title={connected ? 'Connected' : 'Disconnected'} />
        </div>

        {/* Middle: per-host status + session sigil glyphs */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 0' }}>
          {railHosts.length === 0 && (
            <div style={{ color: 'var(--color-muted-dim)', fontSize: 16, opacity: 0.4, marginTop: 8 }} title="No hosts — expand to add one">⬡</div>
          )}
          {railHosts.map(host => {
            const hs = sessionsByHost.get(host.name) ?? [];
            return (
              <div key={host.name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '5px 0', width: '100%' }}>
                <div title={`${host.name} — ${host.status}`} style={{ position: 'relative', width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)' }}>
                  <OsIcon osPretty={metricsByHost[host.name]?.info.os_pretty} os={metricsByHost[host.name]?.info.os} size={15} />
                  <span style={{ position: 'absolute', right: 0, bottom: 1, width: 6, height: 6, borderRadius: '50%',
                    background: host.status === 'connected' ? 'var(--color-success)' : 'var(--color-muted-dim)',
                    outline: '1.5px solid var(--color-panel)' }} />
                </div>
                {hs.map(s => {
                  const accent = resolveSessionColor({ hosts: hostColors, sessions: sessionColors }, s.host_name, s.name);
                  const isOpen = openSessionIds.has(s.id);
                  return (
                    <button key={s.id} title={`${s.name} · ${host.name}`} onClick={() => handleSessionOpen(s)}
                      style={{ background: isOpen ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'none',
                        border: 'none', cursor: 'pointer', padding: 4, borderRadius: 8, display: 'flex',
                        outline: isOpen ? '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)' : '1px solid transparent' }}>
                      <SessionGlyph host={s.host_name} session={s.name} name={s.name} color={accent ?? undefined} size={20} activity={s.activity} active={s.status === "active"} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer: notifications / theme / settings / expand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '10px 0', width: '100%', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
          <button onClick={openPanel} title="Notification history" aria-label="Notification history"
            style={{ ...railBtn, position: 'relative', color: unseen > 0 ? 'var(--color-accent)' : 'var(--color-muted)', opacity: unseen > 0 ? 1 : 0.6 }}>
            <BellIcon />
            {unseen > 0 && <span style={{ position: 'absolute', top: 0, right: 0, width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)' }} />}
          </button>
          <button onClick={toggleTheme} title={`Theme: ${theme} — click to cycle`} aria-label={`Theme: ${theme}`} style={railBtn}>
            <ThemeIcon theme={theme} />
          </button>
          {onOpenSettings && (
            <button onClick={onOpenSettings} title="Settings — triggers & storage" aria-label="Settings" style={railBtn}>
              <GearIcon />
            </button>
          )}
          <button onClick={toggleCollapsed} title="Expand sidebar" aria-label="Expand sidebar" style={railBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        {aboutOpen && <AboutMenu onClose={() => setAboutOpen(false)} />}
      </div>
    );
  }

  return (
    <div style={st.sidebar}>
      {/* Header */}
      <div style={st.header}>
        <div
          style={{ ...st.logoRow, cursor: 'pointer' }}
          onClick={() => setAboutOpen(true)}
          title="About Sigil — version & build info"
        >
          <SigilLogo size={26} summonOnce />
          <span style={st.wordmark}>SIGIL</span>
        </div>
        {aboutOpen && <AboutMenu onClose={() => setAboutOpen(false)} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: connected ? 'var(--color-success)' : 'var(--color-muted-dim)',
            boxShadow: connected ? '0 0 6px var(--color-success)' : 'none',
            transition: 'all 0.3s', flexShrink: 0,
          }} title={connected ? 'Connected' : 'Disconnected'} />
          {!onClose && (
            <button
              onClick={toggleCollapsed}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', lineHeight: 1, padding: '2px', display: 'flex', alignItems: 'center' }}
              title="Collapse sidebar to a thin rail"
              aria-label="Collapse sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', fontSize: '16px', lineHeight: 1, padding: '2px' }}
              aria-label="Close sidebar"
            >✕</button>
          )}
        </div>
      </div>

      {/* Host tree */}
      <div style={st.tree}>
        {grouped.size === 0 && pinnedNames.size === 0 ? (
          <EmptyState
            connected={connected}
            serverUrl={serverUrl}
            onAddHost={() => setShowAddHost(true)}
            onEditConnection={onOpenSetup}
          />
        ) : (
          <>
            {/* Pinned hosts — always at top, before groups */}
            {pinnedNames.size > 0 && (() => {
              const pinned = hosts.filter(h => pinnedNames.has(h.name));
              if (pinned.length === 0) return null;
              return (
                <div style={{ marginBottom: '2px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    padding: '7px 10px 5px 10px', gap: '6px', userSelect: 'none',
                  }}>
                    <span style={{ fontSize: '10px', color: 'var(--color-warning)' }}>★</span>
                    <span style={{
                      flex: 1, fontSize: '10px', fontWeight: 700,
                      color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em',
                    }}>Pinned</span>
                  </div>
                  {pinned.map(host => {
                    const hostSessions = sessionsByHost.get(host.name) ?? [];
                    return (
                      <div key={host.name}>
                        <HostRow
                          host={host}
                          sessionCount={hostSessions.length}
                          pinned={true}
                          onPin={() => togglePin(host.name)}
                          onNewSession={() => setNewSessionFor(host.name)}
                          onEdit={() => setEditingHost(host)}
                          onRemove={() => handleRemoveHost(host.name)}
                        />
                        {newSessionFor === host.name && host.status === 'connected' && (
                          <NewSessionInput
                            hostName={host.name}
                            onSubmit={(name, startDir, startCmd) => handleCreateSession(host.name, name, startDir, startCmd)}
                            onCancel={() => setNewSessionFor(null)}
                          />
                        )}
                        {hostSessions.length === 0 ? (
                          <div style={{ padding: '3px 12px 3px 28px', fontSize: '11px', color: 'var(--color-muted-dim)', fontStyle: 'italic' }}>
                            {host.status === 'connected' ? 'no sessions' : 'not connected'}
                          </div>
                        ) : (
                          hostSessions.map(s => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              onOpen={(winIdx, winName) => handleSessionOpen(s, winIdx, winName)}
                              onOpenWindow={(winIdx, winName) => handleSessionOpen(s, winIdx, winName)}
                              onDelete={() => handleDeleteSession(s)}
                              onRename={newName => handleRenameSession(s, newName)}
                              onResurrect={() => handleResurrectSession(s)}
                            />
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Groups — pinned hosts are excluded to avoid duplication */}
            {[...grouped.entries()].map(([groupKey, groupHosts]) => {
              const unpinned = groupHosts.filter(h => !pinnedNames.has(h.name));
              if (unpinned.length === 0) return null;
              return (
                <GroupSection
                  key={groupKey}
                  groupKey={groupKey}
                  hosts={unpinned}
                  sessionsByHost={sessionsByHost}
                  collapsedGroups={collapsedGroups}
                  onToggle={toggleGroup}
                  newSessionFor={newSessionFor}
                  onNewSession={name => setNewSessionFor(name || null)}
                  onEditHost={host => setEditingHost(host)}
                  onRemoveHost={handleRemoveHost}
                  onSessionOpen={handleSessionOpen}
                  onCreateSession={handleCreateSession}
                  onDeleteSession={handleDeleteSession}
                  onRenameSession={handleRenameSession}
                  onResurrectSession={handleResurrectSession}
                  pinnedNames={pinnedNames}
                  onPin={togglePin}
                />
              );
            })}
          </>
        )}
      </div>

      {/* Widgets dock — glanceable monitors, above the footer */}
      <WidgetDock onManage={() => {
        useWidgetStore.getState().requestManage();
        onOpenSettings?.();
      }} />

      {/* Footer */}
      <div style={{ ...st.footer, flexDirection: 'column', gap: '7px', alignItems: 'stretch' }}>
        <WorkspaceSelector />
        <button
          onClick={toggleEphemeral}
          title={showEphemeral ? 'Hide Drydock and one-shot helper sessions' : 'Show Drydock and one-shot helper sessions'}
          aria-pressed={showEphemeral}
          style={{ ...st.addHostBtn, alignSelf: 'flex-start', opacity: showEphemeral ? 1 : 0.65 }}
        >{showEphemeral ? 'Hide helpers' : 'Show helpers'}</button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button style={{ ...st.addHostBtn, whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => setShowAddHost(true)}>+ Add Host</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <button
              onClick={openPanel}
              title="Notification history"
              aria-label="Notification history"
              style={{
                position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', padding: '2px 4px', lineHeight: 1,
                // Dim at rest; brighten to accent when there's something unseen.
                color: unseen > 0 ? 'var(--color-accent)' : 'var(--color-muted)',
                opacity: unseen > 0 ? 1 : 0.5,
              }}
            >
              <BellIcon />
              {unseen > 0 && (
                <span style={{
                  position: 'absolute', top: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px',
                  borderRadius: 7, background: 'var(--color-accent)', color: '#fff',
                  fontSize: 9, fontWeight: 700, lineHeight: '14px', textAlign: 'center',
                  fontVariantNumeric: 'tabular-nums',
                }}>{unseen > 99 ? '99+' : unseen}</span>
              )}
            </button>
            <button
              onClick={toggleTheme}
              title={`Theme: ${theme} — click to cycle`}
              aria-label={`Theme: ${theme}`}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center',
                color: 'var(--color-muted)', padding: '2px 4px', lineHeight: 1,
              }}
            >
              <ThemeIcon theme={theme} />
            </button>
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="Settings — triggers & storage"
                aria-label="Settings"
                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--color-muted)', padding: '2px 4px', lineHeight: 1 }}
              >
                <GearIcon />
              </button>
            )}
            <kbd style={st.kbd} title="Command palette">{modKey('K')}</kbd>
          </div>
        </div>
      </div>

      {colorPicker && (
        <ColorPickerMenu
          x={colorPicker.x} y={colorPicker.y} current={colorPicker.current}
          label={colorPicker.kind === 'host' ? `Host colour · ${colorPicker.host}` : `Colour · ${colorPicker.session}`}
          onPick={c => {
            if (colorPicker.kind === 'host') setHostColor(colorPicker.host, c);
            else setSessionColor(colorPicker.host, colorPicker.session!, c);
          }}
          onClose={closePicker}
        />
      )}

      {showAddHost && (
        <HostModal onClose={() => setShowAddHost(false)} onAdd={handleAddHost} />
      )}
      {editingHost && (
        <HostModal
          onClose={() => setEditingHost(null)}
          onEdit={handleEditHost}
          initialHost={editingHost}
        />
      )}
    </div>
  );
}
