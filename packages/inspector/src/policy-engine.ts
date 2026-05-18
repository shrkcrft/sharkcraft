import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateBoundaries, loadTsconfigPaths, scanImports } from '@shrkcrft/boundaries';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { impactFor, loadOwnershipRules, type IOwnershipRule } from './ownership.ts';

export const POLICY_REPORT_SCHEMA = 'sharkcraft.policy-report/v1';

export enum PolicySeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
  Critical = 'critical',
}

export enum PolicyCheckType {
  Path = 'path',
  Import = 'import',
  Ownership = 'ownership',
  Command = 'command',
  Template = 'template',
  Plan = 'plan',
  Bundle = 'bundle',
  Session = 'session',
}

export interface IPolicyCheck {
  id: string;
  title: string;
  severity: PolicySeverity;
  checkType: PolicyCheckType;
  message: string;
  suggestedFix?: string;
  relatedRules?: readonly string[];
  relatedPathConventions?: readonly string[];
  context?: Record<string, unknown>;
}

/**
 * Shape packs export from `policyCheckFiles`. Each declaration runs the
 * given predicate against the current inspection + (optional) plan/bundle
 * targets and contributes zero or more checks to the report.
 *
 * Predicates are pure functions of inspection state — no shell, no network.
 */
export interface IPackPolicyCheck {
  id: string;
  title: string;
  severity?: PolicySeverity;
  checkType?: PolicyCheckType;
  /**
   * Return one of:
   *  - boolean `true`  → passing (no check emitted)
   *  - boolean `false` → failing (emit a default check)
   *  - object          → custom message / suggestedFix / context
   */
  evaluate: (input: {
    projectRoot: string;
    planTargets: readonly string[];
    bundleAffectedFiles: readonly string[];
  }) => boolean | { message: string; suggestedFix?: string; context?: Record<string, unknown> };
}

export interface IPolicyCheckRegistration {
  id: string;
  title: string;
  severity: PolicySeverity;
  checkType: PolicyCheckType;
  source: 'local' | 'pack';
  sourceFile: string;
  packName?: string;
  signatureStatus?: string;
}

export interface IPolicyReport {
  schema: typeof POLICY_REPORT_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  checks: readonly IPolicyCheck[];
  registrations: readonly IPolicyCheckRegistration[];
  summary: {
    info: number;
    warning: number;
    error: number;
    critical: number;
    passed: boolean;
  };
}

