import { modKey } from '../lib/platform';
import { useCallback, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import type { DirEntry, DirListing, FileContent } from '../types';
import { useConnectionStore } from '../stores/connectionStore';
import { useSessionStore } from '../stores/sessionStore';
import { useInputStore } from '../stores/inputStore';
import { FolderIcon, FileIcon, FileCodeIcon, FileDataIcon, ScriptIcon, FileImageIcon } from './icons';
import { useMediaTrayStore } from '../stores/mediaTrayStore';

interface PreviewPanelProps {
  open: boolean;
  onToggle: () => void;
  pushTarget: { hostName: string; path: string } | null;
  onPushConsumed: () => void;
  // 'sidebar' (desktop, default) shows a 340px panel with a collapse sliver.
  // 'overlay' (mobile drawer) fills its container and has no sliver — the parent
  // controls visibility by mounting/unmounting.
  variant?: 'sidebar' | 'overlay';
}

marked.setOptions({ breaks: true });

const PANEL_WIDTH = 340;
const LS_KEY = 'sigil_preview_state';

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

function isMarkdown(path: string): boolean {
  return ['md', 'markdown', 'mdx'].includes(extOf(path));
}

function isImage(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(extOf(path));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function parentPath(path: string): string {
  const clean = path.replace(/\/$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return '/';
  return clean.slice(0, idx);
}

function loadSavedState(): { hostName: string; path: string } | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.hostName && parsed?.path) return parsed;
  } catch { /* ignore */ }
  return null;
}

function saveState(hostName: string, path: string) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ hostName, path })); } catch { /* ignore */ }
}

