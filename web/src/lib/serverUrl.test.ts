import { describe, it, expect } from 'vitest';
import { pickServerUrl } from './serverUrl';

describe('pickServerUrl', () => {
  it('uses same-origin when nothing is stored', () => {
    expect(pickServerUrl(null, 'https:', 'sigil.example.com')).toBe('https://sigil.example.com');
  });

  it('overrides a stored http:// target on an https page (mixed content)', () => {
    expect(pickServerUrl('http://sigil-host.local:7777', 'https:', 'sigil.example.com'))
      .toBe('https://sigil.example.com');
  });

  it('keeps a stored http target on an http page (LAN direct)', () => {
    expect(pickServerUrl('http://sigil-host.local:7777', 'http:', 'sigil-host.local:7777'))
      .toBe('http://sigil-host.local:7777');
  });

  it('keeps a stored https target on an https page', () => {
    expect(pickServerUrl('https://sigil.example.com', 'https:', 'sigil.example.com'))
      .toBe('https://sigil.example.com');
  });

  it('keeps a cross-origin https target (no mixed content)', () => {
    expect(pickServerUrl('https://other.example.com', 'https:', 'sigil.example.com'))
      .toBe('https://other.example.com');
  });
});
