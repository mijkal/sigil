import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { BrandMark } from './BrandMark';

interface SetupModalProps {
  onSave: (serverUrl: string, token: string) => void;
  onClose?: () => void;
}

export function SetupModal({ onSave, onClose }: SetupModalProps) {
  const [serverUrl, setServerUrl] = useState(
    localStorage.getItem('sigil_server_url') || `${window.location.protocol}//${window.location.host}`
  );
  const [token, setToken] = useState(localStorage.getItem('sigil_token') || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('sigil_server_url', serverUrl);
    localStorage.setItem('sigil_token', token);
    onSave(serverUrl, token);
  };

  return (
    <Modal open onClose={onClose ?? (() => {})} labelledBy="setup-title" width={380} placement="center">
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
            <label style={styles.label}>Hub URL</label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://sigil-host.local:7777"
              style={styles.input}
              autoFocus
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Auth Token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              style={styles.input}
            />
          </div>

          <Button type="submit" variant="primary" style={{ width: '100%' }}>Connect</Button>
        </form>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10, 10, 12, 0.92)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(8px)',
  },
  modal: {
    position: 'relative',
    background: 'var(--color-panel)',
    border: '1px solid var(--color-border)',
    borderRadius: '12px',
    padding: '40px',
    width: '400px',
    maxWidth: '92vw',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  closeBtn: {
    position: 'absolute',
    top: '10px',
    right: '12px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--color-muted)',
    fontSize: '16px',
    lineHeight: 1,
    padding: '6px 8px',
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
    padding: '10px 12px',
    color: 'var(--color-text)',
    fontSize: '14px',
    fontFamily: 'var(--font-ui)',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  button: {
    background: 'var(--color-accent)',
    border: 'none',
    borderRadius: '6px',
    padding: '12px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    marginTop: '8px',
    transition: 'opacity 0.15s',
  },
};
