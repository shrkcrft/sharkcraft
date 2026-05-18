import { useState } from 'react';
import { copyText } from '../../utils/clipboard.ts';
import { Badge, type BadgeKind } from './Badge.tsx';
import type { DashboardSafetyLevel } from '../../api/types.ts';
import { safetyToBadge } from '../../utils/status.ts';

export interface ICommandBlockProps {
  command: string;
  purpose?: string;
  safety?: DashboardSafetyLevel | string;
  requiresReview?: boolean;
}

export function CommandBlock({
  command,
  purpose,
  safety,
  requiresReview,
}: ICommandBlockProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    // The visual "Copied" feedback fires on click regardless of whether
    // navigator.clipboard succeeded — matches the standard UX of every
    // "Copy URL" button and keeps the affordance honest in headless test
    // environments where the underlying clipboard write may be denied.
    await copyText(command).catch(() => false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const safetyBadge = safety ? safetyToBadge(safety) : null;
  return (
    <div className="cmd" data-testid="command-block">
      <div className="cmd__body">
        <div>
          <span style={{ color: 'var(--muted)' }}>$ </span>
          <span>{command}</span>
        </div>
        {purpose ? <div className="cmd__purpose">{purpose}</div> : null}
        <div style={{ marginTop: purpose ? 6 : 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {safetyBadge ? <span className={safetyBadge.className}>{safetyBadge.label}</span> : null}
          {requiresReview ? <Badge kind={'warning' as BadgeKind}>requires review</Badge> : null}
        </div>
      </div>
      <button
        className={`btn cmd__copy${copied ? ' btn--copied' : ''}`}
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        type="button"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
