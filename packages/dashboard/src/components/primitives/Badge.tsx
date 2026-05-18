import type { ReactNode } from 'react';

export type BadgeKind = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface IBadgeProps {
  kind?: BadgeKind;
  children: ReactNode;
}

const KIND_CLASS: Record<BadgeKind, string> = {
  default: 'badge',
  success: 'badge badge--success',
  warning: 'badge badge--warning',
  danger: 'badge badge--danger',
  info: 'badge badge--info',
  accent: 'badge badge--accent',
};

export function Badge({ kind = 'default', children }: IBadgeProps): JSX.Element {
  return <span className={KIND_CLASS[kind]}>{children}</span>;
}
