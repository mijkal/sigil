import type { Host } from '../../types';

export type GroupKey = 'local' | 'tailscale' | 'prod' | 'other';

export const GROUP_ORDER: GroupKey[] = ['local', 'tailscale', 'prod', 'other'];

export const GROUP_META: Record<GroupKey, { label: string; icon: string }> = {
  local:     { label: 'Local',      icon: '⌂' },
  tailscale: { label: 'Tailscale',  icon: '⬡' },
  prod:      { label: 'Production', icon: '⬡' },
  other:     { label: 'Other',      icon: '⬡' },
};

export function getGroup(host: Host): GroupKey {
  const tags = host.tags ?? [];
  if (tags.includes('self') || tags.includes('lan') || tags.includes('local')) return 'local';
  if (tags.includes('tailscale')) return 'tailscale';
  if (tags.includes('prod'))      return 'prod';
  return 'other';
}

export function sortHosts(hosts: Host[]): Host[] {
  return [...hosts].sort((a, b) => {
    // "self" always first within group
    const aSelf = (a.tags ?? []).includes('self') ? 0 : 1;
    const bSelf = (b.tags ?? []).includes('self') ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    // Connected before disconnected
    const aConn = a.status === 'connected' ? 0 : 1;
    const bConn = b.status === 'connected' ? 0 : 1;
    if (aConn !== bConn) return aConn - bConn;
    // Alphabetical
    return a.name.localeCompare(b.name);
  });
}

export function groupHosts(hosts: Host[]): Map<GroupKey, Host[]> {
  const map = new Map<GroupKey, Host[]>();
  for (const g of GROUP_ORDER) map.set(g, []);
  for (const h of hosts) map.get(getGroup(h))!.push(h);
  // sort within groups
  for (const [k, v] of map) map.set(k, sortHosts(v));
  // remove empty groups
  for (const [k, v] of map) if (v.length === 0) map.delete(k);
  return map;
}
