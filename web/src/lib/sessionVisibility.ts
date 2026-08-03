import type { Session } from '../types';

const EPHEMERAL_PREFIXES = ['hostsh-', 'mctask-', 'mcclean-'];

export function isEphemeralSession(session: Pick<Session, 'name'>): boolean {
  return EPHEMERAL_PREFIXES.some(prefix => session.name.startsWith(prefix));
}

// Activities that mean the session is asking for a person. Hiding one of these
// is the single unacceptable failure of this filter: the sidebar is where the
// operator finds out that something needs them, so a rule meant to reduce noise
// must never be able to swallow the signal.
const NEEDS_YOU = new Set(['waiting', 'error']);

/**
 * Should this session be hidden from the sidebar right now?
 *
 * "Hide helpers" is a NOISE control, not a lifecycle one — it never kills
 * anything, and it must never hide something the operator has to act on. Two
 * escape hatches, both deliberate:
 *
 *   - the session is open in a tile (you are looking at it, so it is not noise);
 *   - it is `waiting` or `error` (it needs you).
 *
 * Everything else that matches an ephemeral prefix is orchestrator debris and
 * stays hidden, which is the default.
 */
export function isSessionHidden(
  session: Pick<Session, 'name' | 'activity'>,
  opts: { showEphemeral: boolean; isOpen?: boolean },
): boolean {
  if (opts.showEphemeral) return false;
  if (!isEphemeralSession(session)) return false;
  if (opts.isOpen) return false;
  if (session.activity && NEEDS_YOU.has(session.activity)) return false;
  return true;
}
