/**
 * Policy severity overrides.
 *
 * Local config can override the severity (or enable/disable) of
 * pack-contributed or local policy checks. Overrides are visible in
 * the report and always have a reason field.
 *
 * Source: `sharkcraft.config.ts` `policyOverrides` array.
 */
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  type IPolicyCheck,
  type IPolicyReport,
  PolicySeverity,
} from './policy-engine.ts';

export const POLICY_OVERRIDES_SCHEMA = 'sharkcraft.policy-overrides/v1';

export interface IPolicyOverride {
  policyId: string;
  severity?: PolicySeverity;
  enabled?: boolean;
  reason?: string;
}

export interface IPolicyOverridesReport {
  schema: typeof POLICY_OVERRIDES_SCHEMA;
  overrides: readonly IPolicyOverride[];
  applied: readonly {
    policyId: string;
    appliedSeverity?: PolicySeverity;
    originalSeverity?: PolicySeverity;
    disabled?: boolean;
    reason?: string;
  }[];
}

function readOverridesFromConfig(inspection: ISharkcraftInspection): readonly IPolicyOverride[] {
  const cfg = inspection.config as { policyOverrides?: readonly IPolicyOverride[] } | null;
  if (!cfg || !Array.isArray(cfg.policyOverrides)) return [];
  const out: IPolicyOverride[] = [];
  for (const o of cfg.policyOverrides) {
    if (typeof o.policyId !== 'string' || o.policyId.length === 0) continue;
    const override: IPolicyOverride = { policyId: o.policyId };
    if (o.severity) override.severity = o.severity;
    if (typeof o.enabled === 'boolean') override.enabled = o.enabled;
    if (typeof o.reason === 'string') override.reason = o.reason;
    out.push(override);
  }
  return out;
}

export function listPolicyOverrides(inspection: ISharkcraftInspection): readonly IPolicyOverride[] {
  return readOverridesFromConfig(inspection);
}

export function applyPolicyOverrides(
  report: IPolicyReport,
  overrides: readonly IPolicyOverride[],
): { report: IPolicyReport; explain: IPolicyOverridesReport } {
  const byId = new Map<string, IPolicyOverride>();
  for (const o of overrides) byId.set(o.policyId, o);
  const applied: {
    policyId: string;
    appliedSeverity?: PolicySeverity;
    originalSeverity?: PolicySeverity;
    disabled?: boolean;
    reason?: string;
  }[] = [];
  const checks: IPolicyCheck[] = [];
  for (const c of report.checks) {
    const o = byId.get(c.id);
    if (!o) {
      checks.push(c);
      continue;
    }
    if (o.enabled === false) {
      applied.push({
        policyId: c.id,
        originalSeverity: c.severity,
        disabled: true,
        ...(o.reason ? { reason: o.reason } : {}),
      });
      continue;
    }
    if (o.severity && o.severity !== c.severity) {
      checks.push({ ...c, severity: o.severity });
      applied.push({
        policyId: c.id,
        appliedSeverity: o.severity,
        originalSeverity: c.severity,
        ...(o.reason ? { reason: o.reason } : {}),
      });
    } else {
      checks.push(c);
    }
  }
  // Recompute summary.
  let info = 0,
    warning = 0,
    error = 0,
    critical = 0;
  for (const c of checks) {
    if (c.severity === PolicySeverity.Info) info++;
    else if (c.severity === PolicySeverity.Warning) warning++;
    else if (c.severity === PolicySeverity.Error) error++;
    else if (c.severity === PolicySeverity.Critical) critical++;
  }
  const passed = error === 0 && critical === 0;
  return {
    report: {
      ...report,
      checks,
      summary: { info, warning, error, critical, passed },
    },
    explain: {
      schema: POLICY_OVERRIDES_SCHEMA,
      overrides,
      applied,
    },
  };
}
