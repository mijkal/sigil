import { SigilLogoBig } from '../SigilLogo';
import { emptySt } from './styles';

export function EmptyState({ connected, serverUrl, onAddHost, onEditConnection }: {
  connected: boolean;
  serverUrl: string;
  onAddHost: () => void;
  onEditConnection?: () => void;
}) {
  // Monochrome logo via grayscale + lowered opacity — matches "light, large, mono" feel.
  const monoIcon = (
    <div style={{ filter: 'grayscale(1) brightness(1.4)', opacity: 0.35 }}>
      <SigilLogoBig size={72} />
    </div>
  );

  if (!connected) {
    // Hostname extracted for readable display (the hub host.lan:7777)
    let host = serverUrl;
    try { host = new URL(serverUrl).host; } catch { /* keep raw */ }
    return (
      <div style={emptySt.wrap}>
        {monoIcon}
        <div style={emptySt.title}>Can't reach sigild</div>
        <div style={emptySt.body}>
          <code style={emptySt.code}>{host}</code> isn't responding.
        </div>
        <div style={emptySt.hint}>
          If this device can't resolve <code style={emptySt.codeInline}>.lan</code> names,
          try the LAN IP or a Tailscale hostname instead.
        </div>
        {onEditConnection && (
          <button style={emptySt.cta} onClick={onEditConnection}>Edit connection</button>
        )}
      </div>
    );
  }

  return (
    <div style={emptySt.wrap}>
      {monoIcon}
      <div style={emptySt.title}>No hosts yet</div>
      <div style={emptySt.body}>Add a host to start a session.</div>
      <button style={emptySt.cta} onClick={onAddHost}>+ Add Host</button>
    </div>
  );
}
