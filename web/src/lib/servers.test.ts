import { describe, it, expect } from 'vitest';
import { serverLabelFromUrl, dedupeServers, upsertServer, removeFromList, makeServer } from './servers';

describe('serverLabelFromUrl', () => {
  it('uses host[:port]', () => {
    expect(serverLabelFromUrl('https://sigil.example.com')).toBe('sigil.example.com');
    expect(serverLabelFromUrl('http://sigil-host.local:7777')).toBe('sigil-host.local:7777');
  });
  it('degrades gracefully on garbage', () => {
    expect(serverLabelFromUrl('not a url')).toBe('not a url');
  });
});

describe('makeServer', () => {
  it('normalizes url + defaults the label to the host', () => {
    const s = makeServer('http://sigil-host.local:7777/', 'tok ');
    expect(s.url).toBe('http://sigil-host.local:7777');
    expect(s.token).toBe('tok');
    expect(s.label).toBe('sigil-host.local:7777');
  });
  it('keeps an explicit label', () => {
    expect(makeServer('http://h:1', 't', 'Home').label).toBe('Home');
  });
});

describe('dedupeServers', () => {
  it('collapses same-URL entries (case/slash-insensitive), keeping the last', () => {
    const list = [
      { id: 'a', label: 'A', url: 'http://h:1', token: 't1' },
      { id: 'b', label: 'B', url: 'http://H:1/', token: 't2' },
    ];
    const out = dedupeServers(list);
    expect(out).toHaveLength(1);
    expect(out[0].token).toBe('t2');
  });
});

describe('upsertServer', () => {
  it('updates in place by id', () => {
    const list = [{ id: 'a', label: 'A', url: 'http://a:1', token: 't' }];
    const out = upsertServer(list, { id: 'a', label: 'A2', url: 'http://a:1', token: 't2' });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('A2');
    expect(out[0].token).toBe('t2');
  });
  it('adds a new distinct server', () => {
    const list = [{ id: 'a', label: 'A', url: 'http://a:1', token: 't' }];
    const out = upsertServer(list, { id: 'b', label: 'B', url: 'http://b:1', token: 't' });
    expect(out).toHaveLength(2);
  });
});

describe('removeFromList', () => {
  it('drops by id', () => {
    const list = [{ id: 'a', label: 'A', url: 'http://a:1', token: 't' }, { id: 'b', label: 'B', url: 'http://b:1', token: 't' }];
    expect(removeFromList(list, 'a').map((s) => s.id)).toEqual(['b']);
  });
});
