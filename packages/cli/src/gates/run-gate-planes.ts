import { resolveSourceGlobs } from '@shrkcrft/core';
import { checkDocReferences, type ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  IBaselineRule,
  IDocReferenceRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
} from '@shrkcrft/core';
import {
  buildRegistrationGraph,
  matchesAny,
  registrationOrphans,
  registrationUnprovided,
  registryDuplicates,
  runPolicyLint,
  runWiring,
  scanRegistry,
} from '@shrkcrft/boundaries';
import { evaluateBaselineRule } from '../commands/baseline.command.ts';
import { evaluateGeneratedRule, generatedHintFor } from '../commands/generated.command.ts';
import type { IGateRuleResult } from './gate-envelope.ts';
import type { GatePlane, IGateRuleView } from './gate-rule-view.ts';

/**
 * Run every data-defined plane's VIOLATION check and normalize the results.
 *
 * Each plane already has a verb, but gating a change meant running five of them
 * and `&&`-chaining five exit codes — so in practice people ran one or two. The
 * value here is that one call answers "does this change violate any declared
 * rule?" with one exit code, and it does so by calling the SAME evaluators the
 * per-plane verbs call. A second implementation of any plane's check would
 * eventually disagree with the verb, and the aggregate — the one wired into CI
 * — would be the copy nobody notices is wrong.
 */

export interface IRunGatePlanesOptions {
  readonly cwd: string;
  readonly excludeDirs: readonly string[];
  /**
   * Restrict to rules whose footprint intersects these changed files. Scoping
   * is applied by the CALLER (it owns the git diff); this is passed through to
   * the plane engines that scope internally.
   */
  readonly changedFiles?: readonly string[];
  /**
   * Skip every check that would SPAWN a shell (a `command` baseline compute, a
   * generated `regen`). The header/classification halves still run, so the
   * result stays honest — a skipped drift check is reported as skipped, never
   * folded into a pass.
   */
  readonly noSpawn?: boolean;
  /**
   * Registries for the doc-reference plane. Built lazily by the caller — a
   * repo without that plane never loads them.
   */
  readonly inspection?: ISharkcraftInspection;
}

/** One plane's contribution, plus any engine diagnostics it produced. */
export interface IGatePlaneRun {
  readonly results: readonly IGateRuleResult[];
  readonly diagnostics: readonly string[];
}

/** Evaluate the given rules, dispatching each to its plane's real engine. */
export function runGatePlanes(
  rules: readonly IGateRuleView[],
  options: IRunGatePlanesOptions,
): IGatePlaneRun {
  const results: IGateRuleResult[] = [];
  const diagnostics: string[] = [];
  const byPlane = <T>(plane: GatePlane): T[] =>
    rules.filter((r) => r.plane === plane).map((r) => r.raw as T);

  results.push(...runWiringPlane(byPlane<IWiringRule>('wiring'), options, diagnostics));
  results.push(...runPolicyPlane(byPlane<IPolicyRule>('policy'), options));
  results.push(...runRegistryPlane(byPlane<IRegistryDeclaration>('registry'), options));
  results.push(...runRegistrationPlane(byPlane<IRegistrationIdiom>('registration'), options));
  results.push(...runBaselinePlane(byPlane<IBaselineRule>('baseline'), options));
  results.push(...runGeneratedPlane(byPlane<IGeneratedArtifactRule>('generated'), options));
  results.push(...runDocReferencePlane(byPlane<IDocReferenceRule>('doc-reference'), options));

  return { results, diagnostics };
}

