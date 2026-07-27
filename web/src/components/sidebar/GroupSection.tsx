import React from 'react';
import type { Host, Session } from '../../types';
import { GROUP_META } from './hostGrouping';
import type { GroupKey } from './hostGrouping';
import { HostRow } from './HostRow';
import { SessionRow } from './SessionRow';
import { NewSessionInput } from './NewSessionInput';

export function GroupSection({ groupKey, hosts, sessionsByHost, collapsedGroups, onToggle,
  newSessionFor, onNewSession, onEditHost, onRemoveHost, onSessionOpen, onCreateSession,
  onDeleteSession, onRenameSession, onResurrectSession, pinnedNames, onPin }: {
  groupKey: GroupKey;
  hosts: Host[];
  sessionsByHost: Map<string, Session[]>;
  collapsedGroups: Set<GroupKey>;
  onToggle: (g: GroupKey) => void;
  newSessionFor: string | null;
  onNewSession: (name: string) => void;
  onEditHost: (host: Host) => void;
  onRemoveHost: (name: string) => void;
  onSessionOpen: (s: Session, windowIndex?: number, windowName?: string) => void;
  onCreateSession: (hostName: string, name: string, startDir: string, startCmd: string) => Promise<void>;
  onDeleteSession: (s: Session) => void;
  onRenameSession: (s: Session, newName: string) => void;
  onResurrectSession: (s: Session) => void;
  pinnedNames: Set<string>;
  onPin: (name: string) => void;
}) {
  const meta = GROUP_META[groupKey];
  const collapsed = collapsedGroups.has(groupKey);
  const connectedCount = hosts.filter(h => h.status === 'connected').length;
  const [hovered, setHovered] = React.useState(false);

  return (
    <div style={{ marginBottom: '2px' }}>
      {/* Group header */}
      <div
        style={{
          display: 'flex', alignItems: 'center',
          padding: '7px 10px 5px 10px', gap: '6px', cursor: 'pointer',
          background: hovered ? 'rgba(255,255,255,0.02)' : 'transparent',
          transition: 'background 0.1s', userSelect: 'none',
        }}
        onClick={() => onToggle(groupKey)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Chevron */}
        <span style={{
          fontSize: '9px', color: 'var(--color-muted)',
          transition: 'transform 0.15s',
          display: 'inline-block',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        }}>▾</span>

        <span style={{
          flex: 1, fontSize: '10px', fontWeight: 700,
          color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.1em',
        }}>{meta.label}</span>

        {/* connected / total */}
        <span style={{ fontSize: '10px', color: 'var(--color-muted-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {connectedCount}/{hosts.length}
        </span>
      </div>

      {/* Hosts in group */}
      {!collapsed && hosts.map(host => {
        const hostSessions = sessionsByHost.get(host.name) ?? [];
        return (
          <div key={host.name}>
            <HostRow
              host={host}
              sessionCount={hostSessions.length}
              pinned={pinnedNames.has(host.name)}
              onPin={() => onPin(host.name)}
              onNewSession={() => onNewSession(host.name)}
              onEdit={() => onEditHost(host)}
              onRemove={() => onRemoveHost(host.name)}
            />

            {newSessionFor === host.name && host.status === 'connected' && (
              <NewSessionInput
                hostName={host.name}
                onSubmit={(name, startDir, startCmd) => onCreateSession(host.name, name, startDir, startCmd)}
                onCancel={() => onNewSession('')}
              />
            )}

            {hostSessions.length === 0 ? (
              <div style={{
                padding: '3px 12px 3px 28px', fontSize: '11px',
                color: 'var(--color-muted-dim)', fontStyle: 'italic',
              }}>
                {host.status === 'connected' ? 'no sessions' : 'not connected'}
              </div>
            ) : (
              hostSessions.map(s => (
                <SessionRow
                  key={s.id}
                  session={s}
                  onOpen={(winIdx, winName) => onSessionOpen(s, winIdx, winName)}
                  onOpenWindow={(winIdx, winName) => onSessionOpen(s, winIdx, winName)}
                  onDelete={() => onDeleteSession(s)}
                  onRename={newName => onRenameSession(s, newName)}
                  onResurrect={() => onResurrectSession(s)}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}