export function PreviewPanel({ open, onToggle, pushTarget, onPushConsumed, variant = 'sidebar' }: PreviewPanelProps) {
  const client = useConnectionStore(s => s.client);
  const hosts = useSessionStore(s => s.hosts);
  const trayAdd = useMediaTrayStore(s => s.add);

  const saved = useRef(loadSavedState());

  const [hostName, setHostName] = useState<string>(saved.current?.hostName ?? '');
  const [currentPath, setCurrentPath] = useState<string>(saved.current?.path ?? '~');
  const [inputPath, setInputPath] = useState<string>(saved.current?.path ?? '~');

  const [listing, setListing] = useState<DirListing | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null); // object URL for image preview
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Default host: use saved value, or first connected host
  useEffect(() => {
    if (!hostName && hosts.length > 0) {
      const connected = hosts.find(h => h.status === 'connected') ?? hosts[0];
      setHostName(connected.name);
    }
  }, [hosts, hostName]);

  // Handle external push (preview.open WS event)
  useEffect(() => {
    if (!pushTarget) return;
    setHostName(pushTarget.hostName);
    setCurrentPath(pushTarget.path);
    setInputPath(pushTarget.path);
    onPushConsumed();
  }, [pushTarget, onPushConsumed]);

  // Always try dir first; if server returns an error (not a directory), fall back to file.
  const load = useCallback(async (host: string, path: string) => {
    if (!client || !host) return;
    setLoading(true);
    setError(null);
    setListing(null);
    setFileContent(null);
    setImageUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    try {
      let resolvedPath = path;
      try {
        const dir = await client.browseDir(host, path || '~');
        setListing(dir);
        resolvedPath = dir.path;
        setCurrentPath(dir.path);
        setInputPath(dir.path);
      } catch {
        // Not a directory — it's a file.
        if (isImage(path)) {
          // Fetch raw bytes for an inline image preview (download endpoint).
          const blob = await client.downloadBlob(host, path, true);
          const url = URL.createObjectURL(blob);
          setImageUrl(url);
          setFileContent({ path, content: '', truncated: false });
        } else {
          const fc = await client.readFile(host, path);
          setFileContent(fc);
          resolvedPath = fc.path;
        }
        setCurrentPath(path);
        setInputPath(path);
      }
      saveState(host, resolvedPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Upload files into the current directory, then refresh the listing.
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    if (!client || !hostName || !files || (files as FileList).length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await client.uploadFiles(hostName, currentPath, files);
      const dir = await client.browseDir(hostName, currentPath);
      setListing(dir);
    } catch (e) {
      setError(`Upload failed: ${String(e)}`);
    } finally {
      setUploading(false);
    }
  }, [client, hostName, currentPath]);

  // Initial load when panel opens or host becomes available
  const didInitialLoad = useRef(false);
  useEffect(() => {
    if (open && hostName && client && !didInitialLoad.current) {
      didInitialLoad.current = true;
      load(hostName, currentPath);
    }
  }, [open, hostName, client, currentPath, load]);

  // When host changes (user picks different host), reload
  const prevHost = useRef(hostName);
  useEffect(() => {
    if (hostName && hostName !== prevHost.current) {
      prevHost.current = hostName;
      const newPath = '~';
      setCurrentPath(newPath);
      setInputPath(newPath);
      load(hostName, newPath);
    }
  }, [hostName, load]);

  // Navigate into a directory entry directly (no ambiguity needed)
  const navigateDir = (entry: DirEntry) => {
    const newPath = `${currentPath.replace(/\/$/, '')}/${entry.name}`;
    setInputPath(newPath);
    if (entry.is_dir) {
      client!.browseDir(hostName, newPath).then(dir => {
        setListing(dir);
        setFileContent(null);
        setCurrentPath(dir.path);
        setInputPath(dir.path);
        saveState(hostName, dir.path);
      }).catch(e => setError(String(e)));
    } else {
      load(hostName, newPath);
    }
  };

  const goUp = () => {
    const parent = parentPath(currentPath);
    setInputPath(parent);
    load(hostName, parent);
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    load(hostName, inputPath);
  };

  const refresh = () => load(hostName, currentPath);

  const copyContent = () => {
    if (!fileContent) return;
    const text = fileContent.content;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Download the real file bytes (not the 512 KB text preview) via the stream
  // endpoint, so binaries/large files download intact.
  const downloadContent = async () => {
    if (!fileContent || !client) return;
    try {
      const blob = await client.downloadBlob(hostName, fileContent.path);
      saveBlob(blob, fileContent.path.split('/').pop() ?? 'file');
    } catch (e) {
      setError(`Download failed: ${String(e)}`);
    }
  };

  const renderContent = (fc: FileContent) => {
    if (isImage(fc.path) && imageUrl) {
      return <img src={imageUrl} alt={fc.path} style={styles.imagePreview} />;
    }
    if (isMarkdown(fc.path)) {
      const html = marked(fc.content) as string;
      return (
        <div
          style={styles.mdBody}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    return (
      <pre style={styles.codePre}>
        <code>{fc.content}</code>
      </pre>
    );
  };

  // Sidebar variant collapses to a sliver; overlay (mobile drawer) is mounted
  // only while open, so it never shows the sliver.
  if (!open && variant === 'sidebar') {
    return (
      <div style={styles.sliver} onClick={onToggle} title={`Open file preview (${modKey('P')})`}>
        <span style={styles.sliverLabel}>◁</span>
      </div>
    );
  }

  const connectedHosts = hosts.filter(h => h.status === 'connected');

  return (
    <div style={{ ...styles.panel, ...(variant === 'overlay' ? { width: '100%', height: '100%' } : null) }}>
      {/* ── Header ── */}
      <div style={styles.header}>
        <span style={styles.title}>PREVIEW</span>
        <div style={{ flex: 1 }} />
        {fileContent && (
          <>
            <button
              style={styles.iconBtn}
              onClick={() => trayAdd({ hostName, path: fileContent.path, isDir: false })}
              title="Add this file to the media tray"
            >
              +
            </button>
            <button
              style={{ ...styles.iconBtn, color: copied ? 'var(--color-success)' : 'var(--color-muted)' }}
              onClick={copyContent}
              title="Copy file content"
            >
              {copied ? '✓' : '⎘'}
            </button>
            <button
              style={styles.iconBtn}
              onClick={downloadContent}
              title="Download file"
            >
              ↓
            </button>
            <button
              style={styles.iconBtn}
              onClick={goUp}
              title="Back to directory"
            >
              ‹
            </button>
          </>
        )}
        <button style={styles.iconBtn} onClick={refresh} title="Refresh">↺</button>
        <button style={styles.iconBtn} onClick={onToggle} title="Close preview">▷</button>
      </div>

      {/* ── Host selector (always shown so user can switch) ── */}
      <div style={styles.hostRow}>
        <select
          style={styles.hostSelect}
          value={hostName}
          onChange={e => setHostName(e.target.value)}
        >
          {connectedHosts.length === 0 && (
            <option value="">No hosts connected</option>
          )}
          {connectedHosts.map(h => (
            <option key={h.name} value={h.name}>{h.name}</option>
          ))}
        </select>
      </div>

      {/* ── Path bar ── */}
      <form style={styles.pathBar} onSubmit={handleInputSubmit}>
        {listing && currentPath !== '/' && (
          <button type="button" style={styles.upBtn} onClick={goUp} title="Parent directory">‹</button>
        )}
        <input
          ref={inputRef}
          style={styles.pathInput}
          value={inputPath}
          onChange={e => setInputPath(e.target.value)}
          spellCheck={false}
          placeholder="~/path/to/file.md"
        />
        <button type="submit" style={styles.goBtn}>→</button>
        {listing && (
          <button
            type="button"
            style={{ ...styles.goBtn, color: uploading ? 'var(--color-success)' : 'var(--color-accent)' }}
            title="Upload file(s) to this directory"
            onClick={() => uploadInputRef.current?.click()}
            disabled={uploading}
          >{uploading ? '…' : '⤒'}</button>
        )}
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }}
        />
      </form>

      {/* ── Body ── */}
      <div
        style={{ ...styles.body, ...(dragOver ? styles.bodyDrag : null) }}
        onDragOver={listing ? (e => { e.preventDefault(); setDragOver(true); }) : undefined}
        onDragLeave={listing ? (() => setDragOver(false)) : undefined}
        onDrop={listing ? (e => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
        }) : undefined}
      >
        {dragOver && (
          <div style={styles.dropHint}>Drop to upload to {currentPath}</div>
        )}
        {loading && (
          <div style={styles.centred}>
            <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>Loading…</span>
          </div>
        )}
        {error && !loading && (
          <div style={styles.centred}>
            <span style={{ color: 'var(--color-danger)', fontSize: 12, padding: '0 16px', textAlign: 'center' }}>{error}</span>
          </div>
        )}

        {/* Directory listing */}
        {!loading && !error && listing && (
          <div style={styles.fileList}>
            {listing.entries.length === 0 && (
              <div style={{ ...styles.centred, minHeight: 80 }}>
                <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>Empty directory</span>
              </div>
            )}
            {listing.entries.map(entry => {
              const fullPath = `${currentPath.replace(/\/$/, '')}/${entry.name}`;
              return (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  hostName={hostName}
                  fullPath={fullPath}
                  onClick={() => navigateDir(entry)}
                />
              );
            })}
          </div>
        )}

        {/* File content */}
        {!loading && !error && fileContent && (
          <div style={styles.contentWrap}>
            {fileContent.truncated && (
              <div style={styles.truncBanner}>Showing first 512 KB</div>
            )}
            {renderContent(fileContent)}
          </div>
        )}

        {!loading && !error && !listing && !fileContent && !hostName && (
          <div style={styles.centred}>
            <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>No host connected</span>
          </div>
        )}
      </div>

      {/* ── Media tray ── */}
      <TrayBar />
    </div>
  );
}

// Separate component so hover state is per-row without global CSS.
// Includes a tray toggle: ✓ adds the file/dir to the media tray; clicking the
// rest of the row still navigates/opens.
function FileRow({ entry, hostName, fullPath, onClick }: {
  entry: DirEntry;
  hostName: string;
  fullPath: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const inTray = useMediaTrayStore(s => s.items.some(i => i.hostName === hostName && i.path === fullPath));
  const toggle = useMediaTrayStore(s => s.toggle);

  return (
    <div
      style={{
        ...styles.fileEntry,
        background: hovered || inTray ? 'color-mix(in srgb, var(--color-accent) 6%, transparent)' : 'transparent',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        title={inTray ? 'Remove from tray' : 'Add to tray'}
        onClick={e => { e.stopPropagation(); toggle({ hostName, path: fullPath, isDir: entry.is_dir }); }}
        style={{
          ...styles.trayToggle,
          borderColor: inTray ? 'var(--color-accent)' : 'var(--color-muted-dim)',
          background: inTray ? 'var(--color-accent)' : 'transparent',
          color: inTray ? '#fff' : 'var(--color-muted)',
          opacity: hovered || inTray ? 1 : 0.45,
        }}
      >
        {inTray ? '✓' : '+'}
      </button>
      <span style={{ ...styles.fileIcon, color: entry.is_dir ? 'var(--color-accent)' : 'var(--color-muted)' }}>
        {entry.is_dir ? <FolderIcon size={15} /> : fileIcon(entry.name)}
      </span>
      <span style={{ ...styles.fileName, color: entry.is_dir ? 'var(--color-accent)' : 'var(--color-text)' }}>
        {entry.name}
      </span>
      {!entry.is_dir && (
        <span style={styles.fileSize}>{formatSize(entry.size)}</span>
      )}
    </div>
  );
}

// TrayBar — the gathered items and the actions on them: insert their paths
// (optionally @-prefixed) into the focused terminal input, copy, download, or
// transfer (move/copy within a host, or send host→host) via the Phase 6 backend.
function TrayBar() {
  const items = useMediaTrayStore(s => s.items);
  const remove = useMediaTrayStore(s => s.remove);
  const clear = useMediaTrayStore(s => s.clear);
  const insertIntoFocused = useInputStore(s => s.insertIntoFocused);
  const client = useConnectionStore(s => s.client);
  const hosts = useSessionStore(s => s.hosts);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (items.length === 0) return null;

  const paths = items.map(i => i.path);
  const files = items.filter(i => !i.isDir);
  const insertAt = () => insertIntoFocused(paths.map(p => `@${p}`).join(' '));
  const insertPlain = () => insertIntoFocused(paths.join(' '));
  const copyPaths = () => {
    const text = paths.join('\n');
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1400); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  };

  // Download each selected file (binary) to the browser.
  const downloadAll = async () => {
    if (!client) return;
    setBusy('download');
    try {
      for (const it of files) {
        const blob = await client.downloadBlob(it.hostName, it.path);
        saveBlob(blob, it.path.split('/').pop() ?? 'file');
      }
    } catch (e) { alert(`Download failed: ${String(e)}`); }
    finally { setBusy(null); }
  };

  // Send each selected file to a directory on another host (host→host relay).
  const sendToHost = async () => {
    if (!client || files.length === 0) return;
    const connected = hosts.filter(h => h.status === 'connected').map(h => h.name);
    const dstHost = window.prompt(`Send ${files.length} file(s) to which host?\nConnected: ${connected.join(', ')}`, connected[0] ?? '');
    if (!dstHost) return;
    const dstDir = window.prompt(`Destination directory on ${dstHost}:`, '~');
    if (!dstDir) return;
    setBusy('send');
    try {
      for (const it of files) {
        const name = it.path.split('/').pop() ?? 'file';
        const dstPath = `${dstDir.replace(/\/$/, '')}/${name}`;
        await client.transferFile(it.hostName, it.path, dstHost, dstPath);
      }
      alert(`Sent ${files.length} file(s) to ${dstHost}:${dstDir}`);
    } catch (e) { alert(`Transfer failed: ${String(e)}`); }
    finally { setBusy(null); }
  };

  return (
    <div style={styles.tray}>
      <div style={styles.trayHeader}>
        <button style={styles.trayCount} onClick={() => setExpanded(e => !e)} title="Show/hide items">
          🗂 {items.length} {items.length === 1 ? 'item' : 'items'} {expanded ? '▾' : '▸'}
        </button>
        <div style={{ flex: 1 }} />
        <button style={styles.trayClear} onClick={clear} title="Clear tray">clear</button>
      </div>
      {expanded && (
        <div style={styles.trayList}>
          {items.map(i => (
            <div key={`${i.hostName}::${i.path}`} style={styles.trayItem}>
              <span style={styles.trayItemPath} title={`${i.hostName}:${i.path}`}>
                {i.isDir && <span style={{ display: 'inline-flex', verticalAlign: '-2px', marginRight: 4, color: 'var(--color-accent)' }}><FolderIcon size={12} /></span>}{i.path}
              </span>
              <button style={styles.trayRemove} title="Remove" onClick={() => remove(i.hostName, i.path)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={styles.trayActions}>
        <button style={styles.trayAction} onClick={insertAt} title="Insert @paths into the focused terminal input (hand to Claude)">→ @paths</button>
        <button style={styles.trayActionAlt} onClick={insertPlain} title="Insert plain paths into the focused input">paths</button>
        <button style={styles.trayActionAlt} onClick={copyPaths} title="Copy paths to clipboard">{copied ? '✓ copied' : 'copy'}</button>
        {files.length > 0 && (
          <button style={styles.trayActionAlt} onClick={downloadAll} disabled={busy !== null} title="Download selected files">{busy === 'download' ? '…' : '↓'}</button>
        )}
        {files.length > 0 && (
          <button style={styles.trayActionAlt} onClick={sendToHost} disabled={busy !== null} title="Send selected files to another host">{busy === 'send' ? '…' : '⇄'}</button>
        )}
      </div>
    </div>
  );
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, { position: 'fixed', top: '-9999px', opacity: '0' });
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch { /* best effort */ }
  document.body.removeChild(ta);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Monochrome file-type glyph (project rule: icons over emoji). Grouped by role.
function fileIcon(name: string): React.ReactNode {
  const ext = extOf(name);
  const code = new Set(['ts', 'tsx', 'js', 'jsx', 'go', 'py', 'rs', 'java', 'c', 'cpp', 'h']);
  const data = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env']);
  const script = new Set(['sh', 'bash', 'zsh', 'fish']);
  const image = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
  if (code.has(ext)) return <FileCodeIcon size={15} />;
  if (data.has(ext)) return <FileDataIcon size={15} />;
  if (script.has(ext)) return <ScriptIcon size={15} />;
  if (image.has(ext)) return <FileImageIcon size={15} />;
  return <FileIcon size={15} />;
}

const styles: Record<string, React.CSSProperties> = {
  sliver: {
    width: 20,
    background: 'var(--color-bg)',
    borderLeft: '1px solid var(--color-border)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    userSelect: 'none',
  },
  sliverLabel: {
    color: 'var(--color-muted)',
    fontSize: 10,
    writingMode: 'vertical-rl',
    letterSpacing: '0.08em',
  },
  panel: {
    width: PANEL_WIDTH,
    flexShrink: 0,
    background: 'var(--color-bg)',
    borderLeft: '1px solid var(--color-border)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '6px 8px',
    background: 'var(--color-panel)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  title: {
    color: 'var(--color-accent)',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.08em',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-muted)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 5px',
    lineHeight: 1,
    borderRadius: 3,
  },
  hostRow: {
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  hostSelect: {
    width: '100%',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-muted)',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    padding: '3px 6px',
    borderRadius: 3,
  },
  pathBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 8px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  upBtn: {
    background: 'none',
    border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-muted)',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: '1px 6px',
    borderRadius: 3,
    flexShrink: 0,
  },
  pathInput: {
    flex: 1,
    background: 'var(--color-bg)',
    border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-text)',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    padding: '4px 7px',
    borderRadius: 3,
    outline: 'none',
    minWidth: 0,
  },
  goBtn: {
    background: 'var(--color-accent-dim)',
    border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-accent)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '3px 8px',
    borderRadius: 3,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    minHeight: 0,
    position: 'relative',
  },
  bodyDrag: {
    outline: '2px dashed var(--color-accent)',
    outlineOffset: '-6px',
    background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
  },
  dropHint: {
    position: 'absolute', top: 8, left: 8, right: 8, zIndex: 5,
    textAlign: 'center', padding: '6px',
    background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)', color: 'var(--color-accent)',
    fontSize: 12, fontFamily: "'JetBrains Mono', monospace", borderRadius: 4,
    pointerEvents: 'none',
  },
  imagePreview: {
    display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto', padding: 12,
  },
  centred: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 120,
  },
  fileList: {
    padding: '4px 0',
  },
  fileEntry: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '5px 12px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  fileIcon: {
    flexShrink: 0,
    width: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileName: {
    flex: 1,
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileSize: {
    color: 'var(--color-muted)',
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
    flexShrink: 0,
  },
  contentWrap: {
    padding: '0 0 20px 0',
  },
  truncBanner: {
    padding: '4px 12px',
    background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
    color: 'var(--color-warning)',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    borderBottom: '1px solid color-mix(in srgb, var(--color-warning) 20%, transparent)',
  },
  codePre: {
    margin: 0,
    padding: '12px',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--color-text)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  mdBody: {
    padding: '16px',
    color: 'var(--color-text)',
    fontSize: 13,
    lineHeight: 1.65,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  trayToggle: {
    flexShrink: 0,
    width: 18, height: 18,
    border: '1px solid var(--color-muted-dim)',
    borderRadius: 4,
    fontSize: 11, lineHeight: 1,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
  },
  tray: {
    flexShrink: 0,
    borderTop: '1px solid var(--color-muted-dim)',
    background: 'var(--color-panel)',
    display: 'flex', flexDirection: 'column',
    maxHeight: '45%',
  },
  trayHeader: {
    display: 'flex', alignItems: 'center',
    padding: '4px 8px',
  },
  trayCount: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-accent)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700, padding: '2px 0',
  },
  trayClear: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-muted)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
    padding: '2px 4px',
  },
  trayList: {
    overflowY: 'auto',
    borderTop: '1px solid var(--color-border)',
  },
  trayItem: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '3px 8px',
  },
  trayItemPath: {
    flex: 1, minWidth: 0,
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--color-muted)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  trayRemove: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-muted)', fontSize: 11, padding: '0 2px', flexShrink: 0,
  },
  trayActions: {
    display: 'flex', gap: 4, padding: '6px 8px',
    borderTop: '1px solid var(--color-border)',
  },
  trayAction: {
    flex: 1,
    background: 'var(--color-accent-dim)', border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-accent)', cursor: 'pointer',
    fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
    padding: '5px 6px', borderRadius: 4,
  },
  trayActionAlt: {
    background: 'none', border: '1px solid var(--color-muted-dim)',
    color: 'var(--color-muted)', cursor: 'pointer',
    fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
    padding: '5px 8px', borderRadius: 4,
  },
};
