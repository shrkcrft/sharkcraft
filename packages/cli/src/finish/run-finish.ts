import {
  buildImportHygieneReport,
  filterViolationsToChangedScope,
  inspectSharkcraft,
  resolveChangedFiles,
  resolveProjectConfig,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPolicyRule, IWiringRule } from '@shrkcrft/core';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  runPolicyLint,
  runWiring,
  scanImports,
} from '@shrkcrft/boundaries';
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';

export const FINISH_SCHEMA = 'sharkcraft.finish/v1' as const;

/** Outcome of one sub-gate. `skipped` = nothing to evaluate (loud, never silent green). */
export type FinishGateStatus = 'pass' | 'fail' | 'skipped';

/** One failing/relevant item, with file:line where the engine provides it. */
export interface IFinishItem {
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

export interface IFinishGate {
  readonly name: 'boundaries' | 'imports' | 'wiring' | 'policy' | 'orphans';
  readonly status: FinishGateStatus;
  /** One-line reason (e.g. why skipped, or the error/warning counts). */
  readonly detail: string;
  readonly errors: number;
  readonly warnings: number;
  /** Failing/notable items (capped by the renderer, full in JSON). */
  readonly items: readonly IFinishItem[];
}

export interface IFinishImpact {
  readonly ran: boolean;
  readonly risk?: string;
  readonly directDependents?: number;
  readonly transitiveDependents?: number;
  /** Why the summary could not run (no graph index / no changed files). */
  readonly note?: string;
}

export interface IFinishReport {
  readonly schema: typeof FINISH_SCHEMA;
  readonly scope: {
    readonly mode: 'worktree' | 'staged' | 'since' | 'files';
    readonly files: readonly string[];
    readonly fileCount: number;
  };
  readonly gates: readonly IFinishGate[];
  readonly impact: IFinishImpact;
  /** `fail` iff any gate failed OR the config could not load; else `pass`. */
  readonly verdict: 'pass' | 'fail';
  /** Total warning-severity findings across gates (non-blocking). */
  readonly warnings: number;
  /** Set when sharkcraft.config.ts could not be loaded — forces a `fail`. */
  readonly configError?: string;
  readonly summary: string;
  readonly nextAction: string;
}

export interface IRunFinishInput {
  readonly cwd: string;
  readonly mode: 'worktree' | 'staged' | 'since' | 'files';
  readonly scope: IChangedScopeOptions;
}

/** Map the changed-scope onto the orphan check's diff inputs. */
function orphanOptsFor(input: IRunFinishInput): { since?: string; staged?: boolean } | undefined {
  if (input.mode === 'files') return undefined; // a file list has no diff to read deletions from
  if (input.mode === 'staged') return { staged: true };
  if (input.mode === 'since' && input.scope.since) return { since: input.scope.since };
  // Worktree mode: diff deletions vs HEAD so the orphan gate's "deleted" set
  // matches the working-tree scope the other gates use (not the whole branch).
  return { since: 'HEAD' };
}

/**
 * The composite "is this changeset safe to finish?" orchestrator. Runs every
 * deterministic CHANGED-ONLY gate inline — boundaries + import-hygiene + wiring
 * + policy + deleted-orphans — plus a best-effort impact summary, and folds
 * them into ONE pass/fail. This is the single trustworthy "done?" call an
 * autonomous agent needs and can't reliably assemble by hand (only shrk can run
 * the alias-resolved layer/wiring gates). Honors the `0-rules → skipped`
 * semantics so a no-op sub-check is reported, never silently passed. Read-only.
 */
export async function runFinishGates(input: IRunFinishInput): Promise<IFinishReport> {
  const { cwd } = input;
  const changed = resolveChangedFiles(input.scope);
  const changedFiles = changed.files;
  const gates: IFinishGate[] = [];

  // ── boundaries (changed-only) ────────────────────────────────────────
  const inspection = await inspectSharkcraft({ cwd });
  const boundaryRules = inspection.boundaryRegistry.list();
  if (boundaryRules.length === 0) {
    gates.push(skip('boundaries', 'no boundary rules configured'));
  } else if (changedFiles.length === 0) {
    gates.push(skip('boundaries', 'no files in changed scope'));
  } else {
    const scan = scanImports({ projectRoot: cwd });
    const tsconfigPaths = loadTsconfigPaths(cwd);
    const evalResult = evaluateBoundaries(scan, boundaryRules, {
      ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    });
    const filtered = filterViolationsToChangedScope(evalResult.violations, input.scope);
    const errors = filtered.includedViolations.filter((v) => v.severity === 'error');
    const warnings = filtered.includedViolations.filter((v) => v.severity === 'warning');
    gates.push({
      name: 'boundaries',
      status: errors.length > 0 ? 'fail' : 'pass',
      detail: `${errors.length} error(s), ${warnings.length} warning(s) across ${changedFiles.length} changed file(s)`,
      errors: errors.length,
      warnings: warnings.length,
      items: [...errors, ...warnings].map((v) => ({
        file: v.file,
        line: v.line,
        message: `[${v.severity}] ${v.ruleId}: ${v.message}`,
      })),
    });
  }

  // ── import hygiene (changed-only) ────────────────────────────────────
  if (changedFiles.length === 0) {
    gates.push(skip('imports', 'no files in changed scope'));
  } else {
    const report = buildImportHygieneReport(cwd, { files: changedFiles });
    const errors =
      report.counts?.['error'] ?? (report.verdict === 'errors' ? report.findings.length : 0);
    const warnings =
      report.counts?.['warning'] ?? (report.verdict === 'warnings' ? report.findings.length : 0);
    gates.push({
      name: 'imports',
      status: report.verdict === 'errors' ? 'fail' : 'pass',
      detail: `verdict=${report.verdict} (${report.findings.length} finding(s))`,
      errors,
      warnings,
      items: report.findings.map((f) => ({
        file: f.file,
        line: f.line,
        message: `${f.kind}: ${f.suggestedFix || f.reason || f.snippet}`.trim(),
      })),
    });
  }

  // ── wiring + policy (changed-only, from resolved config) ─────────────
  const loaded = await resolveProjectConfig(cwd);
  let configError: string | undefined;
  if (!loaded.ok) {
    // A MALFORMED config in a real sharkcraft project is a fail (the wiring/
    // policy gates can't be trusted). The mere ABSENCE of a sharkcraft/ folder
    // is not — those gates simply don't apply, so skip them without failing.
    const isSharkcraftProject = existsSync(nodePath.join(cwd, 'sharkcraft'));
    if (isSharkcraftProject) configError = loaded.error.message;
    const detail = isSharkcraftProject
      ? `config did not load: ${loaded.error.message}`
      : 'no sharkcraft config (gate not applicable)';
    gates.push(skip('wiring', detail));
    gates.push(skip('policy', detail));
  } else {
    gates.push(
      wiringGate(cwd, loaded.value.config.wiringRules ?? [], changedFiles),
      policyGate(cwd, loaded.value.config.policyRules ?? [], changedFiles),
    );
  }

  // ── deleted-orphans (write-safety) ───────────────────────────────────
  gates.push(await orphansGate(input));

  // ── impact summary (informational, best-effort) ──────────────────────
  const impact = await impactSummary(cwd, changedFiles);

  // ── fold into one verdict ────────────────────────────────────────────
  const failed = gates.filter((g) => g.status === 'fail');
  const warnings = gates.reduce((n, g) => n + g.warnings, 0);
  const verdict: 'pass' | 'fail' = failed.length > 0 || configError ? 'fail' : 'pass';

  const skipped = gates.filter((g) => g.status === 'skipped').map((g) => g.name);
  const summary =
    verdict === 'fail'
      ? `Not safe to finish: ${configError ? 'config failed to load; ' : ''}${failed.map((g) => `${g.name} (${g.errors} error(s))`).join(', ') || 'see gates'}.`
      : changedFiles.length === 0 && input.mode !== 'files'
        ? 'No files in the changed scope — nothing to gate.'
        : `Safe to finish: every applicable gate passed${warnings > 0 ? ` (${warnings} non-blocking warning(s))` : ''}${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}.`;
  const nextAction =
    verdict === 'fail'
      ? 'Fix every failing gate item (each carries file:line), then re-run `shrk finish`.'
      : 'Safe to declare done.';

  return {
    schema: FINISH_SCHEMA,
    scope: { mode: input.mode, files: changedFiles, fileCount: changedFiles.length },
    gates,
    impact,
    verdict,
    warnings,
    ...(configError ? { configError } : {}),
    summary,
    nextAction,
  };
}

function skip(name: IFinishGate['name'], detail: string): IFinishGate {
  return { name, status: 'skipped', detail, errors: 0, warnings: 0, items: [] };
}

function wiringGate(
  cwd: string,
  rules: readonly IWiringRule[],
  changedFiles: readonly string[],
): IFinishGate {
  if (rules.length === 0) return skip('wiring', 'no wiring rules configured');
  const report = runWiring(cwd, rules, { changedOnly: true, changedFiles });
  if (report.evaluated === 0) {
    return skip('wiring', `${report.rules.length} rule(s) configured but none matched the changed scope`);
  }
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warnings = report.violations.filter((v) => v.severity === 'warning');
  // A misconfigured rule (bad regex / no capture group) yields a diagnostic +
  // rule-level error but NO violation — it must FAIL the gate, never read as a
  // silent green ("loud, never silent green").
  const diag = report.diagnostics;
  return {
    name: 'wiring',
    status: report.verdict === 'errors' || diag.length > 0 ? 'fail' : 'pass',
    detail: `${report.evaluated}/${report.rules.length} rule(s) evaluated — ${errors.length} error(s), ${warnings.length} warning(s)${diag.length > 0 ? `, ${diag.length} misconfigured` : ''}`,
    errors: errors.length + diag.length,
    warnings: warnings.length,
    items: [
      ...report.violations.map((v) => ({
        file: v.file,
        line: v.line,
        message: `[${v.severity}] ${v.ruleId}: "${v.token}" ${v.direction === 'registered-missing' ? 'registered but not declared' : 'declared but not registered'}`,
      })),
      ...diag.map((d) => ({ message: `misconfigured rule: ${d}` })),
    ],
  };
}

function policyGate(
  cwd: string,
  rules: readonly IPolicyRule[],
  changedFiles: readonly string[],
): IFinishGate {
  if (rules.length === 0) return skip('policy', 'no policy rules configured');
  const report = runPolicyLint(cwd, rules, { changedOnly: true, changedFiles });
  if (report.evaluated === 0) {
    return skip('policy', `${report.rules.length} rule(s) configured but none matched the changed scope`);
  }
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');
  const diag = report.diagnostics;
  return {
    name: 'policy',
    status: report.verdict === 'errors' || diag.length > 0 ? 'fail' : 'pass',
    detail: `${report.evaluated}/${report.rules.length} rule(s) evaluated — ${errors.length} error(s), ${warnings.length} warning(s)${diag.length > 0 ? `, ${diag.length} misconfigured` : ''}`,
    errors: errors.length + diag.length,
    warnings: warnings.length,
    items: [
      ...report.findings.map((f) => ({
        file: f.file,
        line: f.line,
        message: `[${f.severity}] ${f.ruleId}: ${f.message ?? ''}`.trim(),
      })),
      ...diag.map((d) => ({ message: `misconfigured rule: ${d}` })),
    ],
  };
}

async function orphansGate(input: IRunFinishInput): Promise<IFinishGate> {
  const opts = orphanOptsFor(input);
  if (!opts) return skip('orphans', 'explicit --files scope has no diff to read deletions from');
  const scan = await computeDeletedOrphans(input.cwd, opts);
  if (!scan.ok) {
    return skip(
      'orphans',
      scan.reason === 'graph-missing'
        ? 'code-graph index missing — run `shrk graph index` to enable the orphan check'
        : `diff unavailable: ${scan.error ?? 'unknown'}`,
    );
  }
  if (scan.deleted.length === 0) return skip('orphans', `nothing deleted (vs ${scan.ref})`);
  const orphans = scan.report?.orphans ?? [];
  return {
    name: 'orphans',
    status: orphans.length > 0 ? 'fail' : 'pass',
    detail: `${scan.deleted.length} deleted file(s) (vs ${scan.ref}) — ${orphans.length} surviving importer(s)`,
    errors: orphans.length,
    warnings: 0,
    items: orphans.map((o) => ({
      file: o.path ?? o.id,
      ...(typeof o.line === 'number' ? { line: o.line } : {}),
      message:
        o.via === 'reference' && o.symbol
          ? `references \`${o.symbol}\` from deleted ${o.deletedFile}`
          : `imports deleted ${o.deletedFile}`,
    })),
  };
}

async function impactSummary(cwd: string, changedFiles: readonly string[]): Promise<IFinishImpact> {
  if (changedFiles.length === 0) return { ran: false, note: 'no changed files' };
  try {
    const { GraphStore } = await import('@shrkcrft/graph');
    if (!new GraphStore(cwd).exists()) {
      return { ran: false, note: 'code-graph index missing — run `shrk graph index`' };
    }
    const { analyzeGraphImpact } = await import('@shrkcrft/impact-engine');
    const analysis = analyzeGraphImpact(
      { kind: 'files', files: [...changedFiles] },
      { projectRoot: cwd, maxDepth: 5, limit: 200 },
    );
    return {
      ran: true,
      risk: analysis.risk,
      directDependents: analysis.directDependents.length,
      transitiveDependents: analysis.transitiveDependents.length,
    };
  } catch (e) {
    return { ran: false, note: `impact summary unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
