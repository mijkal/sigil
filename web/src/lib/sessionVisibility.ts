import type { Session } from '../types';

const EPHEMERAL_PREFIXES = ['hostsh-', 'mctask-', 'mcclean-'];

export function isEphemeralSession(session: Pick<Session, 'name'>): boolean {
  return EPHEMERAL_PREFIXES.some(prefix => session.name.startsWith(prefix));
}
