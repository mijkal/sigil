import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { TileGrid } from './components/TileGrid';
import { PreviewPanel } from './components/PreviewPanel';
import { MobileLayout } from './components/MobileLayout';
import { CommandPalette } from './components/CommandPalette';
import { SetupModal } from './components/SetupModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { resolveServerUrl } from './lib/serverUrl';
import { useServerStore } from './stores/serverStore';
import { ToastContainer } from './components/ToastContainer';
import { TriggerEffectsLayer } from './components/TriggerEffectsLayer';
import { useTriggerStore } from './stores/triggerStore';
import { resolveTriggerEffect, type TriggerActionMessage } from './lib/triggerEffects';
import { playTone } from './lib/audio';
import { useConnectionStore } from './stores/connectionStore';
import { useSessionColorStore } from './stores/sessionColorStore';
import { useSessionStore } from './stores/sessionStore';
import { useLayoutStore } from './stores/layoutStore';
import { useToastStore } from './stores/toastStore';
import { useWorkspaceStore, setWorkspaceApiCreds, autoWorkspaceId } from './stores/workspaceStore';
import { useTerminalStore } from './stores/terminalStore';
import { useInputStore } from './stores/inputStore';
import { useTheme } from './hooks/useTheme';
import { useMobileLayout } from './hooks/useMobileLayout';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import type { Host, Session, HostMetrics } from './types';

// Render an event's data payload as a readable line rather than raw JSON in the
// notification body. A lone host/message field shows bare; otherwise "key value"
// pairs joined by · (e.g. "host-a" or "host the hub host · error timeout").
function fmtEventData(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  const entries = Object.entries(data).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return undefined;
  const fmt1 = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (entries.length === 1 && (entries[0][0] === 'host' || entries[0][0] === 'message')) {
    return fmt1(entries[0][1]).slice(0, 100);
  }
  return entries.map(([k, v]) => `${k} ${fmt1(v)}`).join(' · ').slice(0, 100);
}