export interface IPolicyEvaluateInput {
  /** Optional explicit plan file to evaluate. */
  planFile?: string;
  /** Optional bundle id. */
  bundleId?: string;
  /** Optional session id. */
  sessionId?: string;
  /** Optional configured ownership files. */
  ownershipFiles?: readonly string[];
  /** Skip pack-contributed policy checks. Default false. */
  skipPackPolicies?: boolean;
  /** Require packs that contribute policy checks to be signed-and-verified. */
  requireSignedPolicyPacks?: boolean;
  /** Override the local policy files list. Default: ['sharkcraft/policies.ts']. */
  localPolicyFiles?: readonly string[];
  /** When provided, only evaluate this single registered policy id. */
  onlyId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function evaluatePolicy(
  inspection: ISharkcraftInspection,
  input: IPolicyEvaluateInput = {},
): Promise<IPolicyReport> {
  const cwd = inspection.projectRoot;
  const checks: IPolicyCheck[] = [];
  const registrations: IPolicyCheckRegistration[] = [];

  // 1) Boundary violations.
  if (inspection.boundaryRegistry.size() > 0) {
    try {
      const scan = scanImports({ projectRoot: cwd });
      const tsconfigPaths = loadTsconfigPaths(cwd);
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
        ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
      });
      for (const v of evalResult.violations.slice(0, 200)) {
        checks.push({
          id: `boundary:${v.ruleId}:${v.file}:${v.line}`,
          title: `Boundary violation: ${v.ruleId}`,
          severity: v.severity === 'error' ? PolicySeverity.Error : PolicySeverity.Warning,
          checkType: PolicyCheckType.Import,
          message: `${v.file}:${v.line} imports ${v.importSpecifier} — ${v.message}`,
          relatedRules: [v.ruleId],
        });
      }
    } catch (e) {
      checks.push({
        id: 'boundary:scan-failed',
        title: 'Boundary scan failed',
        severity: PolicySeverity.Warning,
        checkType: PolicyCheckType.Import,
        message: (e as Error).message,
      });
    }
  }

  // 2) Forbidden actions (from action hints) — surface as informational checks
  //    so the agent sees them in the policy report.
  const allForbidden = new Set<string>();
  for (const e of inspection.knowledgeEntries) {
    const hints = (e as { actionHints?: { forbiddenActions?: readonly string[] } }).actionHints;
    for (const a of hints?.forbiddenActions ?? []) allForbidden.add(a);
  }
  for (const f of allForbidden) {
    checks.push({
      id: `forbidden:${hash(f)}`,
      title: 'Forbidden action documented',
      severity: PolicySeverity.Info,
      checkType: PolicyCheckType.Command,
      message: f,
    });
  }

  // 3) Ownership-required reviews for an explicit plan (best-effort).
  if (input.planFile) {
    const planTargets = extractPlanTargets(cwd, input.planFile);
    const { rules } = await loadOwnershipRules(cwd, input.ownershipFiles);
    if (rules.length > 0 && planTargets.length > 0) {
      const impact = impactFor(planTargets, rules);
      if (impact.requiredReviewFiles.length > 0) {
        checks.push({
          id: 'ownership:required-review',
          title: 'Ownership requires review',
          severity: PolicySeverity.Warning,
          checkType: PolicyCheckType.Ownership,
          message: `Plan touches ${impact.requiredReviewFiles.length} file(s) with requiredReview owners.`,
          context: { files: impact.requiredReviewFiles, owners: impact.owners },
        });
      }
    }
  }

  // 4) Unsigned plan check.
  if (input.planFile) {
    try {
      const planPath = nodePath.isAbsolute(input.planFile)
        ? input.planFile
        : nodePath.join(cwd, input.planFile);
      if (existsSync(planPath)) {
        const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as {
          signature?: string;
        };
        if (!parsed.signature) {
          checks.push({
            id: 'plan:unsigned',
            title: 'Plan is unsigned',
            severity: PolicySeverity.Warning,
            checkType: PolicyCheckType.Plan,
            message: `${input.planFile} has no signature.`,
            suggestedFix:
              'Sign with `shrk plan sign <plan.json>` or generate with --sign.',
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 5) Pack signature gate (if any pack is unverified).
  for (const pack of inspection.packs.validPacks ?? []) {
    const status = (pack as { signatureStatus?: string }).signatureStatus;
    if (status && status !== 'verified' && status !== 'not-checked') {
      checks.push({
        id: `pack:unverified:${pack.packageName}`,
        title: 'Pack signature not verified',
        severity: PolicySeverity.Warning,
        checkType: PolicyCheckType.Bundle,
        message: `Pack ${pack.packageName} signature status: ${status}`,
      });
    }
  }

  // 6) Pack-contributed + local policy checks.
  const planTargets: string[] = input.planFile
    ? extractPlanTargets(cwd, input.planFile)
    : [];
  let bundleAffectedFiles: readonly string[] = [];
  if (input.bundleId) {
    try {
      const { readFeatureBundle } = await import('./feature-bundle.ts');
      const b = readFeatureBundle(cwd, input.bundleId);
      if (b) bundleAffectedFiles = b.affectedFiles;
    } catch {
      /* ignore */
    }
  }

  const runDecl = (
    d: IPackPolicyCheck,
    reg: IPolicyCheckRegistration,
  ): void => {
    registrations.push(reg);
    if (input.onlyId && reg.id !== input.onlyId) return;
    let result: boolean | { message: string; suggestedFix?: string; context?: Record<string, unknown> };
    try {
      result = d.evaluate({ projectRoot: cwd, planTargets, bundleAffectedFiles });
    } catch (e) {
      checks.push({
        id: `${reg.id}:error`,
        title: d.title,
        severity: PolicySeverity.Warning,
        checkType: d.checkType ?? PolicyCheckType.Path,
        message: `Policy check threw: ${(e as Error).message}`,
      });
      return;
    }
    if (result === true) return;
    const detail = typeof result === 'object' ? result : { message: 'Policy check failed' };
    checks.push({
      id: reg.id,
      title: d.title,
      severity: d.severity ?? PolicySeverity.Warning,
      checkType: d.checkType ?? PolicyCheckType.Path,
      message: detail.message,
      ...(detail.suggestedFix ? { suggestedFix: detail.suggestedFix } : {}),
      ...(detail.context ? { context: detail.context } : {}),
    });
  };

  // 6a) Local policy file(s).
  const localFiles = input.localPolicyFiles ?? ['sharkcraft/policies.ts'];
  for (const rel of localFiles) {
    const full = nodePath.isAbsolute(rel) ? rel : nodePath.join(cwd, rel);
    if (!existsSync(full)) continue;
    try {
      const mod = (await import(pathToFileURL(full).href)) as {
        default?: readonly IPackPolicyCheck[];
        policyChecks?: readonly IPackPolicyCheck[];
      };
      const decls = mod.default ?? mod.policyChecks ?? [];
      for (const d of decls) {
        runDecl(d, {
          id: `local:${d.id}`,
          title: d.title,
          severity: d.severity ?? PolicySeverity.Warning,
          checkType: d.checkType ?? PolicyCheckType.Path,
          source: 'local',
          sourceFile: full,
        });
      }
    } catch (e) {
      checks.push({
        id: `local:policy:load-failed:${nodePath.basename(full)}`,
        title: 'Local policy check load failed',
        severity: PolicySeverity.Warning,
        checkType: PolicyCheckType.Bundle,
        message: `${full}: ${(e as Error).message}`,
      });
    }
  }

  // 6b) Pack-contributed policy files (skippable for safety).
  if (!input.skipPackPolicies) {
    for (const pack of inspection.packs.validPacks ?? []) {
      const c = pack.manifest?.contributions as { policyCheckFiles?: readonly string[] } | undefined;
      const files = c?.policyCheckFiles ?? [];
      if (files.length === 0) continue;
      const sigStatus = (pack as { signatureStatus?: string }).signatureStatus;
      const verified = sigStatus === 'verified';
      if (input.requireSignedPolicyPacks && !verified) {
        checks.push({
          id: `pack:policy:unsigned:${pack.packageName}`,
          title: 'Pack policy file requires signature',
          severity: PolicySeverity.Warning,
          checkType: PolicyCheckType.Bundle,
          message: `Pack ${pack.packageName} contributes policy checks but signature status is ${sigStatus ?? 'unknown'}; skipping per --require-signed-policy-packs.`,
        });
        continue;
      }
      if (!verified) {
        // Always emit a soft warning when an unsigned pack contributes policy
        // checks so the operator notices the trust boundary.
        checks.push({
          id: `pack:policy:warn-unsigned:${pack.packageName}`,
          title: 'Unsigned pack contributes policy checks',
          severity: PolicySeverity.Info,
          checkType: PolicyCheckType.Bundle,
          message: `Pack ${pack.packageName} contributes policy checks but signature status is ${sigStatus ?? 'unknown'}.`,
        });
      }
      for (const rel of files) {
        const full = nodePath.resolve(pack.packageRoot, rel);
        if (!existsSync(full)) continue;
        try {
          const mod = (await import(pathToFileURL(full).href)) as {
            default?: readonly IPackPolicyCheck[];
            policyChecks?: readonly IPackPolicyCheck[];
          };
          const decls = mod.default ?? mod.policyChecks ?? [];
          for (const d of decls) {
            runDecl(d, {
              id: `pack:${pack.packageName}:${d.id}`,
              title: d.title,
              severity: d.severity ?? PolicySeverity.Warning,
              checkType: d.checkType ?? PolicyCheckType.Path,
              source: 'pack',
              sourceFile: full,
              packName: pack.packageName,
              ...(sigStatus ? { signatureStatus: sigStatus } : {}),
            });
          }
        } catch (e) {
          checks.push({
            id: `pack:${pack.packageName}:policy:load-failed`,
            title: 'Pack policy check load failed',
            severity: PolicySeverity.Warning,
            checkType: PolicyCheckType.Bundle,
            message: `${pack.packageName} (${rel}): ${(e as Error).message}`,
          });
        }
      }
    }
  }

  const summary = { info: 0, warning: 0, error: 0, critical: 0, passed: true };
  for (const c of checks) {
    if (c.severity === PolicySeverity.Info) summary.info += 1;
    else if (c.severity === PolicySeverity.Warning) summary.warning += 1;
    else if (c.severity === PolicySeverity.Error) summary.error += 1;
    else if (c.severity === PolicySeverity.Critical) summary.critical += 1;
  }
  summary.passed = summary.error === 0 && summary.critical === 0;

  return {
    schema: POLICY_REPORT_SCHEMA,
    generatedAt: nowIso(),
    projectRoot: cwd,
    checks,
    registrations,
    summary,
  };
}

function extractPlanTargets(cwd: string, planFile: string): string[] {
  try {
    const planPath = nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile);
    if (!existsSync(planPath)) return [];
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as {
      changes?: readonly { relativePath?: string; path?: string; targetPath?: string }[];
      plan?: { changes?: readonly { relativePath?: string; path?: string; targetPath?: string }[] };
    };
    const changes = parsed.changes ?? parsed.plan?.changes ?? [];
    return changes
      .map((c) => c.relativePath ?? c.path ?? c.targetPath ?? '')
      .filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
