import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../../stores/connectionStore';
import { fmtTokens, shortModel, type WidgetConfig } from '../../stores/widgetStore';
import type { AgentUsage, UsageBucket } from '../../types';
import { Bar, Sparkline, Freshness } from './WidgetBits';

const work = (b: UsageBucket) => b.in + b.out;

function topModels(b: UsageBucket, n = 3): Array<[string, number]> {
  return Object.entries(b.models || {})
    .filter(([m, v]) => m && m !== '?' && v > 0)
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, n);
}

const PROVIDER_BY_KIND = {
  'claude-usage': 'claude',
  'codex-usage': 'codex',
  'agy-usage': 'agy',
} as const;

// `resets_at` arrives as epoch seconds (codex telemetry) or an ISO string
// (claude, resolved from the CLI's own reset sentence). Normalise before use.
function resetAtMs(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function resetLabel(data: AgentUsage): string | null {
  const q = data.quota;
  if (!q) return null;
  // A RESOLVED instant beats the raw sentence: it is rendered in the viewer's own
  // locale and, more importantly, it can say how long is left. The raw text was
  // preferred before, which is why the widget kept showing "resets Aug 3 at 12am"
  // hours after Aug 3 12am had passed.
  const ms = resetAtMs(q.resets_at);
  if (ms != null) {
    const when = new Date(ms).toLocaleString([], {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const mins = Math.round((ms - Date.now()) / 60000);
    if (mins <= 0) return `reset ${when}`;
    const left = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
    return `resets in ${left} · ${when}`;
  }
  if (q.reset_text) return `resets ${q.reset_text}`;
  return null;
}

// One composable provider-usage widget. The three built-ins are presets over the
// same data contract and renderer, not separate provider-specific components.
export function UsageWidget({ cfg }: { cfg: WidgetConfig }) {
  const client = useConnectionStore(s => s.client);
  const provider = cfg.kind === 'command' ? 'claude' : PROVIDER_BY_KIND[cfg.kind];
  const [data, setData] = useState<AgentUsage | null>(null);
  const [ts, setTs] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!client || !cfg.host) { setErr('no host'); return; }
      try {
        const u = await client.getAgentUsage(cfg.host, provider);
        if (!alive.current) return;
        setData(u); setTs(Date.now()); setStale(false); setErr(null);
      } catch (e) {
        if (!alive.current) return;
        setStale(true); setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) timer = setTimeout(tick, Math.max(20, cfg.intervalSec) * 1000);
      }
    };
    tick();
    return () => { alive.current = false; clearTimeout(timer); };
  }, [client, cfg.host, cfg.intervalSec, provider]);

  const b5 = data?.last5h;
  const today = data?.today;
  const wk = data?.week;
  // 5h bar: fraction of the soft target if set, else 5h vs today's total (recent
  // intensity) — a meaningful shape even without an absolute Max limit.
  const w5 = b5 ? work(b5) : 0;
  const frac = cfg.softTarget && cfg.softTarget > 0
    ? w5 / cfg.softTarget
    : (today && work(today) > 0 ? w5 / work(today) : 0);
  const overTarget = !!cfg.softTarget && w5 >= cfg.softTarget;
  const warningPct = cfg.warningPct ?? 80;
  const nearTarget = !!cfg.softTarget && frac * 100 >= warningPct;
  const quotaPct = typeof data?.quota?.used_percent === 'number' ? data.quota.used_percent : null;
  const reset = data ? resetLabel(data) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 2px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
          on <span style={{ color: 'var(--color-text)' }}>{cfg.host || '—'}</span>
        </span>
        <span style={{ flex: 1 }} />
        <Freshness ts={ts} stale={stale} />
      </div>

      {!data && !err && (
        <div style={{ fontSize: 11, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', padding: '6px 0' }}>loading…</div>
      )}
      {!data && err && (
        <div style={{ fontSize: 10.5, color: 'var(--color-warning)', fontFamily: 'var(--font-mono)', padding: '4px 0' }} title={err}>
          {err.slice(0, 60)}
        </div>
      )}

      {b5 && today && wk && (
        <>
          {quotaPct !== null && (
            <>
              <Bar label="quota" labelWidth="5ch" frac={quotaPct / 100} value={`${Math.round(quotaPct)}%`} danger={quotaPct >= 90} />
              <div style={{
                fontSize: 9.5, color: quotaPct >= 90 ? 'var(--color-warning)' : 'var(--color-muted)',
                fontFamily: 'var(--font-mono)',
                // Wrap rather than overflow: this line carries the reset time,
                // which is the whole point of showing an exhausted quota.
                whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35,
              }} title={reset ?? undefined}>
                {data.quota?.source === 'observed_error' ? 'limit observed' : 'provider reported'}{reset ? ` · ${reset}` : ''}
              </div>
            </>
          )}
          <Bar
            label="5h"
            labelWidth="5ch"
            frac={frac}
            value={fmtTokens(w5)}
            danger={overTarget}
          />
          <div style={{ display: 'flex', gap: 10, fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
            <span>5h <span style={{ color: 'var(--color-text)' }}>{b5.msgs}</span> msg{cfg.softTarget ? ` · ${Math.round(frac * 100)}% of ${fmtTokens(cfg.softTarget)}` : ''}</span>
          </div>
          {quotaPct === null && nearTarget && (
            <div style={{ fontSize: 9.5, color: 'var(--color-warning)', fontFamily: 'var(--font-mono)' }}>
              local warning · {Math.round(frac * 100)}% of soft budget
            </div>
          )}

          {!cfg.compact && (
            <>
              {/* today / week stat pair */}
              <div style={{ display: 'flex', gap: 8, marginTop: 1 }}>
                <Stat label="today" tokens={work(today)} msgs={today.msgs} />
                <Stat label="7-day" tokens={work(wk)} msgs={wk.msgs} />
              </div>

              {/* per-model (today) */}
              {cfg.showModels !== false && topModels(today).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
                  {(() => {
                    const tops = topModels(today);
                    const max = Math.max(1, ...tops.map(t => t[1]));
                    // One column wide enough for the LONGEST name in this group,
                    // so the rows stay aligned and none of them ellipsizes. A
                    // fixed 48px clipped "sonnet-5" and every codex/gemini name.
                    const w = `${Math.max(...tops.map(([m]) => shortModel(m).length))}ch`;
                    return tops.map(([m, v]) => (
                      <Bar key={m} label={shortModel(m)} labelWidth={w} frac={v / max} value={fmtTokens(v)} />
                    ));
                  })()}
                </div>
              )}

              {/* 24h burn shape */}
              {cfg.showSparkline !== false && data.hourly?.some(v => v > 0) && (
                <div style={{ marginTop: 3 }}>
                  <div style={{ fontSize: 9.5, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 1 }}>24h</div>
                  <Sparkline data={data.hourly} height={24} />
                </div>
              )}

              {/* cache is huge & meters differently — show it quietly for context */}
              {cfg.showCache !== false && (
                <div style={{ fontSize: 9.5, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                  cache today {fmtTokens(today.cache)} · scanned {data.files} files
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, tokens, msgs }: { label: string; tokens: number; msgs: number }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 9.5, color: 'var(--color-muted-dim)', fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(tokens)}</span>
      <span style={{ fontSize: 9.5, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>{msgs} msg</span>
    </div>
  );
}
