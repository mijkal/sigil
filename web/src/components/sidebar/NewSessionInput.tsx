import React from 'react';

const inputSt: React.CSSProperties = {
  width: '100%', background: 'var(--color-bg)',
  border: '1px solid var(--color-accent)', borderRadius: '4px',
  color: 'var(--color-text)', padding: '4px 8px',
  fontSize: '12px', fontFamily: 'var(--font-mono)', outline: 'none',
  boxSizing: 'border-box',
};

export function NewSessionInput({ hostName, onSubmit, onCancel }: {
  hostName: string;
  onSubmit: (name: string, startDir: string, startCmd: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name,     setName]     = React.useState('');
  const [startDir, setStartDir] = React.useState('');
  const [startCmd, setStartCmd] = React.useState('');
  const [loading,  setLoading]  = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { ref.current?.focus(); }, []);

  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = name.trim();
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit(t, startDir.trim(), startCmd.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const keyHandler = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'Enter') { e.preventDefault(); void submit(); }
  };

  return (
    <form onSubmit={submit} style={{ padding: '3px 8px 6px 32px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <input
        ref={ref}
        style={{ ...inputSt, opacity: loading ? 0.6 : 1 }}
        value={name} onChange={e => setName(e.target.value)}
        onKeyDown={keyHandler}
        placeholder={`session name on ${hostName}…`}
        disabled={loading}
      />
      <input
        style={{ ...inputSt, opacity: loading ? 0.6 : 1 }}
        value={startDir} onChange={e => setStartDir(e.target.value)}
        onKeyDown={keyHandler}
        placeholder="start dir (optional)"
        disabled={loading}
      />
      <input
        style={{ ...inputSt, opacity: loading ? 0.6 : 1 }}
        value={startCmd} onChange={e => setStartCmd(e.target.value)}
        onKeyDown={keyHandler}
        placeholder="start command (optional)"
        disabled={loading}
      />
      <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          style={{
            padding: '3px 10px', fontSize: '11px', cursor: 'pointer',
            background: 'transparent', color: 'var(--color-muted)',
            border: '1px solid var(--color-border)', borderRadius: '3px',
          }}
        >cancel</button>
        <button
          type="submit"
          disabled={loading || !name.trim()}
          style={{
            padding: '3px 10px', fontSize: '11px', cursor: 'pointer',
            background: 'var(--color-accent, var(--color-accent))', color: '#fff',
            border: 'none', borderRadius: '3px',
            opacity: (loading || !name.trim()) ? 0.5 : 1,
          }}
        >{loading ? 'creating…' : 'create'}</button>
      </div>
      {error && (
        <div style={{ fontSize: '11px', color: 'var(--color-danger)', padding: '2px 0' }}>
          {error}
        </div>
      )}
    </form>
  );
}
