import type { CSSProperties } from 'react';

export const st: Record<string, CSSProperties> = {
  sidebar: {
    width: '240px', flexShrink: 0,
    background: 'var(--color-panel)',
    borderRight: '1px solid var(--color-border)',
    display: 'flex', flexDirection: 'column',
    height: '100dvh', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 14px', borderBottom: '1px solid var(--color-border)', flexShrink: 0,
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: '9px' },
  wordmark: {
    fontSize: '13px', fontWeight: 800, letterSpacing: '0.18em',
    color: 'var(--color-accent)', fontFamily: 'var(--font-ui)',
  },
  tree: { flex: 1, overflowY: 'auto', padding: '6px 0' },
  empty: { padding: '24px 16px', color: 'var(--color-muted)', fontSize: '13px', textAlign: 'center' },
  footer: {
    padding: '9px 12px', borderTop: '1px solid var(--color-border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
  },
  addHostBtn: {
    background: 'none', border: '1px solid var(--color-border)',
    borderRadius: '4px', color: 'var(--color-accent)', cursor: 'pointer',
    fontSize: '11px', padding: '4px 9px', fontFamily: 'var(--font-ui)',
    letterSpacing: '0.02em',
  },
  kbd: {
    background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: '3px', padding: '1px 5px',
    fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-ui)',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-muted)', fontSize: '14px', fontWeight: 700,
    padding: '0 2px', lineHeight: '1', flexShrink: 0,
  },
};

export const emptySt: Record<string, CSSProperties> = {
  wrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: '12px', padding: '40px 20px 20px', textAlign: 'center',
  },
  title: {
    fontSize: '13px', fontWeight: 600, color: 'var(--color-text)',
    letterSpacing: '0.02em',
  },
  body: {
    fontSize: '12px', color: 'var(--color-muted)', lineHeight: 1.5,
    maxWidth: '200px',
  },
  hint: {
    fontSize: '11px', color: 'var(--color-muted)', lineHeight: 1.5,
    maxWidth: '210px', opacity: 0.8,
  },
  code: {
    fontFamily: 'var(--font-mono)', fontSize: '11px',
    color: 'var(--color-text)',
    background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: '3px', padding: '1px 5px',
  },
  codeInline: {
    fontFamily: 'var(--font-mono)', fontSize: '10px',
    color: 'var(--color-text)',
    background: 'var(--color-bg)', padding: '0 3px', borderRadius: '2px',
  },
  cta: {
    marginTop: '4px',
    background: 'var(--color-accent)', border: 'none', borderRadius: '5px',
    color: '#fff', cursor: 'pointer', padding: '7px 16px',
    fontSize: '12px', fontFamily: 'var(--font-ui)', fontWeight: 600,
    letterSpacing: '0.02em',
  },
};

export const modalSt: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--color-panel)', border: '1px solid var(--color-border)',
    borderRadius: '8px', width: '400px', maxWidth: '92vw',
    boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '15px 18px', borderBottom: '1px solid var(--color-border)',
  },
  title: { fontSize: '14px', fontWeight: 600, color: 'var(--color-text)' },
  closeBtn: { background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: '15px' },
  form: { padding: '18px' },
  label: { fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: {
    width: '100%', background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderRadius: '4px', color: 'var(--color-text)', padding: '7px 9px',
    fontSize: '13px', fontFamily: 'var(--font-ui)', outline: 'none', boxSizing: 'border-box',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0', cursor: 'pointer' },
  error: {
    background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '4px', color: 'var(--color-danger)', fontSize: '12px', padding: '7px 10px', marginBottom: '10px',
  },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' },
  cancelBtn: {
    background: 'none', border: '1px solid var(--color-border)', borderRadius: '4px',
    color: 'var(--color-muted)', cursor: 'pointer', padding: '6px 14px',
    fontSize: '13px', fontFamily: 'var(--font-ui)',
  },
  submitBtn: {
    background: 'var(--color-accent)', border: 'none', borderRadius: '4px',
    color: '#fff', cursor: 'pointer', padding: '6px 14px',
    fontSize: '13px', fontFamily: 'var(--font-ui)', fontWeight: 600,
  },
};
