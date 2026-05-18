import type { ReactNode } from 'react';
import { CommandBlock } from './CommandBlock.tsx';

export interface IEmptyStateProps {
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
  command?: string;
  commandPurpose?: string;
}

export function EmptyState({
  title,
  description,
  hint,
  command,
  commandPurpose,
}: IEmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {description ? <div style={{ marginBottom: 10 }}>{description}</div> : null}
      {command ? (
        <div style={{ textAlign: 'left' }}>
          <CommandBlock command={command} purpose={commandPurpose} />
        </div>
      ) : null}
      {hint ? <div style={{ marginTop: 10, fontSize: 11.5 }}>{hint}</div> : null}
    </div>
  );
}
