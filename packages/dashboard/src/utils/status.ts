import type { DashboardSafetyLevel } from '../api/types.ts';

export function safetyToBadge(level: DashboardSafetyLevel | string): {
  className: string;
  label: string;
} {
  switch (level) {
    case 'read-only':
      return { className: 'badge badge--success', label: 'read-only' };
    case 'writes-drafts':
      return { className: 'badge badge--info', label: 'writes-drafts' };
    case 'writes-source':
      return { className: 'badge badge--warning', label: 'writes-source' };
    case 'runs-shell':
      return { className: 'badge badge--warning', label: 'runs-shell' };
    case 'destructive':
      return { className: 'badge badge--danger', label: 'destructive' };
    default:
      return { className: 'badge', label: String(level) };
  }
}

export function freshnessBadge(status: string | undefined): { className: string; label: string } {
  switch (status) {
    case 'fresh':
      return { className: 'badge badge--success', label: 'fresh' };
    case 'stale':
      return { className: 'badge badge--warning', label: 'stale' };
    case 'unknown':
    default:
      return { className: 'badge', label: 'unknown' };
  }
}

export function gateBadge(status: string): { className: string; label: string } {
  switch (status) {
    case 'pass':
      return { className: 'badge badge--success', label: 'pass' };
    case 'warn':
      return { className: 'badge badge--warning', label: 'warn' };
    case 'fail':
      return { className: 'badge badge--danger', label: 'fail' };
    case 'skipped':
      return { className: 'badge', label: 'skipped' };
    default:
      return { className: 'badge', label: status };
  }
}
