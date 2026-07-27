import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { useInputStore } from '../stores/inputStore';
import { KeyAccessoryRow } from './KeyAccessoryRow';

// InputBar — an abstracted, always-bottom compose box that forwards into the
// tmux PTY via the existing channel.input path. Lives at the PaneView level so
// it is visible regardless of terminal scroll position (browse scrollback while
// the box stays put) and works with both the classic and unified terminals.
//
// Interaction model: "compose + commit-on-key".
//   • You type a (multi-line) message/command; Enter submits it, Shift+Enter
//     inserts a newline. Multi-line submits are wrapped in bracketed-paste so
//     interior newlines stay literal and a single trailing Enter executes.
//   • Interactive keys (Tab / ↑ / ↓ / slash / @, via the keyboard or the
//     accessory row) first *commit* the current draft to the PTY (no newline),
//     then send the key — so Claude Code / the shell can complete, recall
//     history, or open a slash-menu against what you actually typed. After such
//     a key the live pane owns the line; keep typing in the box and it appends
//     a fresh draft.
//
// What it cannot do: show completion *inside* the box. Completions are computed
// by the remote program, so they appear in the live terminal pane above — by
// design, the box commits then hands off.

const ENC = new TextEncoder();

interface Props {
  channelId?: string;
  accent?: string | null;  // active session's resolved colour (falls back to theme accent)
}

export function InputBar({ channelId, accent }: Props) {
  const client = useConnectionStore(s => s.client);
  const draft = useInputStore(s => (channelId ? s.drafts[channelId] ?? '' : ''));
  const setDraft = useInputStore(s => s.setDraft);
  const requestStick = useInputStore(s => s.requestStick);
  const focusNonce = useInputStore(s => (channelId ? s.focusNonce[channelId] ?? 0 : 0));

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [handedOff, setHandedOff] = useState(false); // last action committed to the live line
  const attached = !!channelId && !!client;

  const send = useCallback((str: string) => {
    if (!client || !channelId) return;
    client.sendInput(channelId, ENC.encode(str));
  }, [client, channelId]);

  // ── Auto-grow ───────────────────────────────────────────────────────────
  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    const next = Math.min(ta.scrollHeight, max);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }, []);
  useEffect(() => { autosize(); }, [draft, autosize]);

  // ── External focus request (e.g. media tray insert) ───────────────────────
  useEffect(() => {
    if (!focusNonce) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }, [focusNonce]);

  // ── Sending ────────────────────────────────────────────────────────────
  // Send the draft as a paste, optionally with a trailing Enter to submit.
  const flushDraft = useCallback((withEnter: boolean) => {
    if (!channelId) return;
    const text = draft;
    if (text) {
      const body = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
      send(withEnter ? `${body}\r` : body);
      setDraft(channelId, '');
    } else if (withEnter) {
      send('\r');
    }
  }, [channelId, draft, send, setDraft]);

  const submit = useCallback(() => {
    if (!channelId) return;
    flushDraft(true);
    requestStick(channelId);
    setHandedOff(false);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [channelId, flushDraft, requestStick]);

  // Commit the draft (no Enter), then forward a line-editing key.
  const forwardKey = useCallback((bytes: string) => {
    if (!channelId) return;
    flushDraft(false);
    send(bytes);
    requestStick(channelId);
    setHandedOff(true);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [channelId, flushDraft, send, requestStick]);

  // Send a control key verbatim; never dumps the draft.
  const rawKey = useCallback((bytes: string) => {
    send(bytes);
    if (channelId) requestStick(channelId);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [send, channelId, requestStick]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!attached) return;
    // Don't submit mid-IME-composition.
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      submit();
      return;
    }
    // Shift+Enter → newline (default textarea behaviour, no handling needed).
    if (e.key === 'Tab') {
      e.preventDefault();
      forwardKey('\t');
      return;
    }
    if (e.key === 'ArrowUp' && draft === '') { e.preventDefault(); forwardKey('\x1b[A'); return; }
    if (e.key === 'ArrowDown' && draft === '') { e.preventDefault(); forwardKey('\x1b[B'); return; }
    if (e.key === 'Escape') { rawKey('\x1b'); return; }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!channelId) return;
    setDraft(channelId, e.target.value);
    if (handedOff) setHandedOff(false);
  };

  return (
    <div style={styles.wrap}>
      <KeyAccessoryRow disabled={!attached} onForward={forwardKey} onRaw={rawKey} />
      <div style={styles.composeRow}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={!attached}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={1}
          placeholder={
            attached
              ? (handedOff ? 'sent to live line — keep typing to compose a new one' : 'Type a command or message — Enter to send, Shift+Enter for newline')
              : 'Not attached'
          }
          style={{
            ...styles.textarea,
            color: handedOff ? 'var(--color-muted)' : 'var(--color-text)',
          }}
        />
        <button
          type="button"
          title="Send (Enter)"
          disabled={!attached}
          onMouseDown={e => { e.preventDefault(); submit(); }}
          style={{
            ...styles.sendBtn, opacity: attached ? 1 : 0.4,
            background: accent ?? 'var(--color-accent)',
            borderColor: accent ?? 'var(--color-accent)',
          }}
        >
          ↵
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-panel)',
    borderTop: '1px solid var(--color-border)',
  },
  composeRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 6,
    padding: '6px 8px',
  },
  textarea: {
    flex: 1,
    resize: 'none',
    minHeight: 32,
    maxHeight: '40vh',
    padding: '7px 10px',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: 7,
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    lineHeight: 1.4,
    outline: 'none',
    minWidth: 0,
  },
  sendBtn: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: 8,
    border: '1px solid var(--color-accent)',
    background: 'var(--color-accent)',
    color: '#fff',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
  },
};
