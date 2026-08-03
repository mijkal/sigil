import { describe, expect, it } from 'vitest';
import { isEphemeralSession, isSessionHidden } from './sessionVisibility';

// "Hide helpers" exists because Drydock's orchestrator sessions drown the
// sidebar — on 2026-08-03 there were 223 of them against 12 real ones. It is a
// NOISE control and nothing else: it never kills anything, and it must never be
// able to swallow a session that is asking for a person.

const eph = (activity?: string) =>
  ({ name: 'hostsh-abc12345', activity } as Parameters<typeof isSessionHidden>[0]);
const work = (activity?: string) =>
  ({ name: 'Dodecki', activity } as Parameters<typeof isSessionHidden>[0]);

describe('isEphemeralSession', () => {
  it('matches every prefix Drydock creates', () => {
    for (const n of ['hostsh-abc12345', 'mctask-abc12345', 'mcclean-abc12345']) {
      expect(isEphemeralSession({ name: n })).toBe(true);
    }
  });

  it('never matches a human work session', () => {
    for (const n of ['Dodecki', 'general', 'mycellm', 'bridge-eng', 'host-shell']) {
      expect(isEphemeralSession({ name: n })).toBe(false);
    }
  });
});

describe('isSessionHidden', () => {
  it('hides orchestrator debris by default', () => {
    expect(isSessionHidden(eph(), { showEphemeral: false })).toBe(true);
  });

  it('never hides a real session', () => {
    expect(isSessionHidden(work(), { showEphemeral: false })).toBe(false);
  });

  it('shows everything when the operator asks for it', () => {
    expect(isSessionHidden(eph(), { showEphemeral: true })).toBe(false);
  });

  // The two escape hatches. These are the whole reason this is a function and
  // not a `startsWith` at the call site.
  it('never hides a session that is waiting on you', () => {
    expect(isSessionHidden(eph('waiting'), { showEphemeral: false })).toBe(false);
  });

  it('never hides a session that errored', () => {
    expect(isSessionHidden(eph('error'), { showEphemeral: false })).toBe(false);
  });

  it('never hides a session you have open in a tile', () => {
    expect(isSessionHidden(eph(), { showEphemeral: false, isOpen: true })).toBe(false);
  });

  it('still hides a busy-but-not-blocked helper', () => {
    // 'working' and 'done' do not need a person, so they stay noise.
    expect(isSessionHidden(eph('working'), { showEphemeral: false })).toBe(true);
    expect(isSessionHidden(eph('done'), { showEphemeral: false })).toBe(true);
  });
});
