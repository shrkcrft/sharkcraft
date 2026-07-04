import {
  buildImportHygieneReport,
  filterViolationsToChangedScope,
  gitShowFile,
  inspectSharkcraft,
  resolveChangedFiles,
  resolveProjectConfig,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPolicyRule, IRegistrationIdiom, IWiringRule } from '@shrkcrft/core';
import {
  buildRegistrationGraph,
  evaluateBoundaries,
  loadTsconfigPaths,
  providedTokensFromEntries,
  registrationTouchesChanged,
  registrationUnprovided,
  runPolicyLint,
  runWiring,
  scanImports,
  type IUnprovidedToken,
} from '@shrkcrft/boundaries';
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';
import { ExitCode } from '../exit-codes.ts';

export const FINISH_SCHEMA = 'sharkcraft.finish/v1' as const;

/** Files in the boundary/import/wiring domain — a change outside it evaluates nothing there. */
const CODE_FILE = /\.(?:m|c)?[jt]sx?$/;
function codeFilesOf(files: readonly string[]): string[] {
  return files.filter((f) => CODE_FILE.test(f));
}

/** Outcome of one sub-gate. `skipped` = nothing to evaluate (loud, never silent green). */
export type FinishGateStatus = 'pass' | 'fail' | 'skipped';

/** One failing/relevant item, with file:line where the engine provides it. */
export interface IFinishItem {
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

export interface IFinishGate {
  readonly name: 'boundaries' | 'imports' | 'wiring' | 'unprovided' | 'policy' | 'orphans' | 'arch';
  readonly status: FinishGateStatus;
  /** One-line reason (e.g. why skipped, or the error/warning counts). */
  readonly detail: string;
  readonly errors: number;
  readonly warnings: number;
  /** Failing/notable items (capped by the renderer, full in JSON). */
  readonly items: readonly IFinishItem[];
  /**
   * Advisory gates report signal but NEVER decide the verdict: they cannot fail
   * the composite and do not count as "something was evaluated" (so an advisory
   * pass can't turn an all-skipped run green). Used by `arch`, whose cycle
   * findings are change-informative but must not attribute a pre-existing cycle
   * to this changeset.
   */
  readonly advisory?: boolean;
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
  /**
   * The honest tri-state verdict:
   *   `fail`         — a deciding gate failed (or the config could not load).
   *   `not-verified` — NOTHING was actually evaluated (every deciding gate
   *                    skipped / the changed scope had nothing to gate). Never a
   *                    green `pass` — "evaluated nothing" is `2`, not `0`.
   *   `pass`         — at least one deciding gate ran over a real scope and every
   *                    deciding gate passed.
   */
  readonly verdict: 'pass' | 'fail' | 'not-verified';
  /** The exit code this verdict maps to (0 pass / 1 fail / 2 not-verified). */
  readonly exit: ExitCode;
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

/** The base ref the unprovided gate diffs against to spot removed providers. */
function baseRefFor(input: IRunFinishInput): string | undefined {
  if (input.mode === 'files') return undefined; // an explicit file list has no diff base
  if (input.mode === 'since' && input.scope.since) return input.scope.since;
  return 'HEAD'; // worktree + staged both diff vs HEAD
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
  // The boundary/import/wiring engines only reason about code files. A change to
  // non-code files (docs, JSON, config) evaluates NOTHING in those gates, so they
  // must SKIP, not trivially pass — otherwise a markdown-only change paints green
  // ("evaluated nothing" must read as not-verified, never a `0`).
  const codeChanged = codeFilesOf(changedFiles);
  const gates: IFinishGate[] = [];

  // ── boundaries (changed-only) ────────────────────────────────────────
  const inspection = await inspectSharkcraft({ cwd });
  const boundaryRules = inspection.boundaryRegistry.list();
  if (boundaryRules.length === 0) {
    gates.push(skip('boundaries', 'no boundary rules configured'));
  } else if (codeChanged.length === 0) {
    gates.push(skip('boundaries', 'no code files in changed scope'));
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
  if (codeChanged.length === 0) {
    gates.push(skip('imports', 'no code files in changed scope'));
  } else {
    const report = buildImportHygieneReport(cwd, { files: codeChanged });
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
    gates.push(skip('unprovided', detail));
    gates.push(skip('policy', detail));
  } else {
    gates.push(
      wiringGate(cwd, loaded.value.config.wiringRules ?? [], changedFiles),
      unprovidedGate(cwd, loaded.value.config.registrationGraph ?? [], changedFiles, baseRefFor(input)),
      policyGate(cwd, loaded.value.config.policyRules ?? [], changedFiles),
    );
  }

  // ── deleted-orphans (write-safety) ───────────────────────────────────
  gates.push(await orphansGate(input));

  // ── architecture (advisory): cycles the change participates in ───────
  gates.push(await archGate(cwd, changedFiles));

  // ── impact summary (informational, best-effort) ──────────────────────
  const impact = await impactSummary(cwd, changedFiles);

  // ── fold into one honest 0/1/2 verdict ───────────────────────────────
  // Only NON-advisory ("deciding") gates decide the verdict. A deciding fail (or
  // a config that could not load) is `1`. Otherwise, if NO deciding gate actually
  // evaluated anything (all skipped), the run verified nothing → `2` (never a
  // green `0`). Only when at least one deciding gate ran over a real scope and
  // none failed is it a true `0`.
  const deciding = gates.filter((g) => !g.advisory);
  const failed = deciding.filter((g) => g.status === 'fail');
  const anyEvaluated = deciding.some((g) => g.status === 'pass');
  const warnings = gates.reduce((n, g) => n + g.warnings, 0);

  let verdict: IFinishReport['verdict'];
  let exit: ExitCode;
  if (failed.length > 0 || configError) {
    verdict = 'fail';
    exit = ExitCode.Failure;
  } else if (!anyEvaluated) {
    verdict = 'not-verified';
    exit = ExitCode.NotVerified;
  } else {
    verdict = 'pass';
    exit = ExitCode.VerifiedPass;
  }

  const skipped = gates.filter((g) => g.status === 'skipped').map((g) => g.name);
  const advisoryWarned = gates.filter((g) => g.advisory && g.warnings > 0).map((g) => g.name);
  const summary =
    verdict === 'fail'
      ? `Not safe to finish: ${configError ? 'config failed to load; ' : ''}${failed.map((g) => `${g.name} (${g.errors} error(s))`).join(', ') || 'see gates'}.`
      : verdict === 'not-verified'
        ? `Not verified: no gate evaluated the changed scope${changedFiles.length === 0 ? ' (nothing changed)' : ' (nothing in it is gate-relevant)'} — this is NOT a pass. Re-run over a scope with code changes, or gate explicitly.`
        : `Safe to finish: every applicable gate passed${warnings > 0 ? ` (${warnings} non-blocking warning(s)${advisoryWarned.length > 0 ? ` — see ${advisoryWarned.join(', ')}` : ''})` : ''}${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}.`;
  const nextAction =
    verdict === 'fail'
      ? 'Fix every failing gate item (each carries file:line), then re-run `shrk finish`.'
      : verdict === 'not-verified'
        ? 'Nothing was verified — do not treat this as done.'
        : 'Safe to declare done.';

  return {
    schema: FINISH_SCHEMA,
    scope: { mode: input.mode, files: changedFiles, fileCount: changedFiles.length },
    gates,
    impact,
    verdict,
    exit,
    warnings,
    ...(configError ? { configError } : {}),
    summary,
    nextAction,
  };
}

function skip(name: IFinishGate['name'], detail: string): IFinishGate {
  return { name, status: 'skipped', detail, errors: 0, warnings: 0, items: [] };
}

/** A skipped ADVISORY gate — reports its detail but never decides the verdict. */
function advisorySkip(name: IFinishGate['name'], detail: string): IFinishGate {
  return { name, status: 'skipped', detail, errors: 0, warnings: 0, items: [], advisory: true };
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

/**
 * The runtime-wiring `unprovided` gate — the silent-at-runtime class imports
 * can't see: a token DECLARED or INJECTED but never PROVIDED (typecheck-green,
 * absent at runtime). Backed by the registration/DI graph, scoped to the
 * changeset so only tokens THIS change touches decide the verdict. Skips (never
 * fails) when no idioms are configured or the change touched no wiring — so a
 * repo that never modeled its DI is not penalized.
 */
function unprovidedGate(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  changedFiles: readonly string[],
  baseRef?: string,
): IFinishGate {
  if (idioms.length === 0) return skip('unprovided', 'no registration idioms configured');
  const graph = buildRegistrationGraph(cwd, idioms);
  const diag = graph.diagnostics;

  // Two ways THIS change can leave a token unprovided:
  //  (1) a declared/injected site added in a changed file with no provider —
  //      caught by scoping the graph query to the changed files;
  //  (2) the last PROVIDER removed from a changed file — which leaves NO site in
  //      the changed file, so (1) structurally can't see it. Recover it by
  //      diffing the base content of the changed files (providerRegressions).
  const scoped = registrationUnprovided(graph, changedFiles);
  const regressions = baseRef ? providerRegressions(cwd, idioms, graph, changedFiles, baseRef) : [];
  const byToken = new Map<string, IUnprovidedToken>();
  for (const u of [...scoped, ...regressions]) if (!byToken.has(u.token)) byToken.set(u.token, u);
  const unprovided = [...byToken.values()].sort((a, b) => a.token.localeCompare(b.token));

  // Skip (evaluated nothing) only when the change touched no registration site
  // AND removed no provider AND has no misconfigured idiom — never a silent pass.
  if (!registrationTouchesChanged(graph, changedFiles) && unprovided.length === 0 && diag.length === 0) {
    return skip('unprovided', 'no registration sites in the changed scope');
  }
  return {
    name: 'unprovided',
    status: unprovided.length > 0 || diag.length > 0 ? 'fail' : 'pass',
    detail: `${unprovided.length} unprovided token(s) attributable to the change${diag.length > 0 ? `, ${diag.length} misconfigured idiom(s)` : ''}`,
    errors: unprovided.length + diag.length,
    warnings: 0,
    items: [
      ...unprovided.map((u) => {
        const site = u.declared[0] ?? u.consumed[0];
        return {
          ...(site ? { file: site.file, line: site.line } : {}),
          message: `"${u.token}" declared/injected but never provided (silent at runtime)`,
        };
      }),
      ...diag.map((d) => ({ message: `misconfigured idiom: ${d}` })),
    ],
  };
}

/**
 * Tokens whose LAST provider this change removed. Reads the base content of each
 * changed code file, extracts what it USED to provide, and keeps any token now
 * provided nowhere in the worktree but still declared/consumed — the runtime
 * break (`inject(T)` → undefined) that deleting a provider registration causes,
 * which leaves no site in the changed file for post-change scoping to catch.
 */
function providerRegressions(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  graph: ReturnType<typeof buildRegistrationGraph>,
  changedFiles: readonly string[],
  baseRef: string,
): IUnprovidedToken[] {
  const codeChanged = codeFilesOf(changedFiles);
  if (codeChanged.length === 0) return [];
  const baseEntries: { path: string; content: string }[] = [];
  for (const f of codeChanged) {
    const content = gitShowFile(cwd, baseRef, f);
    if (content !== null) baseEntries.push({ path: f, content });
  }
  if (baseEntries.length === 0) return [];
  const wasProvided = providedTokensFromEntries(idioms, baseEntries);
  const out: IUnprovidedToken[] = [];
  for (const token of wasProvided) {
    const node = graph.tokens.find((t) => t.token === token);
    if (node && node.provided.length === 0 && (node.declared.length > 0 || node.consumed.length > 0)) {
      out.push({ token, declared: node.declared, consumed: node.consumed });
    }
  }
  return out;
}

/**
 * Advisory architecture gate: does any changed file participate in a runtime
 * import cycle? Distinct from the `boundaries` gate (which sees layer violations,
 * not cycles). Deliberately ADVISORY — a pre-existing cycle a change merely
 * touches must not be attributed to this changeset, so it reports as a
 * non-blocking warning and never fails the composite. Type-only import edges are
 * excluded (they erase at emit and can't cause a runtime cycle). Best-effort:
 * a missing graph index degrades to skip, never fail.
 */
async function archGate(cwd: string, changedFiles: readonly string[]): Promise<IFinishGate> {
  const codeChanged = codeFilesOf(changedFiles);
  if (codeChanged.length === 0) return advisorySkip('arch', 'no code files in changed scope');
  try {
    const { GraphStore, GraphQueryApi } = await import('@shrkcrft/graph');
    if (!new GraphStore(cwd).exists()) {
      return advisorySkip('arch', 'code-graph index missing — run `shrk graph index`');
    }
    const api = GraphQueryApi.fromStore(cwd);
    const cycles = api.cycles(); // runtime cycles only (type-only edges excluded)
    const scope = new Set(codeChanged.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
    const touching = cycles.filter((c) =>
      (c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, ''))).some((p) => scope.has(p)),
    );
    if (touching.length === 0) {
      return advisorySkip(
        'arch',
        `no changed file participates in an import cycle (${cycles.length} runtime cycle(s) in repo)`,
      );
    }
    return {
      name: 'arch',
      status: 'pass', // advisory: reports cycles as warnings, never fails the composite
      advisory: true,
      detail: `${touching.length} changed file(s) participate in a runtime import cycle (advisory — not attributed to this change)`,
      errors: 0,
      warnings: touching.length,
      items: touching.slice(0, 15).map((c) => {
        const paths = c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, ''));
        return { message: `import cycle (size ${c.size}): ${paths.join(' → ')}` };
      }),
    };
  } catch (e) {
    return advisorySkip('arch', `arch check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
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
