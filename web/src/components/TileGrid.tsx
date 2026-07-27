import { modKey } from '../lib/platform';
import { Mosaic, MosaicWindow } from 'react-mosaic-component';
import type { MosaicNode } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import { useLayoutStore } from '../stores/layoutStore';
import { useSigilAnimStore } from '../stores/sigilAnimStore';
import { PaneView } from './PaneView';
import { SigilLogoBig } from './SigilLogo';

export function TileGrid() {
  const panes = useLayoutStore(s => s.panes);
  const mosaicLayout = useLayoutStore(s => s.mosaicLayout);
  const setMosaicLayout = useLayoutStore(s => s.setMosaicLayout);
  const createEmptyPane = useLayoutStore(s => s.createEmptyPane);

  if (panes.size === 0) {
    return <EmptyState />;
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', height: '100%' }}>
      <Mosaic<string>
        renderTile={(id, path) => (
          <MosaicWindow<string>
            path={path}
            title=""
            createNode={() => createEmptyPane()}
            toolbarControls={[]}
          >
            <PaneView paneId={id} />
          </MosaicWindow>
        )}
        value={mosaicLayout}
        onChange={(layout: MosaicNode<string> | null) => setMosaicLayout(layout)}
        onRelease={(layout: MosaicNode<string> | null) => setMosaicLayout(layout)}
        className="sigil-mosaic"
      />
    </div>
  );
}

function EmptyState() {
  const ambient = useSigilAnimStore(s => s.ambient);
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      background: 'var(--color-bg)',
    }}>
      <div style={{
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '14px',
      }}>
        <span style={{ display: 'inline-flex', animation: ambient ? 'sigil-breathe 6s ease-in-out infinite' : undefined }}>
          <SigilLogoBig size={56} />
        </span>
        <div style={{
          fontSize: '18px',
          fontWeight: 700,
          color: 'var(--color-accent)',
          letterSpacing: '0.25em',
          opacity: 0.65,
          fontFamily: 'var(--font-ui)',
        }}>
          SIGIL
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-muted)', letterSpacing: '0.04em' }}>
          Terminal Session Manager
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-muted)', opacity: 0.6, marginTop: '8px' }}>
          Click a session in the sidebar to open it
        </div>
        <div style={{
          fontSize: '12px',
          color: 'var(--color-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          opacity: 0.5,
        }}>
          Press{' '}
          <kbd style={{
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            padding: '2px 7px',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
          }}>{modKey('K')}</kbd>
          {' '}for command palette
        </div>
      </div>
    </div>
  );
}