function runWiringPlane(
  rules: readonly IWiringRule[],
  options: IRunGatePlanesOptions,
  diagnostics: string[],
): IGateRuleResult[] {
  if (rules.length === 0) return [];
  const report = runWiring(options.cwd, rules, { excludeDirs: options.excludeDirs });
  diagnostics.push(...report.diagnostics);
  return report.rules.map((r) => {
    const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
    return {
      id: r.ruleId,
      type: 'wiring' as const,
      status: r.status,
      severity: r.severity,
      counts: { declared: r.declaredCount, registered: r.registeredCount },
      violations: r.violations.map((v) => ({
        id: v.token,
        ...(v.file ? { file: v.file } : {}),
        ...(v.line !== undefined ? { line: v.line } : {}),
        ...(v.message ? { message: v.message } : {}),
        ...(v.hint ? { hint: v.hint } : {}),
      })),
      ...(skip ? { skipReason: skip.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  });
}

function runPolicyPlane(
  rules: readonly IPolicyRule[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  if (rules.length === 0) return [];
  const report = runPolicyLint(options.cwd, rules, { excludeDirs: options.excludeDirs });
  return report.rules.map((r) => {
    const rule = rules.find((x) => x.id === r.ruleId);
    const findings = report.findings.filter((f) => f.ruleId === r.ruleId);
    const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
    return {
      id: r.ruleId,
      type: 'policy' as const,
      status: r.status,
      severity: r.severity,
      counts: { units: r.unitsScanned, findings: r.findingCount, suppressed: r.suppressedCount },
      violations: findings.map((f) => ({
        id: f.file,
        file: f.file,
        line: f.line,
        message: f.message,
        ...(f.suggest ?? rule?.suggest ? { hint: f.suggest ?? rule!.suggest! } : {}),
      })),
      ...(skip ? { skipReason: skip.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  });
}

/**
 * The registry plane's violation check is DUPLICATES: two roots claiming one id
 * compile fine, and whichever registration wins at runtime is an accident of
 * load order. (Presence queries are lookups, not gates, so they are not run.)
 */
function runRegistryPlane(
  decls: readonly IRegistryDeclaration[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  return decls.map((decl) => {
    const inventory = scanRegistry(options.cwd, decl, { excludeDirs: options.excludeDirs });
    const dupes = registryDuplicates(inventory);
    const empty = inventory.entries.length === 0;
    return {
      id: decl.name,
      type: 'registry' as const,
      status: empty ? ('skipped' as const) : dupes.length > 0 ? ('failed' as const) : ('passed' as const),
      severity: 'warning' as const,
      counts: { ids: inventory.entries.length, duplicates: dupes.length },
      violations: dupes.map((d) => ({
        id: d.id,
        ...(d.sites[0] ? { file: d.sites[0].file, line: d.sites[0].line } : {}),
        message: `declared in ${d.sites.length} places: ${d.sites.map((s) => `${s.file}:${s.line}`).join(', ')}`,
        hint: 'remove the duplicate declaration — which one wins is load-order roulette',
      })),
      ...(empty ? { skipReason: 'matched 0 ids — the source selector is probably stale' } : {}),
    };
  });
}

/**
 * The registration plane's violation check is UNPROVIDED: a token declared or
 * consumed but provided by nothing resolves to nothing at runtime — invisible
 * to the compiler, which is the entire reason this plane exists. Orphans (a
 * provider nothing consumes) are COUNTED but do not fail: a registration ahead
 * of its consumer is a normal intermediate state, not a defect.
 */
function runRegistrationPlane(
  idioms: readonly IRegistrationIdiom[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  if (idioms.length === 0) return [];
  // The graph is built from EVERY idiom at once (that is what makes a
  // declared→provided→consumed chain traceable across them), so a finding has
  // to be attributed back by matching its sites against each idiom's own globs.
  // Dumping every finding on the first idiom would leave the others reading
  // `passed` while their tokens resolve to nothing — a green that means nothing.
  const graph = buildRegistrationGraph(options.cwd, idioms, { excludeDirs: options.excludeDirs });
  const unprovided = registrationUnprovided(graph, options.changedFiles);
  const orphans = registrationOrphans(graph, options.changedFiles);

  const ownsFile = (idiom: IRegistrationIdiom, file: string): boolean =>
    matchesAny(file, [
      ...resolveSourceGlobs(idiom.declared),
      ...resolveSourceGlobs(idiom.consumed),
      ...resolveSourceGlobs(idiom.provided),
    ]);

  return idioms.map((idiom) => {
    const mine = unprovided.filter((t) =>
      [...t.declared, ...t.consumed].some((site) => ownsFile(idiom, site.file)),
    );
    const myOrphans = orphans.filter((t) => t.provided.some((site) => ownsFile(idiom, site.file)));
    const empty = graph.tokens.length === 0;
    return {
      id: idiom.name,
      type: 'registration' as const,
      status: empty
        ? ('skipped' as const)
        : mine.length > 0
          ? ('failed' as const)
          : ('passed' as const),
      severity: 'warning' as const,
      counts: { tokens: graph.tokens.length, unprovided: mine.length, orphans: myOrphans.length },
      violations: mine.map((t) => ({
        id: t.token,
        ...(t.declared[0] ? { file: t.declared[0].file, line: t.declared[0].line } : {}),
        message: 'declared/consumed but provided by nothing — resolves to nothing at runtime',
        hint: `trace it with \`shrk wiring chain ${t.token}\``,
      })),
      ...(empty ? { skipReason: 'registration graph matched 0 tokens' } : {}),
    };
  });
}

function runBaselinePlane(
  rules: readonly IBaselineRule[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  return rules.map((rule) => {
    // A `command` compute spawns a shell. Under --no-spawn it is reported as
    // skipped WITH the reason, never silently treated as clean.
    if (options.noSpawn && rule.compute.kind === 'command') {
      return {
        id: rule.id,
        type: 'baseline' as const,
        status: 'skipped' as const,
        severity: rule.severity ?? 'error',
        counts: { committed: 0, current: 0 },
        violations: [],
        skipReason: '`command` compute skipped by --no-spawn',
      };
    }
    const o = evaluateBaselineRule(options.cwd, rule, options.excludeDirs, options.changedFiles);
    return {
      id: o.rule.id,
      type: 'baseline' as const,
      status: o.status,
      severity: o.rule.severity ?? 'error',
      counts: { committed: o.committedCount, current: o.currentCount },
      violations: [
        ...(o.diff?.added ?? []).map((e) => ({ id: e, message: 'gained since the baseline was blessed' })),
        ...(o.diff?.removed ?? []).map((e) => ({ id: e, message: 'LOST since the baseline was blessed' })),

      ].map((v) => ({ ...v, hint: rule.hint ?? `bless with \`shrk baseline update --id ${rule.id}\`` })),
      ...(o.skipReason ? { skipReason: o.skipReason } : {}),
      ...(o.error ? { error: o.error } : {}),
    };
  });
}

/**
 * The doc-reference plane's violation check: an id cited in prose that resolves
 * to nothing. Skipped honestly when the registries were not loaded — claiming a
 * pass without having checked is the failure mode this whole surface exists to
 * prevent.
 */
function runDocReferencePlane(
  rules: readonly IDocReferenceRule[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  if (rules.length === 0) return [];
  const inspection = options.inspection;
  if (!inspection) {
    return rules.map((rule) => ({
      id: rule.id,
      type: 'doc-reference' as const,
      status: 'skipped' as const,
      severity: rule.severity ?? 'error',
      counts: { files: 0, tokens: 0 },
      violations: [],
      skipReason: 'registries not loaded — doc references were not resolved',
    }));
  }
  return rules.map((rule) => {
    const res = checkDocReferences(options.cwd, rule, inspection, options.excludeDirs);
    return {
      id: res.ruleId,
      type: 'doc-reference' as const,
      status: res.status,
      severity: res.severity,
      counts: { files: res.filesScanned, tokens: res.tokensChecked, skipped: res.tokensSkipped },
      violations: res.findings.map((f) => ({
        id: f.token,
        file: f.file,
        line: f.line,
        message: f.message,
        ...(f.didYouMean.length > 0 ? { hint: `did you mean: ${f.didYouMean.join(', ')}` } : {}),
      })),
      ...(res.skipReason ? { skipReason: res.skipReason } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  });
}

function runGeneratedPlane(
  rules: readonly IGeneratedArtifactRule[],
  options: IRunGatePlanesOptions,
): IGateRuleResult[] {
  return rules.map((rule) => {
    // --no-spawn keeps the header + classification halves (pure reads) and
    // drops only the regen diff, which is reported as a partial run.
    const headersOnly = options.noSpawn === true;
    const o = evaluateGeneratedRule(options.cwd, rule, options.excludeDirs, headersOnly);
    const spawnSkipped = headersOnly && (rule.regen !== undefined || (rule.sources?.length ?? 0) > 0);
    // A rule whose DRIFT half was skipped has not passed — it partially ran. A
    // header contract holding proves nothing about whether the file was
    // hand-edited, so reporting `passed` here would be the exact false green
    // this plane exists to prevent. Findings still fail; the clean case
    // downgrades to `skipped` so the aggregate exit is 2, not 0.
    const status: IGateRuleResult['status'] =
      spawnSkipped && o.status === 'passed' ? 'skipped' : o.status;
    return {
      id: o.rule.id,
      type: 'generated' as const,
      status,
      severity: o.rule.severity ?? 'error',
      counts: {
        files: o.committedCount,
        differences: o.treeDiff?.differences.length ?? 0,
        provenance: o.provenance.length,
      },
      violations: [
        ...(o.treeDiff?.differences ?? []).map((d) => ({
          id: d.file,
          file: d.file,
          message: d.kind,
          hint: generatedHintFor(o.rule),
        })),
        ...o.provenance.map((f) => ({
          id: f.file,
          file: f.file,
          message: f.message,
          hint: generatedHintFor(o.rule),
        })),
      ],
      ...(o.skipReason
        ? { skipReason: o.skipReason }
        : spawnSkipped
          ? { skipReason: 'regen drift check skipped by --no-spawn (headers + classification still ran)' }
          : {}),
      ...(o.error ? { error: o.error } : {}),
    };
  });
}
