import React from 'react';

/**
 * The "N hidden" affordance shown under a host whose worker sessions are
 * filtered out of the tree.
 *
 * Deliberately understated — it sits where a session row would, in muted
 * italic, so it reads as a footnote rather than another session. Its job is to
 * make the filtering DISCOVERABLE: nothing silently disappears, and one click
 * brings everything back.
 */
export function HiddenSessionsRow({ count, revealed, onToggle }: {
  count: number;
  revealed: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  if (count <= 0 && !revealed) return null;
  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={revealed
        ? 'Hide machine-created worker sessions again'
        : 'These are single-shot worker sessions (e.g. Drydock hostsh-*/mctask-*). Click to show them.'}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '3px 12px 3px 28px',
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: '11px', fontFamily: 'var(--font-ui)', fontStyle: 'italic',
        color: hover ? 'var(--color-accent)' : 'var(--color-muted-dim)',
        letterSpacing: '0.01em',
      }}
    >
      {revealed ? '⌄ hide worker sessions' : `⋯ ${count} hidden`}
    </button>
  );
}
