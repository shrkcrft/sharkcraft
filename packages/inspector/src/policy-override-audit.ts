/**
 * Policy override audit trail.
 *
 * Append-only log of policy override events. Lives at
 * `.sharkcraft/policy-override-audit.log` (one JSON entry per line).
 *
 * Only written when the caller explicitly opts in
 * (`--record-override-audit`). Read-only by default.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { PolicySeverity } from './policy-engine.ts';

export const POLICY_OVERRIDE_AUDIT_SCHEMA = 'sharkcraft.policy-override-audit/v1';

export interface IPolicyOverrideAuditEntry {
  schema: typeof POLICY_OVERRIDE_AUDIT_SCHEMA;
  timestamp: string;
  policyId: string;
  originalSeverity?: PolicySeverity;
  effectiveSeverity?: PolicySeverity;
  disabled: boolean;
  reason?: string;
  sourceConfig: string;
  command: string;
}

const LOG_PATH = ['.sharkcraft', 'policy-override-audit.log'] as const;

export function policyOverrideAuditPath(projectRoot: string): string {
  return nodePath.join(projectRoot, ...LOG_PATH);
}

export function readPolicyOverrideAudit(
  inspection: ISharkcraftInspection,
): readonly IPolicyOverrideAuditEntry[] {
  const file = policyOverrideAuditPath(inspection.projectRoot);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: IPolicyOverrideAuditEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as IPolicyOverrideAuditEntry;
        if (obj && typeof obj.policyId === 'string') out.push(obj);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function appendPolicyOverrideAudit(
  inspection: ISharkcraftInspection,
  entries: readonly Omit<IPolicyOverrideAuditEntry, 'schema' | 'timestamp'>[],
): string {
  const file = policyOverrideAuditPath(inspection.projectRoot);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const body = entries
    .map(
      (e) =>
        JSON.stringify({
          schema: POLICY_OVERRIDE_AUDIT_SCHEMA,
          timestamp: now,
          ...e,
        } satisfies IPolicyOverrideAuditEntry) + '\n',
    )
    .join('');
  if (body.length > 0) appendFileSync(file, body, 'utf8');
  return file;
}
