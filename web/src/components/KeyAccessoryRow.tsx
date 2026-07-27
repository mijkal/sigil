import React from 'react';

// KeyAccessoryRow — a horizontally-scrollable strip of terminal keys that the
// abstracted compose box can't represent on its own. This is what makes Tab,
// arrows, Ctrl-C, reverse-search, slash-menus etc. usable from the input bar,
// especially on mobile where there is no physical Tab/Ctrl.
//
// Two kinds of key:
//   forward — line-editing keys (Tab, ↑/↓ history, /, @) that should first
//             commit any composed draft to the PTY, then send the key, so the
//             remote program (Claude Code, the shell) acts on what you typed.
//   raw     — control keys (Esc, Ctrl-C/R/L/D, ←/→) sent verbatim, never
//             dumping the draft into the session.

export interface AccessoryKey {
  label: string;
  bytes: string;
  kind: 'forward' | 'raw';
  title?: string;
}

const KEYS: AccessoryKey[] = [
  { label: 'Tab', bytes: '\t', kind: 'forward', title: 'Tab — complete (commits draft first)' },
  { label: 'Esc', bytes: '\x1b', kind: 'raw', title: 'Escape' },
  { label: '↑', bytes: '\x1b[A', kind: 'forward', title: 'Up — history' },
  { label: '↓', bytes: '\x1b[B', kind: 'forward', title: 'Down — history' },
  { label: '←', bytes: '\x1b[D', kind: 'raw', title: 'Left' },
  { label: '→', bytes: '\x1b[C', kind: 'raw', title: 'Right' },
  { label: '/', bytes: '/', kind: 'forward', title: 'Slash menu' },
  { label: '@', bytes: '@', kind: 'forward', title: 'File mention' },
  { label: '^C', bytes: '\x03', kind: 'raw', title: 'Ctrl-C — interrupt' },
  { label: '^R', bytes: '\x12', kind: 'raw', title: 'Ctrl-R — reverse search' },
  { label: '^L', bytes: '\x0c', kind: 'raw', title: 'Ctrl-L — clear' },
  { label: '^D', bytes: '\x04', kind: 'raw', title: 'Ctrl-D — EOF' },
];

interface Props {
  disabled?: boolean;
  onForward: (bytes: string) => void;
  onRaw: (bytes: string) => void;
}

export function KeyAccessoryRow({ disabled, onForward, onRaw }: Props) {
  return (
    <div style={styles.row}>
      {KEYS.map(k => (
        <button
          key={k.label}
          type="button"
          title={k.title}
          disabled={disabled}
          // onMouseDown (not onClick) so the textarea doesn't lose focus first.
          onMouseDown={e => {
            e.preventDefault();
            if (disabled) return;
            if (k.kind === 'forward') onForward(k.bytes);
            else onRaw(k.bytes);
          }}
          style={{
            ...styles.key,
            opacity: disabled ? 0.4 : 1,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    background: 'var(--color-panel)',
    borderTop: '1px solid var(--color-border)',
    WebkitOverflowScrolling: 'touch',
  },
  key: {
    flexShrink: 0,
    minWidth: 30,
    height: 26,
    padding: '0 8px',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: 5,
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1,
    userSelect: 'none',
  },
};
