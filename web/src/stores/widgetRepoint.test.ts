import { describe, it, expect } from 'vitest';
import { repointStaleUsageHosts, type WidgetConfig } from './widgetStore';

// A fleet shaped the way this migration exists for: the hub runs on a box with no
// coding agent on it ('hub-box'), while the agents live on a LAN machine and on one
// reached over a VPN.
const HOSTS = [
  { name: 'hub-box', status: 'connected', tags: ['local', 'lan', 'docker', 'self'] },
  { name: 'vpn-agent', status: 'connected', tags: ['tailscale', 'mac', 'agent'] },
  { name: 'lan-agent', status: 'connected', tags: ['local', 'lan', 'agent'] },
  { name: 'nas', status: 'connected', tags: ['local', 'lan'] },
];

const w = (p: Partial<WidgetConfig>): WidgetConfig => ({
  id: 'w1', kind: 'claude-usage', name: 'Claude usage', host: 'hub-box', intervalSec: 90, ...p,
});

describe('repointStaleUsageHosts', () => {
  it('re-points a usage widget stranded on the non-agent hub', () => {
    const { widgets, changed } = repointStaleUsageHosts([w({})], HOSTS);
    expect(widgets[0].host).toBe('lan-agent');
    expect(changed).toEqual([{ name: 'Claude usage', from: 'hub-box', to: 'lan-agent' }]);
  });

  it('prefers a LAN-local agent host over one reached over a VPN', () => {
    // Order matters: the VPN agent sorts first in the list, so a plain find() would
    // pick it. The scan is a several-thousand-file walk — latency is the point.
    const { widgets } = repointStaleUsageHosts([w({})], HOSTS);
    expect(widgets[0].host).toBe('lan-agent');
    expect(widgets[0].host).not.toBe('vpn-agent');
  });

  it('leaves a widget already aimed at an agent host alone', () => {
    const before = [w({ host: 'vpn-agent' })];
    const { widgets, changed } = repointStaleUsageHosts(before, HOSTS);
    expect(changed).toHaveLength(0);
    expect(widgets).toBe(before); // same reference — nothing persisted
  });

  it('never touches command widgets, whose host is the point of the widget', () => {
    const { changed } = repointStaleUsageHosts(
      [w({ kind: 'command', host: 'nas', command: 'df -h /' })], HOSTS);
    expect(changed).toHaveLength(0);
  });

  it('is a no-op when no agent host is connected — never strands a widget worse', () => {
    const noAgents = HOSTS.map(h => ({ ...h, tags: h.tags.filter(t => t !== 'agent') }));
    const { changed } = repointStaleUsageHosts([w({})], noAgents);
    expect(changed).toHaveLength(0);
  });

  it('ignores a host this client cannot see rather than guessing', () => {
    const { changed } = repointStaleUsageHosts([w({ host: 'some-other-hub' })], HOSTS);
    expect(changed).toHaveLength(0);
  });

  it('skips agent hosts that are not currently connected', () => {
    const lanDown = HOSTS.map(h => h.name === 'lan-agent' ? { ...h, status: 'error' } : h);
    const { widgets } = repointStaleUsageHosts([w({})], lanDown);
    expect(widgets[0].host).toBe('vpn-agent');
  });
});
