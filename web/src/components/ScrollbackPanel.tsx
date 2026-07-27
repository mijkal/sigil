import { useEffect, useRef, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';

type ScrollMode = 'piped' | 'raw';

interface ScrollbackPanelProps {
  sessionId: string;
  onClose: () => void;
  captureScrollback: (sessionId: string) => Promise<string>;
  getPipedScrollback: (sessionId: string) => Promise<string>;
}

// ~400 KB of text is enough to fill the viewport many times over.
// We keep the tail so the most recent output is always visible.
const MAX_CHARS = 400_000;

const converter = new AnsiToHtml({
  fg: '#E2E8F0',
  bg: '#0A0A0C',
  newline: true,
  escapeXML: true,
  stream: false,
});

// Whitelist of SGR code numbers that ansi-to-html v0.7.x actually handles.
// Unrecognised codes are passed through as literal text by the library,
// appearing as visible "[49m[59m…" junk in the browser.
function sanitizeSGRParams(params: string): string | null {
  if (!params) return params; // empty → reset (code 0) — always valid
  const parts = params.split(';');
  const kept: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const n = parseInt(parts[i] || '0', 10);
    if (
      n === 0 ||
      (n >= 1 && n <= 9) ||     // bold, dim, italic, underline, blink, reverse, hidden, strike
      (n >= 22 && n <= 29) ||   // attribute-off codes
      (n >= 30 && n <= 37) || n === 39 ||   // standard fg + default
      (n >= 40 && n <= 47) || n === 49 ||   // standard bg + default
      (n >= 90 && n <= 97) ||               // bright fg
      (n >= 100 && n <= 107)                // bright bg
    ) {
      kept.push(parts[i]);
      i++;
    } else if ((n === 38 || n === 48) && i + 1 < parts.length) {
      const mode = parseInt(parts[i + 1], 10);
      if (mode === 5 && i + 2 < parts.length) {       // 38/48;5;n  (256-colour)
        kept.push(parts[i], parts[i + 1], parts[i + 2]);
        i += 3;
      } else if (mode === 2 && i + 4 < parts.length) { // 38/48;2;r;g;b  (truecolour)
        kept.push(parts[i], parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
        i += 5;
      } else {
        i++; // malformed — skip
      }
    } else {
      i++; // unsupported code — drop it
    }
  }
  return kept.length > 0 ? kept.join(';') : null; // null = drop the whole sequence
}

// Strip cursor-positioning codes and unknown SGR codes from pipe-pane output,
// keeping only the SGR colour/style sequences that ansi-to-html can render.
function stripNonSGR(text: string): string {
  return text
    // OSC sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences: keep only supported SGR, drop everything else
    .replace(/\x1b\[([^A-Za-z~]*)([A-Za-z~])/g, (_match, params, final) => {
      if (final !== 'm') return ''; // cursor movement, erase, mode switches → strip
      const sanitized = sanitizeSGRParams(params);
      if (sanitized === null) return '';
      return `\x1b[${sanitized}m`;
    })
    // Remaining 2-char ESC sequences (e.g. \x1b= \x1b> \x1bM)
    .replace(/\x1b[^[]/g, '')
    // Control chars except LF (10), CR (13), TAB (9)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function textToHtml(text: string, isRaw: boolean): { html: string; totalChars: number; truncated: boolean } {
  const clean = isRaw ? text : stripNonSGR(text);
  const totalChars = clean.length;
  const truncated = totalChars > MAX_CHARS;
  const slice = truncated ? clean.slice(-MAX_CHARS) : clean;
  return { html: converter.toHtml(slice), totalChars, truncated };
}

export function ScrollbackPanel({
  sessionId,
  onClose,
  captureScrollback,
  getPipedScrollback,
}: ScrollbackPanelProps) {
  const [mode, setMode] = useState<ScrollMode>('raw');
  const [html, setHtml] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoScroll = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml('');
    setTruncated(false);
    didAutoScroll.current = false;

    const fetch = mode === 'piped'
      ? getPipedScrollback(sessionId)
      : captureScrollback(sessionId);

    fetch
      .then(text => {
        if (cancelled) return;
        if (!text.trim()) {
          setHtml('');
          setTruncated(false);
        } else {
          const result = textToHtml(text, mode === 'raw');
          setHtml(result.html);
          setTruncated(result.truncated);
        }
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionId, mode, captureScrollback, getPipedScrollback]);

  // Scroll to bottom once content renders
  useEffect(() => {
    if (!loading && html && scrollRef.current && !didAutoScroll.current) {
      didAutoScroll.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [loading, html]);

  // Keyboard dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const hint = loading
    ? 'Loading…'
    : error
    ? '⚠ load failed'
    : !html
    ? (mode === 'raw' ? 'tmux capture-pane · Esc to return' : 'pipe-pane stream · Esc to return')
    : truncated
    ? `showing last ${(MAX_CHARS / 1000).toFixed(0)}KB · Esc to return`
    : (mode === 'raw' ? 'tmux capture-pane · up to 50k lines · Esc to return' : 'pipe-pane stream · Esc to return');

  return (
    <div style={styles.backdrop}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Scrollback</span>
        <span style={styles.hint}>{hint}</span>

        {/* PIPED / RAW toggle */}
        <div style={styles.toggle}>
          <button
            style={{ ...styles.toggleBtn, ...(mode === 'raw' ? styles.toggleActive : {}) }}
            onClick={() => setMode('raw')}
            title="History: tmux capture-pane — rendered terminal state, up to 50k lines"
          >
            HISTORY
          </button>
          <button
            style={{ ...styles.toggleBtn, ...(mode === 'piped' ? styles.toggleActive : {}) }}
            onClick={() => setMode('piped')}
            title="Stream: raw pipe-pane log — works best for non-TUI sessions"
          >
            STREAM
          </button>
        </div>

        <button style={styles.closeBtn} onClick={onClose} title="Close (Esc)">✕</button>
      </div>

      {/* Scrollable content */}
      <div ref={scrollRef} style={styles.scrollArea}>
        {loading && (
          <div style={styles.centred}>
            <span style={{ color: '#64748B', fontSize: 13 }}>Loading scrollback…</span>
          </div>
        )}
        {error && !loading && (
          <div style={styles.centred}>
            <span style={{ color: '#EF4444', fontSize: 13 }}>{error}</span>
          </div>
        )}
        {!loading && !error && html && (
          <pre
            style={styles.pre}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!loading && !error && !html && (
          <div style={styles.centred}>
            <span style={{ color: '#64748B', fontSize: 13 }}>
              {mode === 'raw'
                ? 'No scrollback history'
                : 'No pipe log yet — attach to a session to start capturing'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: '#0A0A0C',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px',
    background: '#111318',
    borderBottom: '1px solid #1E2330',
    flexShrink: 0,
  },
  title: {
    color: '#818CF8',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    flexShrink: 0,
  },
  hint: {
    color: '#64748B',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggle: {
    display: 'flex',
    border: '1px solid #2D3148',
    borderRadius: 4,
    overflow: 'hidden',
    flexShrink: 0,
  },
  toggleBtn: {
    background: 'none',
    border: 'none',
    borderRight: '1px solid #2D3148',
    color: '#475569',
    cursor: 'pointer',
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700,
    letterSpacing: '0.06em',
    padding: '3px 9px',
    lineHeight: 1.6,
  },
  toggleActive: {
    background: 'rgba(129,140,248,0.12)',
    color: '#818CF8',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#64748B',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
    lineHeight: 1,
    flexShrink: 0,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    background: '#0A0A0C',
    padding: '8px 0',
  },
  pre: {
    margin: 0,
    padding: '0 12px',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 1.4,
    color: '#E2E8F0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minHeight: '100%',
  },
  centred: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 200,
  },
};
