import React, { useState, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useToastStore } from '../stores/toastStore';
import { uuid } from '../util/uuid';

export function WorkspaceSelector() {
  const { workspaces, activeId, saveWorkspace, loadWorkspace } = useWorkspaceStore();
  const client = useConnectionStore(s => s.client);
  const push = useToastStore(s => s.push);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on tap-out
  useEffect(() => {
    if (!open && !naming) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setNaming(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, naming]);

  const active = workspaces.find(w => w.id === activeId);

  const handleSave = async () => {
    if (!active) {
      setNaming(true);
      return;
    }
    setSaving(true);
    try {
      await saveWorkspace(active.id, active.name);
      push({ type: 'success', title: 'Workspace saved', message: active.name });
    } catch {
      push({ type: 'error', title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await saveWorkspace(uuid(), newName.trim());
      push({ type: 'success', title: 'Workspace created', message: newName.trim() });
      setNaming(false);
      setNewName('');
    } catch {
      push({ type: 'error', title: 'Create failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = (id: string) => {
    loadWorkspace(id);
    setOpen(false);
    push({ type: 'info', title: 'Workspace loaded', message: workspaces.find(w => w.id === id)?.name });
  };

  const handleDelete = async (id: string, name: string) => {
    if (!client) return;
    try {
      await client.deleteWorkspace(id);
      useWorkspaceStore.setState(s => ({
        workspaces: s.workspaces.filter(w => w.id !== id),
        activeId: s.activeId === id ? null : s.activeId,
      }));
      push({ type: 'info', title: 'Workspace deleted', message: name });
    } catch {
      push({ type: 'error', title: 'Delete failed' });
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Trigger row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
      }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            flex: 1, background: 'none',
            border: '1px solid var(--color-border)', borderRadius: '4px',
            color: 'var(--color-muted)', cursor: 'pointer',
            fontSize: '11px', padding: '4px 7px', fontFamily: 'var(--font-mono)',
            display: 'flex', alignItems: 'center', gap: '5px',
            textAlign: 'left', overflow: 'hidden',
          }}
          title="Switch workspace"
        >
          <span style={{ opacity: 0.5 }}>⬡</span>
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: active ? 'var(--color-text)' : 'var(--color-muted)',
          }}>
            {active ? active.name : 'workspace'}
          </span>
          <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: '9px' }}>▾</span>
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          title={active ? 'Save current layout' : 'Save as new workspace'}
          style={{
            background: 'none', border: '1px solid var(--color-border)',
            borderRadius: '4px', color: 'var(--color-accent)', cursor: 'pointer',
            fontSize: '11px', padding: '4px 6px', fontFamily: 'var(--font-ui)',
            opacity: saving ? 0.5 : 1,
          }}
        >
          {saving ? '…' : '↑'}
        </button>
      </div>

      {/* Name input for new workspace */}
      {naming && (
        <form onSubmit={handleCreate} style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
          background: 'var(--color-panel)', border: '1px solid var(--color-border)',
          borderRadius: '6px', padding: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 200,
        }}>
          <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Workspace name
          </div>
          <div style={{ display: 'flex', gap: '5px' }}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setNaming(false)}
              style={{
                flex: 1, background: 'var(--color-bg)', border: '1px solid var(--color-accent)',
                borderRadius: '3px', color: 'var(--color-text)', padding: '4px 7px',
                fontSize: '12px', fontFamily: 'var(--font-mono)', outline: 'none',
              }}
              placeholder="My workspace"
            />
            <button type="submit" style={{
              background: 'var(--color-accent)', border: 'none', borderRadius: '3px',
              color: '#fff', cursor: 'pointer', fontSize: '11px', padding: '4px 8px',
            }}>Save</button>
          </div>
        </form>
      )}

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
          background: 'var(--color-panel)', border: '1px solid var(--color-border)',
          borderRadius: '6px', overflow: 'hidden',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 200,
        }}>
          {workspaces.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--color-muted)', fontStyle: 'italic' }}>
              No saved workspaces
            </div>
          ) : (
            workspaces.map(ws => (
              <div
                key={ws.id}
                style={{
                  display: 'flex', alignItems: 'center', padding: '7px 10px', gap: '6px',
                  background: ws.id === activeId ? 'rgba(99,102,241,0.1)' : 'transparent',
                  borderLeft: ws.id === activeId ? '2px solid var(--color-accent)' : '2px solid transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => { if (ws.id !== activeId) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ws.id === activeId ? 'rgba(99,102,241,0.1)' : 'transparent'; }}
              >
                <span
                  style={{ flex: 1, fontSize: '12px', color: ws.id === activeId ? 'var(--color-text)' : 'var(--color-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onClick={() => handleLoad(ws.id)}
                >
                  {ws.name}
                </span>
                <button
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', fontSize: '13px', padding: '0 2px', opacity: 0.5 }}
                  onClick={e => { e.stopPropagation(); handleDelete(ws.id, ws.name); }}
                  title="Delete workspace"
                >✕</button>
              </div>
            ))
          )}
          <div
            style={{
              padding: '7px 10px', fontSize: '11px', color: 'var(--color-accent)',
              borderTop: '1px solid var(--color-border)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px',
            }}
            onClick={() => { setOpen(false); setNaming(true); }}
          >
            + New workspace
          </div>
        </div>
      )}
    </div>
  );
}
