import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { BrandMark } from './BrandMark';
import { useConnectionStore } from '../stores/connectionStore';

interface SetupModalProps {
  onSave: (serverUrl: string, token: string) => void;
  onClose?: () => void;
}

export function SetupModal({ onSave, onClose }: SetupModalProps) {
  const [serverUrl, setServerUrl] = useState(
    localStorage.getItem('sigil_server_url') || `${window.location.protocol}//${window.location.host}`
  );
  const [token, setToken] = useState(localStorage.getItem('sigil_token') || '');
  const authError = useConnectionStore((s) => s.authError);
  const connecting = useConnectionStore((s) => s.connecting);

  // Shown for a rejection from pressing Connect AND for one that happened at
  // start-up with a stored token — the latter is the case that stranded a phone
  // in an app that looked connected but had been refused.
  const showError = !connecting && !!authError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('sigil_server_url', serverUrl);
    localStorage.setItem('sigil_token', token);
    onSave(serverUrl, token);
  };

  return (
    <Modal open onClose={onClose ?? (() => {})} labelledBy="setup-title" width={380} placement="center">
      <div style={styles.body}>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={styles.closeBtn}
          >✕</button>
        )}
        <div style={styles.header}>
          {/* Pre-connect screen: the FIXED brand mark, not a generative session sigil. */}
          <div id="setup-title" style={styles.logo}><BrandMark size={24} />SIGIL</div>
          <p style={styles.subtitle}>Terminal Session Manager</p>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="setup-url">Hub URL</label>
            <input
              id="setup-url"
              type="url"
              inputMode="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://sigil-host.local:7777"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="setup-token">Auth Token</label>
            <input
              id="setup-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              style={{
                ...styles.input,
                ...(showError ? styles.inputError : null),
              }}
              // A token is an opaque secret: iOS otherwise capitalises the first
              // character and autocorrects it into something the hub refuses.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="current-password"
              aria-invalid={showError || undefined}
              aria-describedby={showError ? 'setup-error' : undefined}
            />
          </div>

          {showError && (
            <div id="setup-error" role="alert" style={styles.error}>
              <strong style={styles.errorTitle}>Token rejected</strong>
              <span style={styles.errorBody}>
                The hub refused this token ({authError}). Check it against{' '}
                <code style={styles.code}>tokens</code> in the hub's config.toml.
              </span>
            </div>
          )}

          <Button type="submit" variant="primary" style={{ width: '100%' }} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // ui/Modal's card carries NO padding of its own — every caller pads its own
  // content. SetupModal lost that when it moved onto the primitive: its old
  // `styles.modal` (padding 40px) was left behind as dead code and never applied,
  // so the form sat flush against the card edge. This is that padding, restored,
  // plus the notch/home-indicator insets a phone needs.
  body: {
    padding: '28px 24px 24px',
    paddingLeft: 'max(24px, env(safe-area-inset-left))',
    paddingRight: 'max(24px, env(safe-area-inset-right))',
    paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
  },
  closeBtn: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--color-muted)',
    fontSize: '16px',
    lineHeight: 1,
    // 44px is the minimum comfortable touch target on iOS.
    minWidth: '44px',
    minHeight: '44px',
  },
  header: {
    textAlign: 'center',
    marginBottom: '32px',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--color-accent)',
    letterSpacing: '0.15em',
    marginBottom: '8px',
  },
  subtitle: {
    color: 'var(--color-muted)',
    fontSize: '13px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--color-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  input: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    padding: '11px 12px',
    color: 'var(--color-text)',
    // MUST stay >= 16px. Below that, iOS Safari zooms the page in when the field
    // takes focus — the modal is then wider than the viewport, the layout lurches
    // under the keyboard, and typing feels like the app is fighting you.
    fontSize: '16px',
    fontFamily: 'var(--font-ui)',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  },
  inputError: {
    borderColor: 'var(--color-danger)',
  },
  error: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: '10px 12px',
    borderRadius: '6px',
    background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-danger) 45%, transparent)',
  },
  errorTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--color-danger)',
  },
  errorBody: {
    fontSize: '12px',
    lineHeight: 1.45,
    color: 'var(--color-muted)',
  },
  code: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
  },
};