export function App() {
  // Initialize theme from persisted preference on mount
  useTheme();

  // Keep the layout above the mobile soft keyboard (sets --app-height on <html>).
  useKeyboardInset();

  const layoutMode = useMobileLayout();

  const { init, client, token } = useConnectionStore();
  const { setHosts, setSessions, setHostMetrics, setAllMetrics } = useSessionStore();
  const [showPalette, setShowPalette] = useState(false);
  const [showSetup, setShowSetup] = useState(!token);
  const [showSettings, setShowSettings] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPush, setPreviewPush] = useState<{ hostName: string; path: string } | null>(null);
  const push = useToastStore(s => s.push);
  const record = useToastStore(s => s.record);
  const { setWorkspaces, loadWorkspace, saveWorkspace } = useWorkspaceStore();
  const { increase: fontIncrease, decrease: fontDecrease, reset: fontReset } = useTerminalStore();
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize client
  useEffect(() => {
    if (token) {
      // Resolve the server URL with a mixed-content guard: a stored http:// target
      // is unusable when the page is served over HTTPS (e.g. via a public reverse
      // proxy), so fall back to same-origin in that case.
      const serverUrl = resolveServerUrl();
      init(serverUrl, token);
      setWorkspaceApiCreds(serverUrl, token);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fall back to the setup screen when credentials are cleared (log out / remove
  // the last server) — the connection store sets token to '' on reset.
  useEffect(() => {
    if (!token) setShowSetup(true);
  }, [token]);

  // Subscribe to WS events
  useEffect(() => {
    if (!client) return;

    const unsubHosts = client.on('hosts.update', (payload) => {
      const p = payload as { hosts: Host[] };
      if (p.hosts) setHosts(p.hosts);
    });

    const unsubSessions = client.on('sessions.update', (payload) => {
      const p = payload as { sessions: Session[] };
      if (p.sessions) setSessions(p.sessions);
    });

    const unsubMetrics = client.on('metrics.update', (payload) => {
      const p = payload as { metrics?: HostMetrics };
      if (p.metrics) setHostMetrics(p.metrics);
    });

    // Toast on trigger events
    const unsubEvents = client.on('event.fired', (payload) => {
      const p = payload as { event?: { type: string; data?: Record<string, unknown> } };
      const ev = p.event ?? (payload as { type: string; data?: Record<string, unknown> });
      if (!ev?.type) return;
      // Host connectivity churn (`host.connected` fires on the initial connect AND
      // every auto-reconnect after a keepalive blip) is routine infra noise already
      // shown by the sidebar host dots — toasting it just spams false alarms. Log it
      // to the reviewable history WITHOUT popping a toast; genuine trigger/channel
      // events still toast below.
      if (ev.type.startsWith('host.')) {
        record({
          type: ev.type.includes('disconnect') || ev.type.includes('error') ? 'warning' : 'info',
          title: ev.type.replace(/[._]/g, ' '),
          message: fmtEventData(ev.data),
        });
        return;
      }
      const isError = ev.type.includes('error') || ev.type.includes('fail');
      const isSuccess = ev.type.includes('connect') || ev.type.includes('success');
      push({
        type: isError ? 'error' : isSuccess ? 'success' : 'info',
        title: ev.type.replace(/[._]/g, ' '),
        message: fmtEventData(ev.data),
        durationMs: 4000,
      });
    });

    // Workspace update from another client
    const unsubWorkspace = client.on('workspace.update', (payload) => {
      const ws = payload as { id: string; name: string; config: string; created_at: string; updated_at: string };
      if (!ws?.id) return;
      setWorkspaces(useWorkspaceStore.getState().workspaces.map(w => w.id === ws.id ? ws : w).concat(
        useWorkspaceStore.getState().workspaces.some(w => w.id === ws.id) ? [] : [ws]
      ));
      // If we're viewing this workspace and it was updated by someone else, offer to sync
      if (useWorkspaceStore.getState().activeId === ws.id) {
        push({
          type: 'info',
          title: `Workspace updated: ${ws.name}`,
          message: 'Another client saved this workspace',
          durationMs: 8000,
        });
      }
    });

    // Shared customization (colours / images / icons / adjustments) changed on
    // another client → re-fetch the full prefs (the broadcast payload is colours
    // only) and re-hydrate everything.
    const unsubPrefs = client.on('prefs.update', () => {
      client.getPrefs().then(p =>
        useSessionColorStore.getState().hydrate(p.hosts, p.sessions, p.all, p.images)
      ).catch(() => {});
    });

    // Preview push from agent
    const unsubPreview = client.on('preview.open', (payload) => {
      const p = payload as { host_name: string; path: string };
      if (p.host_name && p.path) {
        setPreviewPush({ hostName: p.host_name, path: p.path });
        setPreviewOpen(true);
      }
    });

    // Channel errors as toasts
    const unsubChannelError = client.on('channel.error', (payload) => {
      const p = payload as { error?: string };
      push({ type: 'error', title: 'Channel error', message: p.error, durationMs: 6000 });
    });

    // UI trigger effects (flash / tint / audio / toast) fired by the daemon's
    // trigger subsystem when a session's output matches a configured pattern.
    const unsubTrigger = client.on('trigger.action', (payload) => {
      const effect = resolveTriggerEffect(payload as TriggerActionMessage);
      if (!effect) return;
      const ts = useTriggerStore.getState();
      switch (effect.kind) {
        case 'flash': ts.triggerFlash(effect.color, effect.durationMs); break;
        case 'tint': ts.showTint(effect.color, effect.durationMs); break;
        case 'audio': playTone(effect.tone, effect.durationMs); break;
        case 'toast': push({ type: effect.level, title: effect.title, message: effect.message, durationMs: effect.durationMs }); break;
      }
    });

    // Fetch initial data
    client.getHosts().then(setHosts).catch(console.error);
    client.getSessions().then(setSessions).catch(console.error);
    client.getAllMetrics().then(setAllMetrics).catch(console.error);
    // Shared accent colours: hydrate from the server (localStorage was the cache).
    client.getPrefs().then(p =>
      useSessionColorStore.getState().hydrate(p.hosts, p.sessions, p.all, p.images)
    ).catch(console.error);

    // Load workspaces and restore active one.
    //
    // Each browser/profile owns a private "auto" workspace keyed by a
    // localStorage device UUID, so opening sigil-web on a second device (or
    // in an incognito tab) doesn't fight the first device's layout. Named
    // workspaces created via the WorkspaceSelector remain shareable across
    // devices in the normal way.
    client.getWorkspaces().then(async ws => {
      setWorkspaces(ws);
      const savedId = localStorage.getItem('sigil_active_workspace');
      const autoId = autoWorkspaceId();
      if (savedId && ws.some(w => w.id === savedId)) {
        // User explicitly switched to this workspace before — restore it.
        loadWorkspace(savedId);
      } else if (ws.some(w => w.id === autoId)) {
        // This device already has an auto-workspace; load it.
        loadWorkspace(autoId);
      } else {
        // First time on this browser/profile (or auto-ws was wiped). Create
        // the device-owned auto-workspace; saveWorkspace also sets it active
        // so the debounced auto-save below starts persisting immediately.
        try {
          await saveWorkspace(autoId, 'Auto (this device)');
        } catch { /* ignore — user can save manually */ }
      }
    }).catch(console.error);

    return () => {
      unsubHosts();
      unsubSessions();
      unsubMetrics();
      unsubEvents();
      unsubWorkspace();
      unsubPrefs();
      unsubPreview();
      unsubChannelError();
      unsubTrigger();
    };
  }, [client, setHosts, setSessions, setHostMetrics, setAllMetrics, push, setWorkspaces, loadWorkspace]);

  // Auto-save layout to active workspace (debounced 1.5s)
  useEffect(() => {
    return useLayoutStore.subscribe(() => {
        const { activeId: wId } = useWorkspaceStore.getState();
        if (!wId) return;
        const ws = useWorkspaceStore.getState().workspaces.find(w => w.id === wId);
        if (!ws) return;
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = setTimeout(() => {
          saveWorkspace(wId, ws.name).catch(console.error);
        }, 1500);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 'k') { e.preventDefault(); setShowPalette(v => !v); return; }
      if (mod && e.key === 'p') { e.preventDefault(); setPreviewOpen(v => !v); return; }
      // ⌘/Ctrl+F → open find-in-pane on the focused terminal.
      if (mod && e.key === 'f') {
        const cid = useInputStore.getState().focusedChannelId();
        if (cid) { e.preventDefault(); useInputStore.getState().requestFind(cid); return; }
      }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); fontIncrease(); return; }
      if (mod && e.key === '-') { e.preventDefault(); fontDecrease(); return; }
      if (mod && e.key === '0') { e.preventDefault(); fontReset(); return; }
      if (e.key === 'Escape') { setShowPalette(false); return; }

      const { focusedPane, panes, splitPane, closeTab, cycleTab } = useLayoutStore.getState();
      if (!focusedPane) return;
      const pane = panes.get(focusedPane);

      if (mod && !e.shiftKey && e.key === '\\') { e.preventDefault(); splitPane(focusedPane, 'row'); return; }
      if (mod && e.shiftKey && e.key === '\\') { e.preventDefault(); splitPane(focusedPane, 'column'); return; }
      if (mod && e.key === 'w') {
        e.preventDefault();
        if (pane && pane.tabs.length > 0) closeTab(focusedPane, pane.activeTab);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') { e.preventDefault(); if (pane) cycleTab(focusedPane, 1); return; }
      if (e.ctrlKey && e.shiftKey && e.key === 'Tab') { e.preventDefault(); if (pane) cycleTab(focusedPane, -1); return; }
      if (mod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (pane && idx < pane.tabs.length) { e.preventDefault(); useLayoutStore.getState().activateTab(focusedPane, idx); }
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handlePreviewPushConsumed = useCallback(() => setPreviewPush(null), []);
  const handlePreviewToggle = useCallback(() => setPreviewOpen(v => !v), []);

  const handleSetupSave = (serverUrl: string, newToken: string) => {
    // Record this server in the saved-instances list (and make it active) so it
    // shows up in Settings → Servers for quick switching later.
    useServerStore.getState().registerActive(serverUrl, newToken);
    init(serverUrl, newToken);
    setWorkspaceApiCreds(serverUrl, newToken);
    setShowSetup(false);
  };

  const openSetup = useCallback(() => setShowSetup(true), []);
  const openPreview = useCallback(() => setPreviewOpen(true), []);
  // Allow dismissing the setup modal only if we already have credentials (i.e. re-edit flow).
  const setupClose = token ? () => setShowSetup(false) : undefined;

  // Mobile layouts get their own structure; desktop uses the mosaic split layout
  if (layoutMode !== 'desktop') {
    return (
      <div style={styles.app}>
        {showSetup && <SetupModal onSave={handleSetupSave} onClose={setupClose} />}
        <MobileLayout mode={layoutMode} onOpenSetup={openSetup} onOpenPreview={openPreview} onOpenSettings={() => setShowSettings(true)} />
        {/* Files / media panel as a full-screen drawer on mobile */}
        {previewOpen && (
          <div style={styles.mobileDrawer}>
            <PreviewPanel
              open
              variant="overlay"
              onToggle={() => setPreviewOpen(false)}
              pushTarget={previewPush}
              onPushConsumed={handlePreviewPushConsumed}
            />
          </div>
        )}
        {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}
        <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
        <ToastContainer />
        <TriggerEffectsLayer />
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {showSetup && <SetupModal onSave={handleSetupSave} onClose={setupClose} />}
      <div style={styles.layout}>
        <Sidebar onOpenSetup={openSetup} onOpenSettings={() => setShowSettings(true)} />
        <TileGrid />
        <PreviewPanel
          open={previewOpen}
          onToggle={handlePreviewToggle}
          pushTarget={previewPush}
          onPushConsumed={handlePreviewPushConsumed}
        />
      </div>
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      <ToastContainer />
      <TriggerEffectsLayer />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Pinned to the top-left of the layout viewport (not just sized) so the mobile
  // soft keyboard can't scroll the whole app off-screen: when a bottom input is
  // focused inside these overflow:hidden containers, iOS otherwise scrolls the
  // window to reveal it, pushing everything up into black. Fixed + a height that
  // tracks the *visual* viewport (--app-height) keeps content in place and the
  // input riding just above the keyboard.
  app: { position: 'fixed', top: 0, left: 0, right: 0, height: 'var(--app-height, 100dvh)', width: '100vw', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', color: 'var(--color-text)' },
  layout: { flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' },
  mobileDrawer: {
    position: 'fixed', inset: 0, zIndex: 300,
    display: 'flex', flexDirection: 'column',
    background: 'var(--color-bg)',
  },
};
