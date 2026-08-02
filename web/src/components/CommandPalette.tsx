import { MOD } from '../lib/platform';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useLayoutStore } from '../stores/layoutStore';
import { Modal } from '../ui/Modal';
import { isEphemeralSession } from '../lib/sessionVisibility';

interface CommandPaletteProps {
  onClose: () => void;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const addTile = useLayoutStore((s) => s.addTab);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = sessions.filter((s) => {
    let showEphemeral = false;
    try { showEphemeral = localStorage.getItem('sigil_show_ephemeral') === '1'; } catch { /* ignore */ }
    if (!showEphemeral && isEphemeralSession(s)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      s.host_name.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q)
    );
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const openSession = useCallback(
    (idx: number) => {
      const session = filtered[idx];
      if (session) {
        addTile(session.id, session.host_name, session.name);
        onClose();
      }
    },
    [filtered, addTile, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape / focus-trap are handled by the shared Modal; the palette only owns
    // list navigation.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openSession(selectedIndex);
    }
  };

  return (
    <Modal open onClose={onClose} placement="top" width={560} labelledBy="cmd-palette">
      <div>
        <div style={styles.inputWrapper}>
          <span style={styles.searchIcon}>{MOD}</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions..."
            style={styles.input}
          />
          <kbd style={styles.escHint}>ESC</kbd>
        </div>

        <div style={styles.list}>
          {filtered.length === 0 ? (
            <div style={styles.empty}>No sessions found</div>
          ) : (
            filtered.map((session, i) => (
              <div
                key={session.id}
                style={{
                  ...styles.item,
                  ...(i === selectedIndex ? styles.itemSelected : {}),
                }}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => openSession(i)}
              >
                <div style={styles.itemIcon}>
                  <span
                    style={{
                      ...styles.statusDot,
                      background:
                        session.status === 'active'
                          ? 'var(--color-success)'
                          : 'var(--color-muted)',
                    }}
                  />
                </div>
                <div style={styles.itemContent}>
                  <span style={styles.itemHost}>{session.host_name}</span>
                  <span style={styles.itemSep}>/</span>
                  <span style={styles.itemName}>{session.name}</span>
                </div>
                <div style={styles.itemMeta}>
                  {session.status}
                </div>
              </div>
            ))
          )}
        </div>

        {filtered.length > 0 && (
          <div style={styles.footer}>
            <span>{filtered.length} session{filtered.length !== 1 ? 's' : ''}</span>
            <span>↑↓ navigate · Enter open · Esc close</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  inputWrapper: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    borderBottom: '1px solid var(--color-border)',
    gap: '10px',
  },
  searchIcon: {
    color: 'var(--color-muted)',
    fontSize: '16px',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    padding: '16px 0',
    color: 'var(--color-text)',
    fontSize: '15px',
    fontFamily: 'var(--font-ui)',
  },
  escHint: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '11px',
    color: 'var(--color-muted)',
    fontFamily: 'var(--font-ui)',
    flexShrink: 0,
  },
  list: {
    maxHeight: '360px',
    overflowY: 'auto',
  },
  empty: {
    padding: '32px',
    textAlign: 'center',
    color: 'var(--color-muted)',
    fontSize: '14px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    cursor: 'pointer',
    gap: '12px',
    transition: 'background 0.1s',
  },
  itemSelected: {
    background: 'rgba(99, 102, 241, 0.12)',
  },
  itemIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  statusDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    display: 'block',
  },
  itemContent: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  itemHost: {
    color: 'var(--color-muted)',
    fontSize: '13px',
    flexShrink: 0,
  },
  itemSep: {
    color: 'var(--color-border)',
    fontSize: '13px',
  },
  itemName: {
    color: 'var(--color-text)',
    fontSize: '14px',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemMeta: {
    color: 'var(--color-muted)',
    fontSize: '11px',
    flexShrink: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    borderTop: '1px solid var(--color-border)',
    fontSize: '11px',
    color: 'var(--color-muted)',
  },
};
