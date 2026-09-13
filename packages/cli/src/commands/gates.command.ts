/**
 * `shrk gates` — the rule-authoring trust layer.
 *
 *   shrk gates list [--plane <p>]      # every data-defined rule, across every plane
 *   shrk gates coverage [--strict]     # what each rule MATCHED; flags every rule matching 0
 *   shrk gates explain <id>            # the concrete inputs one rule resolved
 *
 * Every rule engine in shrk is only as trustworthy as the author's ability to
 * see what a rule actually matched, and the dominant real-world failure is a
 * stale selector that silently matches nothing — a "pass" that checked zero
 * files. `gates coverage` is the detector: run it in CI and a rule quietly
 * dying becomes a failure in its own right.
 *
 * Distinct from `shrk gate` (singular), which RUNS the quality-gate pipeline.
 * This verb inspects the data-defined RULES themselves.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
  IWiringSource,
} from '@shrkcrft/core';
import {
  coverageShortfall,
  formatCoverage,
  DEAD_SELECTOR_CAUSES,
  formatEmptyRuleAdvice,
  formatUnitLiveness,
  resolvePlaneExtractors,
  RuleEmptiness,
  ruleVerdictRecords,
  UnitLivenessState,
  validateResolvedPlaneSources,
} from '@shrkcrft/core';
import { explainWiring, inspectSource, scanRegistry, settleGlobLists, sourceLivenessRequest } from '@shrkcrft/boundaries';
import {
  BaselineRuleSchema,
  DocReferenceRuleSchema,
  GATE_PLANE_CONFIG_KEY,
  GeneratedArtifactRuleSchema,
  normalizePlaneRule,
  PolicyRuleSchema,
  RegistrationIdiomSchema,
  RegistryDeclarationSchema,
  WiringRuleSchema,
} from '@shrkcrft/config';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import {
  inspectSharkcraft,
  refExists,
  resolveChangedFiles,
  resolveProjectConfig,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { clearFileReadCache, planeScanExcludeDirs } from '@shrkcrft/boundaries';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';

import { GLOBAL_FLAGS } from '../dispatch/global-flags.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import {
  collectGateRules,
  GATE_PLANES,
  type GatePlane,
  type IGatePlanes,
  type IGateRuleView,
} from '../gates/gate-rule-view.ts';
import {
  buildGateCoverage,
  coverageDeadUnits,
  coverageWentLiveUnits,
  formatDeadUnits,
  formatNegations,
  reportsDeadGlobs,
  settleGateCoverage,
  withRejectedRules,
  type IGateCoverage,
} from '../gates/rule-coverage.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import type { ISettledVerdict } from '../gates/settled-verdict.ts';
import { insertSelfTest, scaffoldSelfTest } from '../gates/scaffold-selftest.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { acceptedEmptyNote } from '../gates/accepted-empty-note.ts';
import { emptyRuleAdviceLines } from '../gates/empty-rule-advice-lines.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { gateRuleLabeledSources, ruleTouchedBy } from '../gates/gate-rule-globs.ts';
import { runGatePlanes } from '../gates/run-gate-planes.ts';
import { baselineExplainCommand } from './baseline.command.ts';
import { generatedExplainCommand } from './generated.command.ts';
import { docsReferencesExplainCommand } from './docs-references.command.ts';
import { renderPolicyExplain, runPolicyExplain } from './policy-lint.command.ts';
import { renderWiringExplain } from './wiring.command.ts';

const SCHEMA = 'sharkcraft.gates/v1';

export interface IPrepared {
  readonly cwd: string;
  readonly rules: readonly IGateRuleView[];
  readonly excludeDirs: string[];
  readonly planeDiagnostics: readonly string[];
  /**
   * Every pack rule the merge seam REJECTED, as an errored row (`failed
   * validation — NOT evaluated`) — a configured rule that did not run, so it
   * enters every verdict's denominator (round 12 review, R12-X1).
   */
  readonly rejectedRules: readonly (IGateRuleResult & { readonly type: GatePlane })[];
  /** The config's named `extractors`, for the shared-extractor coverage view. */
  readonly extractors: Readonly<Record<string, IWiringSource>>;
  /** Absolute path of the loaded config file, or null when none exists. */
  readonly configFile: string | null;
}

export async function prepare(
  args: ParsedArgs,
): Promise<{ ok: true; value: IPrepared } | { ok: false; code: number }> {
  const cwd = resolveCwd(args);
  // Coverage memoizes its tree reads inside one call (see `withFileReadCache`).
  // `--no-cache` drops anything already memoized so a suspected caching bug can
  // be ruled out without a code change.
  if (flagBool(args, 'no-cache')) clearFileReadCache();
  const json = flagBool(args, 'json');
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    const msg = loaded.error.message;
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: msg }) + '\n');
    else process.stderr.write(`Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  return {
    ok: true,
    value: {
      cwd,
      rules: collectGateRules(loaded.value.config),
      // THE plane scan scope — the one authority every plane verb reads too.
      excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
      planeDiagnostics: loaded.value.planeDiagnostics,
      rejectedRules: seamRejectedRules(loaded.value),
      extractors: loaded.value.config.extractors ?? {},
      configFile: loaded.value.configFile,
    },
  };
}

/** Parse `--plane`, refusing an unknown value rather than silently matching nothing. */
function parsePlanes(args: ParsedArgs): { ok: true; planes?: Set<GatePlane> } | { ok: false } {
  const raw = flagString(args, 'plane');
  if (!raw) return { ok: true };
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !GATE_PLANES.includes(p as GatePlane));
  if (bad.length > 0) {
    process.stderr.write(`Unknown --plane "${bad.join(', ')}". Use ${GATE_PLANES.join(' | ')}.\n`);
    return { ok: false };
  }
  return { ok: true, planes: new Set(parts as GatePlane[]) };
}

function writeNoRules(json: boolean): number {
  if (json) {
    process.stdout.write(asJson({ schema: SCHEMA, rules: [], total: 0 }) + '\n');
    return ExitCode.NotVerified;
  }
  process.stdout.write(header('Gate rules'));
  process.stdout.write(
    '  No data-defined rules declared. These planes live in sharkcraft.config.ts:\n' +
      '    wiringRules[]        declared-here → registered-there completeness\n' +
      '    policyRules[]        forbidden content the compiler never sees\n' +
      '    registries[]         id inventories (`shrk registry <name> list`)\n' +
      '    registrationGraph[]  DI/registration idioms (`shrk wiring chain`)\n' +
      '    baselines[]          committed ledgers that must not silently drift\n' +
      '    generatedArtifacts[] generated files that must not be hand-edited\n',
  );
  return ExitCode.NotVerified;
}


/**
 * Resolve `--changed-only` / `--since <ref>` (`--base` is a synonym) into the
 * changed-file set, or `undefined` for a whole-tree run.
 *
 * `error` is distinct from "no files changed": an unresolvable ref must not
 * silently degrade to an empty diff, which would narrow every rule out of
 * scope and produce a green run that checked nothing.
 */
export function resolveScope(
  args: ParsedArgs,
  cwd: string,
): { files?: readonly string[]; error?: string } {
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since') ?? flagString(args, 'base');
  if (!changedOnly && !since) return {};
  // The SAME helper `check wiring --changed-only` uses, so bare
  // `--changed-only` means the working tree here too. Two surfaces disagreeing
  // about what "changed" means is how a pre-commit hook silently checks a
  // different set than the CI step it is supposed to mirror.
  if (since !== undefined && !refExists(cwd, since)) {
    return { error: `cannot resolve ref '${since}' — not a valid commit/branch` };
  }
  const changed = resolveChangedFiles({
    projectRoot: cwd,
    ...(since ? { since } : { includeWorktree: true }),
  });
  return { files: changed.files };
}

/**
 * Narrow rules to those whose FOOTPRINT intersects the change.
 *
 * Returns the surviving rules plus how many were dropped, because a scoped run
 * must never print the same headline as a full one — "0 violations across 2 of
 * 9 rules" and "0 violations across 9 of 9" are different facts.
 */
export function narrowToScope(
  rules: readonly IGateRuleView[],
  files: readonly string[] | undefined,
): { selected: readonly IGateRuleView[]; skippedByScope: number } {
  if (files === undefined) return { selected: rules, skippedByScope: 0 };
  const selected = rules.filter((r) => ruleTouchedBy(r, files));
  return { selected, skippedByScope: rules.length - selected.length };
}

/** Flags every `gates` verb accepts; anything else is a typo, not an opt-in. */
const GATES_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'margin',
  'write',
  'strict',
  'plane',
  'only',
  'changed-only',
  'since',
  'base',
  'no-spawn',
  'no-cache',
  'full',
  'limit',
  'id',
  'rule-file',
  'wiring',
  // Every dispatcher global (THE list) — a direct handler call may carry them.
  ...GLOBAL_FLAGS,
]);

/**
 * `--fail-on-dead-units`: a dead glob inside a CONNECTED rule — an inclusion
 * glob that selects nothing, or a negation that excludes nothing — fails the
 * run. A live negation is never dead, so the flag is usable in a repo whose
 * rules exclude their tests. The same flag name the boundary plane uses for
 * its dead scope globs, so one CI switch means one thing across every plane.
 */
const FAIL_ON_DEAD_UNITS_FLAG = 'fail-on-dead-units';

/** Flags only `gates coverage` accepts on top of {@link GATES_FLAGS}. */
const COVERAGE_ONLY_FLAGS: ReadonlySet<string> = new Set([FAIL_ON_DEAD_UNITS_FLAG]);

/** Flags only `gates try` accepts on top of {@link GATES_FLAGS}. */
const TRY_ONLY_FLAGS: ReadonlySet<string> = new Set(['flags']);

/** Flags only `gates check` accepts on top of {@link GATES_FLAGS}. */
const CHECK_ONLY_FLAGS: ReadonlySet<string> = new Set([ALLOW_EMPTY_FLAG]);

// An unrecognized flag is refused rather than ignored: a mistyped
// `--changed-only` would otherwise parse as an unrelated `true`, run the
// UNSCOPED form, and exit `0` as though the scoped check had passed. Each
// guarded verb DECLARES its complete set (`flags`: GATES_FLAGS plus its own
// extras — the identical sets the inline `rejectUnknownFlags` guard used), and
// the dispatcher refuses anything else before `run`, exiting 3 (UsageError).

/**
 * Apply `--plane` and `--only` narrowing.
 *
 * An unknown `--only` id is REFUSED rather than silently matching nothing: a
 * typo'd rule id would otherwise narrow the run to zero rules and report a
 * confident pass over an empty set.
 */
function filterRules(
  all: readonly IGateRuleView[],
  planes: Set<GatePlane> | undefined,
  only: string | undefined,
  rejectedAll: readonly (IGateRuleResult & { readonly type: GatePlane })[] = [],
):
  | {
      ok: true;
      rules: readonly IGateRuleView[];
      /** The merge-seam-rejected rules the same `--plane` / `--only` select. */
      rejected: readonly (IGateRuleResult & { readonly type: GatePlane })[];
    }
  | { ok: false } {
  let rules = planes ? all.filter((r) => planes.has(r.plane)) : all;
  let rejected = planes ? rejectedAll.filter((r) => planes.has(r.type)) : rejectedAll;
  if (!only) return { ok: true, rules, rejected };
  const wanted = only.split(',').map((x) => x.trim()).filter(Boolean);
  // A rejected rule is a DECLARED rule (it did not run), so `--only <its id>`
  // selects its errored row rather than refusing the id as unknown.
  const known = new Set([...all.map((r) => r.id), ...rejectedAll.map((r) => r.id)]);
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown rule id(s) in --only: ${unknown.join(', ')}. Run \`shrk gates list\` to see the ${all.length} declared rule(s).\n`,
    );
    return { ok: false };
  }
  rules = rules.filter((r) => wanted.includes(r.id));
  rejected = rejected.filter((r) => wanted.includes(r.id));
  return { ok: true, rules, rejected };
}

/** `  ✗ [policy] pk-x — REJECTED: <why>` — one line per merge-seam-rejected rule. */
function writeRejectedRules(rejected: readonly (IGateRuleResult & { readonly type: GatePlane })[]): void {
  for (const r of rejected) process.stdout.write(`  ✗ [${r.type}] ${r.id}  REJECTED — ${r.error ?? 'failed validation'}\n`);
}


/**
 * Build the registries the doc-reference plane resolves against — only when a
 * rule of that plane is actually in scope.
 *
 * Every other plane reads files; this one reads shrk's own registries, which
 * cost a workspace inspection. Paying that on every `gates coverage` in a repo
 * with no doc-reference rules would be a tax on the common case.
 */
async function inspectionIfNeeded(
  cwd: string,
  rules: readonly IGateRuleView[],
): Promise<ISharkcraftInspection | undefined> {
  if (!rules.some((r) => r.plane === 'doc-reference')) return undefined;
  // Playbook / construct ids come from a cache an ASYNC load populates; the
  // resolver is sync. Warming here is what makes a correct pack playbook cited
  // in prose actually resolve.
  const inspection = await inspectSharkcraft({ cwd });
  // WITH the command resolver, so a doc-reference rule resolving `command`
  // ids checks them against the live command index.
  await warmCliReferenceRegistries(inspection);
  return inspection;
}

export const gatesListCommand: ICommandHandler = {
  name: 'list',
  description: 'Every data-defined rule across every plane, with its severity and empty-match policy.',
  usage: 'shrk gates list [--plane wiring|policy|registry|registration|baseline|generated] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const rules = planes.planes
      ? prep.value.rules.filter((r) => planes.planes!.has(r.plane))
      : prep.value.rules;
    const rejected = planes.planes
      ? prep.value.rejectedRules.filter((r) => planes.planes!.has(r.type))
      : prep.value.rejectedRules;
    if (rules.length === 0 && rejected.length === 0) return writeNoRules(json);

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          total: rules.length,
          rules: rules.map((r) => ({
            id: r.id,
            plane: r.plane,
            description: r.description ?? null,
            severity: r.severity,
            failOnEmpty: r.failOnEmpty,
            selfTest: r.selfTest ?? null,
          })),
          // Declared by a pack, refused by the merge seam: they never run.
          rejected: rejected.map((r) => ({ id: r.id, plane: r.type, error: r.error ?? null })),
          diagnostics: prep.value.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`Gate rules (${rules.length})`));
    for (const plane of GATE_PLANES) {
      const inPlane = rules.filter((r) => r.plane === plane);
      if (inPlane.length === 0) continue;
      process.stdout.write(`\n${plane} (${inPlane.length})\n`);
      for (const r of inPlane) {
        const flags = [
          r.severity === 'warning' ? 'warning' : undefined,
          r.failOnEmpty ? 'failOnEmpty' : undefined,
          r.selfTest ? 'selfTest' : undefined,
        ].filter(Boolean);
        process.stdout.write(`  • ${r.id}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}\n`);
        if (r.description) process.stdout.write(`      ${r.description}\n`);
      }
    }
    if (rejected.length > 0) {
      process.stdout.write(`\nrejected at the pack-plane merge seam — never run (${rejected.length})\n`);
      writeRejectedRules(rejected);
    }
    for (const d of prep.value.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    process.stdout.write('\nRun `shrk gates coverage` to see what each one actually matches.\n');
    return ExitCode.VerifiedPass;
  },
};

export const gatesCoverageCommand: ICommandHandler = {
  name: 'coverage',
  description:
    'What every rule MATCHED against the live tree — the stale-selector detector. A rule matching 0 files/ids is a bug in the rule, never a pass. Also runs each rule\'s declared selfTest expectations.',
  usage:
    'shrk gates coverage [--plane <p>] [--changed-only | --since <ref>] [--only <ids>] [--fail-on-dead-units] [--strict] [--json]',
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-cache', FAIL_ON_DEAD_UNITS_FLAG]),
  flags: new Set([...GATES_FLAGS, ...COVERAGE_ONLY_FLAGS]),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const filtered = filterRules(prep.value.rules, planes.planes, flagString(args, 'only'), prep.value.rejectedRules);
    if (!filtered.ok) return ExitCode.UsageError;
    // A rule the merge seam rejected is a configured rule that never ran — it
    // is never "no rules declared", and it is never narrowed out by scope.
    const rejected = filtered.rejected;
    if (filtered.rules.length === 0 && rejected.length === 0) {
      return writeNoRulesVerdict('gates coverage', args, json, false);
    }

    // Scoping the STALE-SELECTOR check to the diff is what moves it from a
    // CI-only report to something you can afford on every save — a stale glob
    // is then caught the moment you cause it, not the next morning.
    const scope = resolveScope(args, prep.value.cwd);
    if (scope.error) {
      process.stderr.write(`Cannot scope to the changeset: ${scope.error}\n`);
      return ExitCode.UsageError;
    }
    const { selected, skippedByScope } = narrowToScope(filtered.rules, scope.files);
    if (selected.length === 0 && rejected.length === 0) {
      // Nothing in scope means nothing was PROVEN — never a green.
      const emptyEnv = buildGateEnvelope('gates coverage', ExitCode.VerifiedPass, [], {
        unit: 'rules',
        expected: 0,
        examined: 0,
        reason: `no rule's footprint intersects the changeset (${skippedByScope} skipped by scope)`,
      });
      if (json) {
        process.stdout.write(
          asJson({
            schema: 'sharkcraft.gate-coverage/v1',
            rules: [],
            total: 0,
            scoped: true,
            skippedByScope,
            exitCode: emptyEnv.exit,
            gate: emptyEnv,
          }) + '\n',
        );
      } else {
        process.stdout.write(header('Gate-rule coverage'));
        process.stdout.write(
          `  No rule's footprint intersects the changeset (${skippedByScope} skipped by scope).\n` +
            '  Nothing was checked — this is NOT a pass.\n',
        );
      }
      return emptyEnv.exit;
    }
    const rules = selected;

    const report = withRejectedRules(
      buildGateCoverage(
        prep.value.cwd,
        rules,
        prep.value.excludeDirs,
        prep.value.extractors,
        false,
        await inspectionIfNeeded(prep.value.cwd, rules),
      ),
      rejected,
    );
    const failOnDeadUnits = flagBool(args, FAIL_ON_DEAD_UNITS_FLAG);
    // A rule that matched nothing is NOT-VERIFIED (2) by default — it neither
    // passed nor failed, it never ran. `failOnEmpty` on the rule (or the global
    // --strict promotion) turns that into a hard failure, as does a dead glob
    // under --fail-on-dead-units. Settle first, render second: a rule that is
    // connected but only PARTIALLY is `partial` here exactly as it is in
    // `gates check`. `settleGateCoverage` is the ONE derivation — `shrk
    // quality`'s coverage item reads the same one.
    const env = settleGateCoverage(report, { failOnDeadUnits });
    const exit = env.exit;
    const softEmpty = report.rules.filter((r) => r.status === 'empty' && !r.failOnEmpty);

    if (json) {
      process.stdout.write(
        asJson({
          ...report,
          // Rules the settled envelope fails (errored, broken selfTest, a
          // failOnEmpty rule matching nothing, a dead glob under the flag).
          hardFailures: env.failed,
          failOnDeadUnits,
          ...(scope.files ? { scoped: true, skippedByScope } : {}),
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Gate-rule coverage'));
    process.stdout.write(
      kv('rules', `${report.total}${skippedByScope > 0 ? ` (${skippedByScope} skipped by scope)` : ''}`) + '\n',
    );
    if (scope.files) {
      process.stdout.write(kv('scope', `changed-only (${scope.files.length} file(s))`) + '\n');
    }
    // A rule its own negations emptied is not a stale-selector suspect, so the
    // header counts it apart — agreeing with the row it draws below.
    const emptiedByNegations = report.rules.filter(
      (r) => r.status === 'empty' && r.excludedByNegations !== undefined,
    ).length;
    const staleSuspects = report.empty - emptiedByNegations;
    const emptyNote =
      report.empty === 0
        ? ''
        : emptiedByNegations === 0
          ? '  ← stale selector suspects'
          : staleSuspects === 0
            ? '  ← emptied by their own negations, not stale'
            : `  ← ${staleSuspects} stale selector suspect(s), ${emptiedByNegations} emptied by their own negations`;
    process.stdout.write(kv('matched nothing', `${report.empty}${emptyNote}`) + '\n');
    if (report.errored > 0) process.stdout.write(kv('misconfigured', String(report.errored)) + '\n');
    if (report.expectationFailures > 0) {
      process.stdout.write(kv('broken selfTest', String(report.expectationFailures)) + '\n');
    }
    if (report.deadGlobCount > 0) {
      process.stdout.write(
        kv(
          'dead globs',
          `${report.deadGlobCount}  ← inside rules that still match something` +
            (failOnDeadUnits ? ` (--${FAIL_ON_DEAD_UNITS_FLAG}: failing)` : ''),
        ) + '\n',
      );
    }
    // The shared extractors, ONCE. Their whole value is that N consumers cannot
    // disagree about which set they check — so one line proving the shared set
    // is live and non-empty covers all N.
    if (report.extractors.length > 0) {
      process.stdout.write('\n  shared extractors\n');
      for (const e of report.extractors) {
        const mark = e.error ? '!' : e.idsMatched === 0 ? '✗' : '✓';
        process.stdout.write(
          `  ${mark} $use:${e.id}  —  ${e.idsMatched} ids across ${e.filesMatched} file(s), ` +
            `shared by ${e.consumers.length} rule(s): ${e.consumers.join(', ')}\n`,
        );
        if (e.sampleIds.length > 0) process.stdout.write(`      e.g. ${e.sampleIds.join(', ')}\n`);
        if (e.error) process.stdout.write(`      ! ${e.error}\n`);
        if (!e.error && e.idsMatched === 0) {
          process.stdout.write(
            '      matched nothing — every consumer of this extractor is checking an empty set\n',
          );
        }
      }
    }
    process.stdout.write('\n');
    for (const [i, r] of report.rules.entries()) {
      // The settled status: `partial` is derived by the envelope builder alone.
      const settled = env.rules[i];
      const partial = settled?.status === 'partial';
      const failedSettled = settled?.status === 'failed' || settled?.status === 'error';
      const mark = partial
        ? '~'
        : failedSettled
          ? '✗'
          : r.status === 'ok'
            ? reportsDeadGlobs(r) || coverageWentLiveUnits(r).some((u) => u.mark?.packageName === undefined)
              ? '⚠'
              : '✓'
            : r.status === 'empty'
              ? '–'
              : '✗';
      process.stdout.write(
        `  ${mark} [${r.plane}] ${r.id}${r.viaExtractor ? ` (via $use:${r.viaExtractor})` : ''}` +
          `  —  ${r.unitsMatched} ${r.unitLabel} across ${r.filesMatched} file(s)\n`,
      );
      if (partial && settled?.shortfall) {
        process.stdout.write(`      PARTIAL — ${settled.shortfall}\n`);
      }
      // One glob of a connected rule matching nothing is the rename that
      // silently halves a rule while its siblings keep it green. A rule
      // already reported as matching nothing gets no second line for it.
      if (reportsDeadGlobs(r)) {
        const dead = coverageDeadUnits(r);
        process.stdout.write(`      ⚠ ${dead.length} of ${r.globsChecked} glob(s) dead: ${formatDeadUnits(dead)}\n`);
      }
      // Round 13: a glob marked `expectEmpty` whose target now exists — the
      // fence went live. The ✓ is withheld (a LOCAL marker is a stale
      // assertion; `--fail-on-dead-units` fails it); a PACK marker reads as
      // INFO, never a failure — the consumer cannot edit it.
      for (const u of coverageWentLiveUnits(r)) {
        process.stdout.write(
          `      ${u.mark?.packageName !== undefined ? 'i' : '⚠'} ${formatUnitLiveness(u, { causes: false })}\n`,
        );
      }
      // …and the globs it asserts are intended-empty, each as its ONE per-unit
      // line (`formatUnitLiveness`) under a neutral bullet — never a ✓: the ✓
      // and the acceptance belong to `verdictLine`, which prints them only at
      // exit 0 (a FAILED or SKIPPED rule's marked unit is no acceptance).
      for (const u of (r.unitLiveness ?? []).filter((x) => x.state === UnitLivenessState.IntendedEmpty)) {
        process.stdout.write(`      · ${formatUnitLiveness(u, { causes: false })}\n`);
      }
      // A LIVE negation is load-bearing narrowing, not a warning: print what
      // it excludes, so the scope the rule does NOT measure is on the page.
      const negations = r.negations ?? [];
      if (negations.length > 0) process.stdout.write(`      excludes: ${formatNegations(negations)}\n`);
      if (r.sampleIds.length > 0) {
        process.stdout.write(`      e.g. ${r.sampleIds.join(', ')}\n`);
      }
      if (r.status === 'empty') {
        // A rule its own `!` emptied is not stale: its inclusion globs matched
        // files and every one was excluded as written. Say that, never "stale".
        const emptiedBy = r.excludedByNegations;
        process.stdout.write(
          emptiedBy !== undefined
            ? `      ${failedSettled ? 'FAILED' : 'SKIPPED'} — matched nothing after its own negations: ` +
                `every file its inclusion globs select is excluded (${formatNegations(emptiedBy)})\n`
            : r.emptyReason !== undefined
              ? // A fence over a DEAD input (round 13): the settle's own reason.
                `      ${failedSettled ? 'FAILED' : 'SKIPPED'} — ${r.emptyReason}\n`
              : `      ${failedSettled ? 'FAILED' : 'SKIPPED'} — matched nothing; the selector is probably stale\n`,
        );
        // When the engine knows WHY a correct zero-match is probably not what
        // the author meant, say so here rather than leaving them to rediscover
        // it — this is the one dead end `import-edges` reliably produces.
        if (r.hint) process.stdout.write(`      → ${r.hint}\n`);
      }
      // A hint on a rule that DID match — e.g. a zoned pattern's blank-run
      // backtracking hazard (findBlankRunHazards) — is worth seeing before it bites.
      if (r.status !== 'empty' && r.hint) process.stdout.write(`      → ${r.hint}\n`);
      if (r.error) process.stdout.write(`      ! ${r.error}\n`);
      for (const f of r.expectationFailures) process.stdout.write(`      ! selfTest: ${f}\n`);
    }
    // The dead-selector causes ONCE, as a footer — the ⚠ rows above name each
    // dead unit without them, and `check boundaries` appends them to every
    // dead unit (round 13 review: they were printed nowhere here).
    if (report.rules.some(reportsDeadGlobs)) {
      process.stdout.write(`\n  Dead selectors: ${DEAD_SELECTOR_CAUSES}.\n`);
    }
    // THE empty-rule advice with each rule's REAL `fails` (the shared
    // renderer): a FAILING empty rule (failOnEmpty) was told nothing, and a
    // soft one only on a NOT VERIFIED run (the lead below carries it there).
    for (const a of emptyRuleAdviceLines([
      ...report.rules.filter((r) => r.status === 'empty' && r.failOnEmpty).map(() => ({ fails: true })),
      ...(exit === ExitCode.NotVerified ? [] : softEmpty.map(() => ({ fails: false }))),
    ])) {
      process.stdout.write(`\n  ${a}.\n`);
    }
    // THE empty-rule advice (round 13) — one sentence on every plane verb; a
    // soft-empty rule is told how to make it fail, a marker how to say "planned".
    const lead =
      exit === ExitCode.NotVerified && softEmpty.length > 0
        ? `${softEmpty.length} rule(s) matched nothing — NOT a pass. ${formatEmptyRuleAdvice({ fails: false })}.`
        : undefined;
    // "Every rule is connected" is only the whole truth when no glob inside a
    // connected rule is dead and no LOCAL `expectEmpty` marker went live —
    // otherwise the clean line says so (the ✓ is withheld). A pack marker that
    // went live is INFO: the consumer cannot edit it.
    const localWentLive = report.rules.reduce(
      (n, r) => n + coverageWentLiveUnits(r).filter((u) => u.mark?.packageName === undefined).length,
      0,
    );
    const stale = [
      ...(report.deadGlobCount > 0
        ? [`${report.deadGlobCount} glob(s) inside connected rules select or exclude nothing`]
        : []),
      ...(localWentLive > 0 ? [`${localWentLive} expectEmpty unit(s) went live — remove the markers`] : []),
    ];
    const clean =
      stale.length > 0
        ? `Every rule is connected to something, but ${stale.join(', and ')} (⚠ above).\n` +
          `  Fix them — or pass --${FAIL_ON_DEAD_UNITS_FLAG} to make a dead or went-live unit fail the run.`
        : 'Every rule is connected to something. ✓';
    const line = verdictLine(env, clean, lead);
    if (line) process.stdout.write(`\n${line}\n`);
    if (exit === ExitCode.Failure && failOnDeadUnits && stale.length > 0) {
      process.stdout.write(`\n${stale.join('; ')} — and --${FAIL_ON_DEAD_UNITS_FLAG} is set — FAILED.\n`);
    }
    return exit;
  },
};


export const gatesCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Run EVERY data-defined rule plane\'s violation check in one pass — one exit code, one JSON envelope. The CI / pre-commit primitive. Distinct from `gates coverage` (are the rules still connected) and `shrk quality` (the whole pre-PR bundle).',
  usage:
    'shrk gates check [--plane <p>] [--only <ids>] [--changed-only | --since <ref>] [--no-spawn] [--allow-empty] [--strict] [--json]',
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-spawn', 'no-cache', ALLOW_EMPTY_FLAG]),
  flags: new Set([...GATES_FLAGS, ...CHECK_ONLY_FLAGS]),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const filtered = filterRules(prep.value.rules, planes.planes, flagString(args, 'only'), prep.value.rejectedRules);
    if (!filtered.ok) return ExitCode.UsageError;
    // A pack rule the merge seam rejected is a configured rule that did NOT run
    // (round 12 review, R12-X1): an ERRORED row in the results and the run
    // coverage — never dropped with an advisory `!` line under a ✓. Scope never
    // narrows it out: it has no footprint, and a broken config is broken
    // whatever changed.
    const rejected = filtered.rejected;
    if (filtered.rules.length === 0 && rejected.length === 0) {
      return writeNoRulesVerdict('gates check', args, json, true);
    }

    const scope = resolveScope(args, prep.value.cwd);
    if (scope.error) {
      process.stderr.write(`Cannot scope to the changeset: ${scope.error}\n`);
      return ExitCode.UsageError;
    }
    const { selected, skippedByScope } = narrowToScope(filtered.rules, scope.files);

    const noSpawn = flagBool(args, 'no-spawn');
    const planeRun =
      selected.length === 0
        ? { results: [], diagnostics: [] }
        : runGatePlanes(selected, {
            cwd: prep.value.cwd,
            excludeDirs: prep.value.excludeDirs,
            ...(scope.files ? { changedFiles: scope.files } : {}),
            ...(noSpawn ? { noSpawn: true } : {}),
            ...(await inspectionIfNeeded(prep.value.cwd, selected).then((i) =>
              i ? { inspection: i } : {},
            )),
          });
    const run = { ...planeRun, results: [...planeRun.results, ...rejected] };
    const inScope = selected.length + rejected.length;

    // Only an ERROR-severity failure blocks. A warning-severity rule reports
    // without failing, exactly as its own plane's verb does.
    //
    // `--strict` promotes those warnings to blocking — the documented switch for
    // a zero-warning CI. It reuses the established local meaning of `--strict`
    // (`shrk check --strict` already does exactly this) rather than inventing a
    // second severity model; the GLOBAL `--strict` promotion of not-verified
    // (`2` → `1`) is applied once in `runCli` and composes with this.
    const strict = flagBool(args, 'strict');
    const failedRules = run.results.filter((r) => r.status === 'failed' || r.status === 'error');
    const blocking = failedRules.filter((r) => strict || r.severity === 'error');
    const failedWarnings = failedRules.filter((r) => r.severity !== 'error');
    // An ERRORED rule proved nothing — it never reached a subject. It is
    // therefore not `evaluated`, whatever its severity; otherwise a
    // warning-severity rule that could not run exits 0 with a green banner,
    // which is the silent-green this engine exists to prevent.
    const evaluated = run.results.filter(
      (r) => r.status !== 'skipped' && r.status !== 'error',
    ).length;
    const skipped = run.results.length - evaluated;
    // Exit must match the banner. Two kinds of "didn't run" are NOT the same
    // thing, and conflating them breaks the surface either way:
    //   • skipped BY SCOPE — the user asked for the narrowing (`--changed-only`),
    //     so the rules outside it are deliberately out of the question. Failing
    //     here would make a pre-commit hook exit non-zero on every commit.
    //   • skipped BY ACCIDENT — a selector matched nothing, or --no-spawn
    //     dropped the drift half. Nobody asked for that, and it is exactly the
    //     silent-green this engine exists to prevent, so it is `2`.
    // Matches `check wiring --changed-only`, which draws the same line.
    //
    // An EMPTY selection (no rule's footprint intersects the changeset)
    // proposes 0 and lets the run coverage decide: expected 0 is a shortfall
    // (2) unless --allow-empty accepted it. Proposing 2 here would make the
    // valve unreachable on exactly the case it exists for.
    const proposed =
      blocking.length > 0
        ? ExitCode.Failure
        : (evaluated === 0 && selected.length > 0) || skipped > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;
    // Settle first, render second. The envelope is built for text AND JSON; a
    // rule that passed over part of its scope (a subset wiring rule whose
    // declared selector never produced some registered tokens) is `partial`, so
    // the run is NOT verified — the scope-narrowed rules are out of `expected`,
    // exactly as they are out of the question.
    const unexamined = run.results
      .filter((r) => r.status === 'skipped' || r.status === 'error')
      .map((r) => r.id);
    const env: IGateEnvelope = buildGateEnvelope('gates check', proposed, run.results, {
      unit: 'rules',
      expected: inScope,
      examined: evaluated,
      ...(unexamined.length > 0 ? { unexamined, reason: 'checked nothing or could not run' } : {}),
      ...(inScope === 0
        ? { reason: `no rule's footprint intersects the changeset (${skippedByScope} skipped by scope)` }
        : {}),
      ...allowEmptyValve(args, inScope),
    });
    const exit = env.exit;

    const diagnostics = [...run.diagnostics, ...prep.value.planeDiagnostics];
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          configured: filtered.rules.length + rejected.length,
          // Pack rules the merge seam refused — errored rows in `gate.rules`.
          rejected: rejected.length,
          selected: selected.length,
          evaluated,
          skipped,
          skippedByScope,
          ...(scope.files ? { scoped: true, changedFiles: scope.files.length } : {}),
          noSpawn,
          strict,
          failed: blocking.length,
          failedWarnings: failedWarnings.length,
          verdict: exit === ExitCode.Failure ? 'errors' : exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
          diagnostics,
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Gate check — every rule plane'));
    // Round 13 (K6): a rule accepted as intended-empty examined 0 files — the
    // printed count is the envelope's (`gate.evaluated`, which leaves it out)
    // and the accepted rules are named apart. The local `evaluated` keeps
    // counting them for the run coverage and the "nothing ran" proposal above.
    process.stdout.write(
      kv('evaluated', `${env.evaluated} of ${filtered.rules.length + rejected.length}` +
        acceptedEmptyNote(env.acceptedEmpty) +
        (skippedByScope > 0 ? ` (${skippedByScope} skipped by scope)` : '') +
        (rejected.length > 0 ? ` (${rejected.length} rejected at the pack-plane merge seam — NOT evaluated)` : '')) + '\n',
    );
    if (scope.files) {
      process.stdout.write(kv('scope', `changed-only (${scope.files.length} file(s))`) + '\n');
    }
    if (noSpawn) process.stdout.write(kv('mode', '--no-spawn — shell-executing checks skipped') + '\n');
    process.stdout.write(
      kv(
        'violations',
        `${blocking.length} blocking rule(s), ${failedWarnings.length} warning rule(s)` +
          (strict && failedWarnings.length > 0 ? '  — --strict: warnings block' : ''),
      ) + '\n\n',
    );

    // THE shared unit-state block (round 13, K2) — the plane verbs' own: a dead
    // unit of a rule that still matched, a LOCAL expectEmpty marker whose
    // target appeared (its row reads ⚠, the ✓ is withheld, the exit is
    // unchanged), a pack marker as INFO.
    const unitNotes = unitStateNotes(planeRun.noteRows ?? []);
    // Rendered from the SETTLED rules, so `partial` and its shortfall show in
    // text exactly as they do in `--json`.
    for (const plane of GATE_PLANES) {
      const inPlane = env.rules.filter((r) => r.type === plane);
      if (inPlane.length === 0) continue;
      for (const r of inPlane) {
        const mark =
          r.status === 'passed'
            ? unitNotes.staleIds.has(r.id)
              ? '⚠'
              : '✓'
            : r.status === 'partial'
              ? '~'
              : r.status === 'skipped'
                ? '–'
                : r.severity === 'error'
                  ? '✗'
                  : '!';
        const counts = Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ');
        process.stdout.write(`  ${mark} [${plane}] ${r.id}${counts ? `  (${counts})` : ''}\n`);
        if (r.status === 'skipped' && r.skipReason) {
          process.stdout.write(`      SKIPPED — ${r.skipReason}\n`);
        }
        // A failOnEmpty rule that matched nothing FAILS with no violation to
        // list, so its reason is the only line that says why.
        if (r.status === 'failed' && r.skipReason && r.violations.length === 0) {
          process.stdout.write(`      FAILED — ${r.skipReason}\n`);
        }
        if (r.status === 'partial' && r.shortfall) {
          process.stdout.write(`      PARTIAL — ${r.shortfall}\n`);
        }
        if (r.error) process.stdout.write(`      ! ${r.error}\n`);
        for (const v of r.violations.slice(0, 10)) {
          const at = v.file ? `  (${v.file}${v.line !== undefined ? `:${v.line}` : ''})` : '';
          process.stdout.write(`      • ${v.id}${at}${v.message ? ` — ${v.message}` : ''}\n`);
        }
        if (r.violations.length > 10) {
          process.stdout.write(`      … (${r.violations.length - 10} more)\n`);
        }
        const hint = r.violations.find((v) => v.hint)?.hint;
        if (hint && r.violations.length > 0) process.stdout.write(`      → ${hint}\n`);
      }
    }
    for (const d of diagnostics) process.stdout.write(`  ! ${d}\n`);
    process.stdout.write(unitNotes.text);

    if (strict && failedWarnings.length > 0 && exit === ExitCode.Failure) {
      process.stdout.write(
        `\n${failedWarnings.length} warning rule(s) reported findings and --strict promoted them to failures.\n`,
      );
    }
    // The final line comes from the SETTLED verdict only. A warning-severity
    // rule reports without blocking, but the banner must still say it FIRED —
    // "everything passed" next to a printed violation is the kind of half-truth
    // that trains people to stop reading the output.
    if (rejected.length > 0) {
      process.stdout.write(
        `\n${rejected.length} pack rule(s) failed validation at the pack-plane merge seam and never ran — FAILED.\n` +
          '  Fix the pack (or override the rule locally); `shrk packs contributions` names every rejected entry.\n',
      );
    }
    // A dead unit or a LOCAL went-live marker listed above withholds the ✓ (K2).
    const clean = qualifyCleanForUnits(
      inScope === 0
        ? 'Nothing in scope — accepted.'
        : failedWarnings.length > 0
          ? `No blocking violations, but ${failedWarnings.length} warning rule(s) reported findings.` +
            (skippedByScope > 0 ? `\n(${skippedByScope} rule(s) outside the changeset were not run)` : '')
          : skippedByScope > 0
            ? `Every rule in scope passed. ✓  (${skippedByScope} outside the changeset were not run)`
            : 'Every declared rule ran and passed. ✓',
      unitNotes,
    );
    // A rule its own negations emptied is not a stale selector — its SKIPPED
    // line says so, and the lead must not send the reader to fix a selector
    // that is fine (round 12 review, R12-DOC-2).
    const emptiedByOwn = run.results.filter(
      (r) => r.status === 'skipped' && (r.skipReason ?? '').includes('its own negations'),
    ).length;
    const lead =
      proposed === ExitCode.NotVerified && skipped > 0
        ? `${skipped} rule(s) in scope checked NOTHING — this is not a pass.\n` +
          (emptiedByOwn === skipped
            ? 'Each was emptied by its own negations (see SKIPPED above) — not a stale selector.'
            : `Run \`shrk gates coverage\` to see which selectors are stale` +
              (emptiedByOwn > 0 ? ` (${emptiedByOwn} emptied by their own negations are not).` : '.'))
        : undefined;
    const line = verdictLine(env, clean, lead);
    if (line) process.stdout.write(`\n${line}\n`);
    if (inScope === 0 && exit === ExitCode.NotVerified) {
      process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset explicitly.\n`);
    }
    return exit;
  },
};

/**
 * The "no rules declared" landing for a VERDICT verb: the same explanation as
 * {@link writeNoRules}, settled through the envelope so the JSON carries `gate`
 * and the exit is `2` — unless the verb honours `--allow-empty` and it was
 * passed, in which case the acceptance is printed.
 */
function writeNoRulesVerdict(
  verb: 'gates check' | 'gates coverage',
  args: ParsedArgs,
  json: boolean,
  honoursAllowEmpty: boolean,
): number {
  const env = buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
    unit: 'rules',
    expected: 0,
    examined: 0,
    reason: 'no data-defined rules are declared (on the selected plane)',
    ...(honoursAllowEmpty ? allowEmptyValve(args, 0) : {}),
  });
  if (json) {
    process.stdout.write(
      asJson({ schema: SCHEMA, rules: [], total: 0, exitCode: env.exit, gate: env }) + '\n',
    );
    return env.exit;
  }
  writeNoRules(false);
  process.stdout.write(`\n${verdictLine(env, 'Nothing declared — accepted.')}\n`);
  if (honoursAllowEmpty && env.exit !== ExitCode.VerifiedPass) {
    process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty rule set explicitly.\n`);
  }
  return env.exit;
}


/**
 * Parse `--wiring 'declared=<glob>:<pattern> registered=<glob>:<pattern>'`.
 *
 * The glob/pattern split is at the FIRST colon: a project-relative POSIX glob
 * never contains one, while a regex often does (`name: '(\w+)'`). Splitting at
 * the last colon turned such a pattern's prefix into the glob, which then
 * matched 0 files — the exact dead end this REPL exists to prevent. `flags`
 * (from `--flags`) applies to BOTH sides, so an anchored inline pattern
 * compiles exactly as the same rule does from config (`flags: 'm'`) — one
 * source shape, one compile path.
 */
function parseInlineWiring(spec: string, flags?: string): { rule?: IWiringRule; error?: string } {
  const sides = new Map<string, { files: string[]; match: string }>();
  // Split on whitespace that precedes a `<side>=`, so a glob may contain none.
  for (const part of spec.trim().split(/\s+(?=(?:declared|registered)=)/)) {
    const eq = part.indexOf('=');
    if (eq === -1) return { error: `"${part}" is not <side>=<glob>:<pattern>` };
    const side = part.slice(0, eq).trim();
    if (side !== 'declared' && side !== 'registered') {
      return { error: `unknown side "${side}" — use declared= or registered=` };
    }
    const rest = part.slice(eq + 1);
    const colon = rest.indexOf(':');
    if (colon <= 0) return { error: `"${side}=" needs <glob>:<pattern>` };
    sides.set(side, { files: [rest.slice(0, colon)], match: rest.slice(colon + 1) });
  }
  const declared = sides.get('declared');
  const registered = sides.get('registered');
  if (!declared || !registered) {
    return { error: 'both declared=<glob>:<pattern> and registered=<glob>:<pattern> are required' };
  }
  const toSource = (side: { files: string[]; match: string }): IWiringSource => ({
    files: side.files,
    extract: 'regex-capture',
    pattern: side.match,
    ...(flags !== undefined && flags.length > 0 ? { flags } : {}),
  });
  return {
    rule: { id: '(try)', declared: toSource(declared), registered: toSource(registered) },
  };
}

/** True when `pattern` holds a `^` or `$` outside a character class (an escape skips the next char). */
function hasLineAnchor(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '^' || ch === '$') return true;
  }
  return false;
}

/**
 * Advisory notes on a candidate's patterns. A `^`/`$` anchor without the `m`
 * flag matches only at the start/end of the whole FILE (every engine compiles
 * with `g` plus exactly the flags the rule spells) — the "0 matches" that sends
 * an author off rewriting a correct pattern. Config and the dry-run behave the
 * same way; the note says how to spell the flag on each.
 */
function anchorNotes(view: IGateRuleView, inline: boolean): string[] {
  const how = inline ? 'pass --flags m' : "spell flags: 'm' on it, as a config rule would";
  const notes: string[] = [];
  const check = (label: string, pattern: string | undefined, flags: string | undefined): void => {
    if (pattern === undefined || !hasLineAnchor(pattern) || (flags ?? '').includes('m')) return;
    notes.push(`${label}: /${pattern}/ has a ^/$ anchor but no m flag, so it matches only at file start/end — ${how}`);
  };
  for (const { label, source } of gateRuleLabeledSources(view)) check(label, source.pattern, source.flags);
  if (view.plane === 'policy') {
    const rule = view.raw as IPolicyRule;
    check('pattern', rule.pattern, rule.flags);
  }
  return notes;
}

/** The `selfTest` summary `gates try --json` carries, for every plane. */
function selfTestPayload(cov: IGateCoverage, declared: boolean): Record<string, unknown> {
  const checks = cov.selfTestChecks ?? [];
  return {
    declared,
    evaluated: checks.length > 0 && checks.every((c) => c.status !== 'not-evaluable'),
    held: checks.filter((c) => c.status === 'held').length,
    failed: checks.filter((c) => c.status === 'failed').length,
    notEvaluable: checks.filter((c) => c.status === 'not-evaluable').length,
    checks,
    failures: cov.expectationFailures,
    consulted: cov.consulted,
  };
}

/** The `selfTest` block of `gates try`: EVERY expectation with its result, from the one evaluator. */
function writeSelfTestBlock(ruleId: string, cov: IGateCoverage, declared: boolean): void {
  const checks = cov.selfTestChecks ?? [];
  if (!declared) {
    process.stdout.write(
      `\n  selfTest: none declared — once the rule is in config, \`shrk gates scaffold-selftest ${ruleId}\` writes one from what it matches.\n`,
    );
    return;
  }
  if (checks.length === 0) {
    process.stdout.write('\n  selfTest: declared with no expectations — it asserts nothing.\n');
    return;
  }
  const failed = checks.filter((c) => c.status === 'failed').length;
  const unmeasured = checks.filter((c) => c.status === 'not-evaluable').length;
  process.stdout.write(
    `\n  selfTest (${checks.length} expectation(s)` +
      (failed > 0 ? `, ${failed} FAILED` : '') +
      (unmeasured > 0 ? `, ${unmeasured} NOT evaluable` : '') +
      '):\n',
  );
  for (const c of checks) {
    const tag = c.status === 'held' ? 'held         ' : c.status === 'failed' ? 'FAILED       ' : 'NOT EVALUABLE';
    process.stdout.write(`    ${tag}  ${c.field}: ${c.message}\n`);
  }
}

function writeNotes(notes: readonly string[]): void {
  for (const n of notes) process.stdout.write(`\n  note: ${n}\n`);
}

/**
 * The dry-run's final line, from its SETTLED verdict: a failure says what
 * broke, a not-verified run names what it did not examine, and only a clean
 * run gets the clean sentence.
 */
function writeTryVerdict(settled: ISettledVerdict, cov: IGateCoverage, lead?: string): void {
  // Round 13: the text prints the selector units its `--json` already carries
  // — the rule-authoring REPL is exactly where a planned glob gets written, so
  // a dead glob, a went-live marker or an accepted planned unit is never
  // silent here.
  const dead = reportsDeadGlobs(cov) ? coverageDeadUnits(cov) : [];
  if (dead.length > 0) {
    process.stdout.write(`\n  ⚠ ${dead.length} of ${cov.globsChecked} glob(s) dead: ${formatDeadUnits(dead)}\n`);
    // The causes ONCE, as a footer — exactly as `gates coverage` prints them.
    process.stdout.write(`    Dead selectors: ${DEAD_SELECTOR_CAUSES}.\n`);
  }
  const wentLive = coverageWentLiveUnits(cov);
  for (const u of wentLive) {
    process.stdout.write(`  ${u.mark?.packageName !== undefined ? 'i' : '⚠'} ${formatUnitLiveness(u, { causes: false })}\n`);
  }
  // Each intended-empty unit as its ONE per-unit line under a neutral bullet —
  // never a ✓: the ✓ and the acceptance belong to `verdictLine` (exit 0 only),
  // so a FAILED or SKIPPED candidate never reads "asserted empty ✓".
  for (const u of (cov.unitLiveness ?? []).filter((x) => x.state === UnitLivenessState.IntendedEmpty)) {
    process.stdout.write(`  · ${formatUnitLiveness(u, { causes: false })}\n`);
  }
  if (settled.exit === ExitCode.Failure) {
    const why =
      cov.status === 'error'
        ? `the candidate is misconfigured: ${cov.error ?? 'it could not run'}`
        : `${cov.expectationFailures.length} selfTest expectation(s) failed (listed above)`;
    process.stdout.write(`\n  FAILED — ${why}.\n`);
  }
  // "Connected over everything" is only the whole truth when no glob inside
  // the candidate is dead and no marker went live.
  const stale = [
    ...(dead.length > 0 ? [`${dead.length} glob(s) inside it select or exclude nothing`] : []),
    ...(wentLive.length > 0 ? [`${wentLive.length} expectEmpty unit(s) went live`] : []),
  ];
  const clean =
    stale.length > 0
      ? `The candidate is connected, but ${stale.join(' and ')} (⚠ above) — fix them before adding it to config.`
      : (cov.selfTestChecks ?? []).length > 0
        ? 'The candidate is connected over everything it was asked to examine, and every selfTest expectation held.'
        : 'The candidate is connected over everything it was asked to examine.';
  const line = verdictLine(settled, clean, lead);
  if (line) process.stdout.write(`\n  ${line.split('\n').join('\n  ')}\n`);
}

export const gatesTryCommand: ICommandHandler = {
  name: 'try',
  description:
    "Dry-run a rule spec against the live tree WITHOUT adding it to config — the rule-authoring REPL. Prints the resolved sets and the diff, and evaluates the candidate's selfTest with the SAME evaluator `gates coverage` uses (exit 1 when an expectation fails), so a selector is tightened before it is committed.",
  usage:
    "shrk gates try --rule-file <rule.json> [--plane <p>] [--full | --limit N] | --wiring 'declared=<glob>:<pat> registered=<glob>:<pat>' [--flags <f>] [--json]",
  booleanFlags: new Set(['json', 'full']),
  flags: new Set([...GATES_FLAGS, ...TRY_ONLY_FLAGS]),
  async run(args: ParsedArgs): Promise<number> {
    // `--flags` with no value (or an empty one) would otherwise be dropped in
    // silence: the run goes ahead with no flags, looking as if it took them.
    const flagsRaw = args.flags.get('flags');
    if (flagsRaw === true || flagsRaw === '') {
      process.stderr.write('--flags needs a value, e.g. --flags m\n');
      return ExitCode.UsageError;
    }
    const ruleFile = flagString(args, 'rule-file') ?? args.positional[0];
    const inline = flagString(args, 'wiring');
    const inlineFlags = flagString(args, 'flags');
    if (!ruleFile && !inline) {
      process.stderr.write(
        'Usage: shrk gates try --rule-file <rule.json> [--plane <p>] [--full | --limit N]\n' +
          "       shrk gates try --wiring 'declared=<glob>:<pat> registered=<glob>:<pat>' [--flags <f>]\n" +
          '  Runs the extraction, evaluates the selfTest and prints the resolved sets — config is never touched.\n' +
          '    --full       dump the WHOLE extracted set (default: first 5)\n' +
          '    --limit N    dump the first N\n' +
          '    --flags <f>  regex flags for BOTH inline patterns (m: a ^/$ anchor matches per line)\n',
      );
      return ExitCode.UsageError;
    }
    // A flag that changes nothing must never look like a satisfied request: a
    // --rule-file spells `flags` per source, exactly as config does.
    if (inlineFlags !== undefined && !inline) {
      process.stderr.write(
        "--flags applies to the inline --wiring form only; a --rule-file spells `flags: '<f>'` on each source, as config does.\n",
      );
      return ExitCode.UsageError;
    }

    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    // A candidate may `$use` the project's shared extractors, so the real
    // config is loaded for its `extractors` map (and for nothing else — no
    // declared rule is read, and nothing is written).
    const loaded = await resolveProjectConfig(cwd);
    const extractors = loaded.ok ? (loaded.value.config.extractors ?? {}) : {};
    const excludeDirs = loaded.ok ? planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir) : [];

    let raw: unknown;
    let plane: GatePlane = 'wiring';
    if (inline) {
      const parsed = parseInlineWiring(inline, inlineFlags);
      if (parsed.error) {
        process.stderr.write(`Invalid --wiring spec: ${parsed.error}\n`);
        return ExitCode.UsageError;
      }
      raw = parsed.rule;
    } else {
      if (!existsSync(ruleFile!)) {
        process.stderr.write(`Rule file not found: ${ruleFile}\n`);
        return ExitCode.UsageError;
      }
      try {
        raw = JSON.parse(readFileSync(ruleFile!, 'utf8'));
      } catch (e) {
        process.stderr.write(`${ruleFile} is not valid JSON: ${(e as Error).message}\n`);
        return ExitCode.UsageError;
      }
      const planes = parsePlanes(args);
      if (!planes.ok) return ExitCode.UsageError;
      const explicit = planes.planes ? [...planes.planes][0] : undefined;
      const inferred = explicit ?? inferPlane(raw);
      if (!inferred) {
        process.stderr.write(
          'Could not infer the plane from the rule shape. Pass --plane wiring|policy|registry|registration|baseline|generated.\n',
        );
        return ExitCode.UsageError;
      }
      plane = inferred;
    }

    // Validate with the SAME schema the loader uses, so a spec that passes here
    // is a spec that will load — the point of the REPL is that what you see is
    // what you get once you paste it in.
    const schema = PLANE_SCHEMAS[plane];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const summary = (parsed.error?.issues ?? [])
        .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
        .join('; ');
      if (json) process.stdout.write(asJson({ schema: SCHEMA, plane, valid: false, error: summary }) + '\n');
      else process.stderr.write(`Invalid ${plane} rule: ${summary}\n`);
      return ExitCode.UsageError;
    }

    // Normalise the candidate's markable lists exactly as the loader does
    // (round 13, `normalizePlaneRule`): plain string lists plus the
    // `expectEmptyUnits` ledger, so a planned `{ pattern, expectEmpty: true }`
    // unit is judged here as it will be once pasted into config.
    const normalizedCandidate = normalizePlaneRule(plane, parsed.data);
    if (!normalizedCandidate.ok) {
      const summary = normalizedCandidate.error.message;
      if (json) process.stdout.write(asJson({ schema: SCHEMA, plane, valid: false, error: summary }) + '\n');
      else process.stderr.write(`Invalid ${plane} rule: ${summary}\n`);
      return ExitCode.UsageError;
    }
    const candidate = normalizedCandidate.value;
    // Resolve `$use` exactly as the loader would, so a candidate referencing a
    // shared extractor is tried against the real shared definition.
    const planeKey = PLANE_CONFIG_KEY[plane];
    const resolved = resolvePlaneExtractors({ [planeKey]: [candidate] }, extractors);
    if (resolved.errors.length > 0) {
      const summary = resolved.errors.map((e) => e.message).join('; ');
      if (json) process.stdout.write(asJson({ schema: SCHEMA, plane, valid: false, error: summary }) + '\n');
      else process.stderr.write(`Unresolvable extractor reference: ${summary}\n`);
      return ExitCode.UsageError;
    }
    // …and judged on its MERGED shape, as the loader judges a local rule (THE
    // post-resolution check, core) — a candidate that would fail config load is
    // refused here, never tried as "misconfigured" (round 12 review, R12-X3).
    const mergedProblems = validateResolvedPlaneSources(resolved);
    if (mergedProblems.length > 0) {
      const summary = mergedProblems.map((p) => `${p.path} ${p.message}`).join('; ');
      if (json) process.stdout.write(asJson({ schema: SCHEMA, plane, valid: false, error: summary }) + '\n');
      else process.stderr.write(`Invalid ${plane} rule: ${summary}\n`);
      return ExitCode.UsageError;
    }
    const resolvedByKey = resolved as unknown as Record<string, readonly unknown[] | undefined>;
    const rule = resolvedByKey[planeKey]?.[0] ?? candidate;

    // The candidate's view comes from the ONE normaliser the loader's rules go
    // through, so severity, failOnEmpty and selfTest mean here exactly what
    // they will mean once the rule is pasted into config. A hand-built view
    // was how the dry-run discarded `selfTest` without a word.
    const view = collectGateRules({ [planeKey]: [rule] } as IGatePlanes)[0];
    if (!view) {
      process.stderr.write(`The candidate did not normalise to a ${plane} rule.\n`);
      return ExitCode.UsageError;
    }
    const inspection = await inspectionIfNeeded(cwd, [view]);
    // What the candidate MATCHED, and its selfTest — through the same plane
    // adapters and the same evaluator `gates coverage` runs.
    const cov = buildGateCoverage(cwd, [view], excludeDirs, extractors, true, inspection).rules[0]!;
    const declared = view.selfTest !== undefined;
    const notes = anchorNotes(view, inline !== undefined);
    // A broken selfTest, or a candidate that cannot run, fails the dry-run.
    // Violations do NOT: finding them is the rule doing its job.
    const broken = cov.status === 'error' || cov.status === 'failed-expectation';

    // The wiring plane already has a BOTH-SIDES explainer (resolved declared
    // set, resolved registered set, and the set-difference between them) — the
    // exact view an author tightening a selector needs. Reuse it rather than
    // printing a second, thinner one that could disagree with `gates explain`.
    if (plane === 'wiring') {
      const explain = explainWiring(cwd, rule as IWiringRule, { excludeDirs });
      // An empty side means the selector proved nothing — not a pass — unless
      // the empty result is the INTENDED one (round 13: every source-side glob
      // marked `expectEmpty`, accepted by the one settle). A partial candidate
      // settles to 2 on the engine's own coverage, the guard every verdict verb
      // uses; the candidate's `expectEmpty` acceptance joins it (the one fold,
      // `ruleVerdictRecords`), so it is printed at exit 0.
      const acceptedEmpty =
        cov.emptiness === RuleEmptiness.IntendedEmpty || cov.emptiness === RuleEmptiness.AssertedEmptyOutput;
      const emptySide =
        !acceptedEmpty && (explain.declared.distinctCount === 0 || explain.registered.distinctCount === 0);
      const settled = settleVerdict(
        broken ? ExitCode.Failure : emptySide ? ExitCode.NotVerified : ExitCode.VerifiedPass,
        // The engine's own acceptance (the explain now settles a planned rule
        // exactly as `check wiring` does); coverage's is the same claim.
        ruleVerdictRecords(explain.coverage, explain.unitAcceptance ?? cov.unitAcceptance),
      );
      if (json) {
        // The explain payload stays top-level (existing consumers keep
        // working); the selfTest and the settled outcome are additive keys.
        process.stdout.write(
          asJson({
            ...explain,
            selfTest: selfTestPayload(cov, declared),
            ...(notes.length > 0 ? { notes } : {}),
            exitCode: settled.exit,
            settled,
          }) + '\n',
        );
        return settled.exit;
      }
      renderWiringExplain(explain, false);
      writeSelfTestBlock(view.id, cov, declared);
      writeNotes(notes);
      process.stdout.write('\n  Nothing was written. Paste the rule into `wiringRules[]` to keep it.\n');
      writeTryVerdict(
        settled,
        cov,
        emptySide ? 'A side of the candidate matched nothing — it proved nothing.' : undefined,
      );
      return settled.exit;
    }

    // `noSpawn` is not a performance choice here: a `--rule-file` is arbitrary
    // JSON, and honouring a `regen` / `compute.run` from it would turn a
    // read-only preview into shell execution from an untrusted file.
    const run = runGatePlanes([view], {
      cwd,
      excludeDirs,
      noSpawn: true,
      ...(inspection ? { inspection } : {}),
    });
    const result = run.results[0];
    const allIds = cov.allIds ?? cov.sampleIds;
    // Settled over what the candidate matched AND what its check examined (a
    // skipped shell half, an unreadable ledger), so a dry-run never reads
    // clean over a half it did not examine.
    // What the candidate matched and what its check examined are often the
    // SAME gap (one unread file): settle over each distinct shortfall once, so
    // the NOT VERIFIED line does not repeat it.
    // Round 13: each side's `expectEmpty` acceptance joins its record (the one
    // fold, `ruleVerdictRecords`), and a record both sides carry — the same
    // acceptance, reached by coverage and by the plane check — is settled once.
    const seenRecord = new Set<string>();
    const tryCoverage = [
      ...ruleVerdictRecords(cov.coverage, cov.unitAcceptance),
      ...(result ? ruleVerdictRecords(result.coverage, result.unitAcceptance) : []),
    ].filter((c) => {
      const { subject: _subject, ...claim } = c;
      const key = JSON.stringify(claim);
      if (seenRecord.has(key)) return false;
      seenRecord.add(key);
      return true;
    });
    const settled = settleVerdict(
      broken ? ExitCode.Failure : cov.status === 'empty' ? ExitCode.NotVerified : ExitCode.VerifiedPass,
      tryCoverage.filter((c, i) => {
        const s = coverageShortfall(c);
        return s === undefined || tryCoverage.findIndex((d) => coverageShortfall(d) === s) === i;
      }),
    );

    if (json) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.gates-try/v1',
          plane,
          valid: true,
          coverage: cov,
          ...(cov.hint ? { hint: cov.hint } : {}),
          result: result ?? null,
          selfTest: selfTestPayload(cov, declared),
          ...(notes.length > 0 ? { notes } : {}),
          note: 'nothing was written — paste the rule into sharkcraft.config.ts to keep it',
          exitCode: settled.exit,
          settled,
        }) + '\n',
      );
      return settled.exit;
    }

    process.stdout.write(header(`gates try — candidate ${plane} rule "${view.id}"`));
    // `filesMatched` counts the files the rule READ: a glob-matched file over
    // the read cap is in the coverage line below, never in this count.
    process.stdout.write(kv('files read', String(cov.filesMatched)) + '\n');
    process.stdout.write(kv(cov.unitLabel, String(cov.unitsMatched)) + '\n');
    process.stdout.write(kv('coverage', formatCoverage(cov.coverage)) + '\n');
    if (cov.viaExtractor) process.stdout.write(kv('via extractor', `$use:${cov.viaExtractor}`) + '\n');
    // Tuning a selector against a large tree needs the WHOLE candidate set —
    // a five-item sample cannot tell you whether the tail is right.
    const full = flagBool(args, 'full');
    const limitRaw = flagString(args, 'limit');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
      process.stderr.write(`--limit must be a positive integer, got "${limitRaw}".\n`);
      return ExitCode.UsageError;
    }
    const shown = full ? allIds : allIds.slice(0, limit ?? 5);
    if (shown.length > 0) {
      const label = shown.length === allIds.length ? `all ${shown.length}` : `first ${shown.length} of ${allIds.length}`;
      process.stdout.write(`\n  extracted (${label}):\n`);
      for (const id of shown) process.stdout.write(`    ${id}\n`);
      if (shown.length < allIds.length) {
        process.stdout.write(`    … (${allIds.length - shown.length} more — re-run with --full)\n`);
      }
    }
    if (cov.error) process.stdout.write(`\n  ! ${cov.error}\n`);
    if (result) {
      process.stdout.write(
        `\n  would be: ${result.status}${result.violations.length > 0 ? ` (${result.violations.length} violation(s))` : ''}\n`,
      );
      for (const v of result.violations.slice(0, 20)) {
        const at = v.file ? `  (${v.file}${v.line !== undefined ? `:${v.line}` : ''})` : '';
        process.stdout.write(`    • ${v.id}${at}\n`);
      }
      if (result.violations.length > 20) {
        process.stdout.write(`    … (${result.violations.length - 20} more)\n`);
      }
    }
    writeSelfTestBlock(view.id, cov, declared);
    writeNotes(notes);
    if (cov.status === 'empty') {
      process.stdout.write(
        '\n  This selector matched NOTHING — tighten it before adding it to config.\n',
      );
      if (cov.hint) process.stdout.write(`  → ${cov.hint}\n`);
      process.stdout.write(
        `  Once pasted into config, \`gates coverage\` would exit ` +
          `${cov.failOnEmpty ? ExitCode.Failure : ExitCode.NotVerified} for it (failOnEmpty=${cov.failOnEmpty}).\n`,
      );
    }
    process.stdout.write('\n  Nothing was written. Paste the rule into sharkcraft.config.ts to keep it.\n');
    writeTryVerdict(
      settled,
      cov,
      cov.status === 'empty' ? 'The candidate matched nothing — it proved nothing.' : undefined,
    );
    return settled.exit;
  },
};

/**
 * Which config key each plane's rules live under, for `$use` resolution — THE
 * list beside the config schema (`GATE_PLANE_CONFIG_KEY`), never a CLI copy.
 */
const PLANE_CONFIG_KEY: Readonly<Record<GatePlane, string>> = GATE_PLANE_CONFIG_KEY;

/** Minimal structural view of a zod schema's `safeParse` — avoids a zod dep here. */
interface IPlaneSchema {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> };
  };
}

/** The loader's own schema for each plane — one validation, not a second one. */
const PLANE_SCHEMAS: Readonly<Record<GatePlane, IPlaneSchema>> = {
  wiring: WiringRuleSchema as IPlaneSchema,
  policy: PolicyRuleSchema as IPlaneSchema,
  registry: RegistryDeclarationSchema as IPlaneSchema,
  registration: RegistrationIdiomSchema as IPlaneSchema,
  baseline: BaselineRuleSchema as IPlaneSchema,
  generated: GeneratedArtifactRuleSchema as IPlaneSchema,
  'doc-reference': DocReferenceRuleSchema as IPlaneSchema,
};

/**
 * Infer a candidate's plane from its shape.
 *
 * Each plane has a field no other plane uses, so inference is exact rather than
 * a guess — and an ambiguous shape returns `undefined` so the author is asked
 * with `--plane` instead of being silently run on the wrong engine.
 */
function inferPlane(raw: unknown): GatePlane | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if ('generatedGlob' in o) return 'generated';
  if ('tokenPattern' in o && 'resolvesAs' in o) return 'doc-reference';
  if ('compute' in o) return 'baseline';
  if ('declared' in o && 'provided' in o && 'consumed' in o) return 'registration';
  if ('declared' in o || 'registered' in o || 'chain' in o) return 'wiring';
  if ('surface' in o && 'pattern' in o) return 'policy';
  if ('source' in o && 'name' in o) return 'registry';
  return undefined;
}

/**
 * THE unit-state block of the registry / registration explain views (round 13,
 * K6) — the block the wiring and policy explain views print, through the same
 * shared helper (`unitStateNotes`, each line `formatUnitLiveness`): a dead glob,
 * a LOCAL marker that went live, a pack marker (INFO) and every intended-empty
 * unit. The units are settled from THE per-rule request `gates coverage` builds
 * (`sourceLivenessRequest` over `gateRuleLabeledSources`), so the explain view
 * cannot name a unit's state differently from the coverage report.
 */
function writeExplainUnitStates(cwd: string, view: IGateRuleView, excludeDirs: readonly string[]): void {
  const settled = settleGlobLists(sourceLivenessRequest(cwd, gateRuleLabeledSources(view), excludeDirs, view.id));
  const unitLiveness = settled.units.filter((u) => u.state !== UnitLivenessState.Live);
  process.stdout.write(unitStateNotes([{ id: view.id, unitLiveness }], { intendedEmpty: true }).text);
}

/** Render a registry inventory as the trust-layer explain view. */
function explainRegistry(cwd: string, view: IGateRuleView, excludeDirs: readonly string[]): void {
  const decl = view.raw as IRegistryDeclaration;
  const inventory = scanRegistry(cwd, decl, { excludeDirs });
  const insp = inspectSource(cwd, decl.source, excludeDirs);
  if (decl.source.$use) process.stdout.write(kv('via extractor', `$use:${decl.source.$use}`) + '\n');
  process.stdout.write(kv('files scanned', String(insp.filesScanned)) + '\n');
  process.stdout.write(kv('ids', String(inventory.entries.length)) + '\n');
  for (const e of inventory.entries.slice(0, 60)) {
    process.stdout.write(`  • ${e.id}  (${e.sites.map((s) => `${s.file}:${s.line}`).join(', ')})\n`);
  }
  if (inventory.entries.length > 60) {
    process.stdout.write(`  … (${inventory.entries.length - 60} more)\n`);
  }
  for (const d of inventory.diagnostics) process.stdout.write(`  ! ${d}\n`);
  writeExplainUnitStates(cwd, view, excludeDirs);
}

/** Render the three sides of a registration idiom. */
function explainRegistration(cwd: string, view: IGateRuleView, excludeDirs: readonly string[]): void {
  const idiom = view.raw as IRegistrationIdiom;
  for (const [label, source] of [
    ['declared', idiom.declared],
    ['provided', idiom.provided],
    ['consumed', idiom.consumed],
  ] as const) {
    const insp = inspectSource(cwd, source, excludeDirs);
    process.stdout.write(
      kv(
        label,
        `${insp.ids.length} token(s) across ${insp.filesScanned} file(s)` +
          (source.$use ? `  (via $use:${source.$use})` : ''),
      ) + '\n',
    );
    if (insp.error) process.stdout.write(`      ! ${insp.error}\n`);
    for (const s of insp.sites.slice(0, 20)) {
      process.stdout.write(`      ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (insp.sites.length > 20) process.stdout.write(`      … (${insp.sites.length - 20} more)\n`);
  }
  writeExplainUnitStates(cwd, view, excludeDirs);
  process.stdout.write(
    `\n  Query one token's chain with \`shrk wiring chain <token>\`.\n`,
  );
}

export const gatesExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'The universal introspection: for a rule of ANY plane, print the concrete inputs it resolved — files matched, ids extracted with file:line, and the computed diff.',
  usage: 'shrk gates explain <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk gates explain <id> [--json]\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const matches = prep.value.rules.filter((r) => r.id === id);
    if (matches.length === 0) {
      process.stderr.write(
        `No gate rule "${id}". Run \`shrk gates list\` to see the ${prep.value.rules.length} declared rule(s).\n`,
      );
      return ExitCode.UsageError;
    }
    // An id may legitimately exist on two planes (a wiring rule and a registry
    // can share a name); `--plane` disambiguates instead of guessing.
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const candidates = planes.planes
      ? matches.filter((r) => planes.planes!.has(r.plane))
      : matches;
    if (candidates.length > 1) {
      process.stderr.write(
        `"${id}" exists on ${candidates.length} planes (${candidates.map((c) => c.plane).join(', ')}). ` +
          'Disambiguate with --plane <p>.\n',
      );
      return ExitCode.UsageError;
    }
    const view = candidates[0];
    if (!view) {
      process.stderr.write(`No gate rule "${id}" on the requested plane.\n`);
      return ExitCode.UsageError;
    }
    const json = flagBool(args, 'json');

    // The two shell-executing planes own their explain output (and their trust
    // rules), so delegate rather than re-implement — one behaviour, one place.
    if (view.plane === 'baseline') {
      args.flags.set('id', view.id);
      return baselineExplainCommand.run(args);
    }
    if (view.plane === 'generated') {
      args.flags.set('id', view.id);
      return generatedExplainCommand.run(args);
    }
    // The doc-reference plane owns its explain view too — it resolves against
    // registries, not file globs, so the generic source-based renderer below
    // has nothing to show for it.
    if (view.plane === 'doc-reference') {
      args.flags.set('id', view.id);
      return docsReferencesExplainCommand.run(args);
    }

    if (view.plane === 'wiring') {
      const explain = explainWiring(prep.value.cwd, view.raw as IWiringRule, {
        excludeDirs: prep.value.excludeDirs,
      });
      renderWiringExplain(explain, json);
      return ExitCode.VerifiedPass;
    }

    if (view.plane === 'policy') {
      const explain = runPolicyExplain(prep.value.cwd, view.raw as IPolicyRule, prep.value.excludeDirs);
      renderPolicyExplain(explain, json);
      return ExitCode.VerifiedPass;
    }

    if (json) {
      const source =
        view.plane === 'registry'
          ? (view.raw as IRegistryDeclaration).source
          : (view.raw as IRegistrationIdiom).declared;
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.gates-explain/v1',
          id: view.id,
          plane: view.plane,
          ...inspectSource(prep.value.cwd, source, prep.value.excludeDirs),
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`${view.plane} rule: ${view.id}`));
    if (view.description) process.stdout.write(`  ${view.description}\n`);
    if (view.plane === 'registry') {
      explainRegistry(prep.value.cwd, view, prep.value.excludeDirs);
    } else {
      explainRegistration(prep.value.cwd, view, prep.value.excludeDirs);
    }
    return ExitCode.VerifiedPass;
  },
};

/**
 * Try to explain `id` as a data-defined rule on ANY plane.
 *
 * Returns the exit code when the id resolves to exactly one declared rule, or
 * `undefined` when it is not a rule id at all — which lets `shrk explain` keep
 * its original topic-search behaviour for everything else. This is the D2
 * unification: a user holding a rule id no longer has to know which plane owns
 * it, and no existing invocation changes meaning.
 */
export async function tryExplainGateRule(
  args: ParsedArgs,
  id: string,
): Promise<number | undefined> {
  const cwd = resolveCwd(args);
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return undefined;
  const rules = collectGateRules(loaded.value.config);
  if (!rules.some((r) => r.id === id)) return undefined;
  const forwarded: ParsedArgs = { ...args, positional: [id] };
  return gatesExplainCommand.run(forwarded);
}

export const gatesScaffoldSelfTestCommand: ICommandHandler = {
  name: 'scaffold-selftest',
  description:
    "Generate a rule's `selfTest` from what it matches TODAY — the fixture the trust layer asks for, turned from a blank page into three lines to review. `--write` inserts it into sharkcraft.config.ts in place.",
  usage: 'shrk gates scaffold-selftest <ruleId> [--margin N] [--write] [--json]',
  booleanFlags: new Set(['json', 'write']),
  async run(args: ParsedArgs): Promise<number> {
    const ruleId = args.positional[0];
    if (!ruleId) {
      process.stderr.write('Usage: shrk gates scaffold-selftest <ruleId> [--margin N] [--write] [--json]\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const write = flagBool(args, 'write');
    const marginRaw = flagString(args, 'margin');
    const margin = marginRaw === undefined ? 20 : Number.parseInt(marginRaw, 10);
    if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
      process.stderr.write(`--margin must be a percentage in [0, 100), got "${marginRaw}".\n`);
      return ExitCode.UsageError;
    }

    const view = prep.value.rules.find((r) => r.id === ruleId);
    if (!view) {
      process.stderr.write(
        `No gate rule with id "${ruleId}". Run \`shrk gates list\` to see every declared rule.\n`,
      );
      return ExitCode.UsageError;
    }
    if (view.selfTest) {
      process.stderr.write(
        `Rule "${ruleId}" already declares a selfTest — refusing to overwrite an author's fixture. ` +
          'Delete it first if you mean to re-scaffold.\n',
      );
      return ExitCode.UsageError;
    }

    const report = buildGateCoverage(
      prep.value.cwd,
      [view],
      prep.value.excludeDirs,
      prep.value.extractors,
      true,
      await inspectionIfNeeded(prep.value.cwd, [view]),
    );
    const cov = report.rules[0]!;
    // Scaffolding from a rule that matches nothing would produce a selfTest
    // asserting the broken state — pinning the very bug the fixture exists to
    // catch. Fix the selector first.
    if (cov.status === 'error' || cov.unitsMatched === 0) {
      const why = cov.error ?? 'the rule currently matches nothing';
      if (json) {
        process.stdout.write(asJson({ schema: SCHEMA, ruleId, error: why }) + '\n');
      } else {
        process.stderr.write(
          `Cannot scaffold from "${ruleId}": ${why}.\n` +
            `  A selfTest built on an empty match set would pin the broken state as correct.\n` +
            `  Fix the selector first — \`shrk gates explain ${ruleId}\` shows what it resolved.\n`,
        );
      }
      return ExitCode.NotVerified;
    }

    // A count read off an incomplete scan (a file over the read cap, a role
    // that could not run) is not a measured number: a floor derived from it
    // pins a set that misses whatever the unexamined part holds. Refuse, and
    // refuse --write, naming the shortfall: NOT VERIFIED (2).
    const coverageRecord = { ...cov.coverage, subject: cov.coverage.subject ?? ruleId };
    if (coverageShortfall(coverageRecord) !== undefined) {
      const settled = settleVerdict(ExitCode.VerifiedPass, [coverageRecord]);
      if (json) {
        process.stdout.write(
          asJson({
            schema: SCHEMA,
            ruleId,
            error: 'not verified — what the rule matches today was not fully examined',
            shortfalls: settled.shortfalls,
            exitCode: settled.exit,
          }) + '\n',
        );
      } else {
        const lead =
          `Cannot scaffold from "${ruleId}": what it matches today was not fully examined, so ` +
          `${cov.unitsMatched} ${cov.unitLabel} is not a measured count.${write ? ' --write refused.' : ''}`;
        process.stdout.write(`${verdictLine(settled, '', lead)}\n`);
      }
      return settled.exit;
    }

    const scaffold = scaffoldSelfTest(cov, margin);

    let written: string | undefined;
    let writeError: string | undefined;
    if (write) {
      const configFile = prep.value.configFile;
      if (!configFile || !existsSync(configFile)) {
        writeError = 'no local sharkcraft.config.ts to write to';
      } else {
        const res = insertSelfTest(readFileSync(configFile, 'utf8'), ruleId, scaffold.snippet);
        if (!res.ok) writeError = res.error;
        else {
          writeFileSync(configFile, res.text!, 'utf8');
          written = configFile;
        }
      }
    }

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          ...scaffold,
          ...(written ? { written } : {}),
          ...(writeError ? { writeError } : {}),
        }) + '\n',
      );
      return writeError ? ExitCode.Failure : ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`Scaffolded selfTest — [${scaffold.plane}] ${ruleId}`));
    process.stdout.write(
      kv('matches now', `${scaffold.currentCount} ${cov.unitLabel}`) + '\n',
    );
    process.stdout.write(
      kv('floor', `${scaffold.expectMatchesAtLeast}  (${scaffold.marginPercent}% margin below the current count)`) + '\n',
    );
    process.stdout.write('\n');
    for (const line of scaffold.snippet.split('\n')) process.stdout.write(`  ${line}\n`);
    if (scaffold.note) process.stdout.write(`\n  note: ${scaffold.note}\n`);
    if (written) {
      process.stdout.write(`\n  wrote ${nodePath.relative(prep.value.cwd, written)} — review the diff before committing.\n`);
    } else if (writeError) {
      process.stdout.write(`\n  ! --write refused: ${writeError}\n`);
      process.stdout.write('  Paste the block above into the rule by hand.\n');
    } else {
      process.stdout.write('\n  Paste this into the rule, or re-run with --write to insert it.\n');
    }
    return writeError ? ExitCode.Failure : ExitCode.VerifiedPass;
  },
};

export const gatesCommand: ICommandHandler = {
  name: 'gates',
  description:
    'Rule-authoring trust layer: run every plane\'s violation check in one pass (`check`), list every data-defined rule, show what each one MATCHED (`coverage` — the stale-selector detector), explain any one of them, dry-run a candidate rule before adding it (`try`), and scaffold its selfTest (`scaffold-selftest`). Only `scaffold-selftest --write` ever touches config. Not `shrk gate`, singular, which runs the quality-gate pipeline.',
  usage:
    'shrk gates check | coverage | list | explain <id> | try --rule-file <f> | scaffold-selftest <id>',
  // Every subverb is a registered trie child; any other bare token is refused
  // by the dispatcher guard (closest match named) before this body runs — the
  // one unknown-subcommand authority. Only a bare `shrk gates` lands here.
  positionals: PositionalMode.None,
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-spawn']),
  async run(): Promise<number> {
    process.stderr.write(
      'Usage: shrk gates <subcommand>\n' +
        '  check     [--plane <p>] [--only <ids>] [--changed-only|--since <ref>] [--no-spawn]\n' +
        '            run EVERY plane\'s violation check — one exit code (the CI / pre-commit primitive)\n' +
        '  coverage  [--plane <p>] [--changed-only|--since <ref>] [--fail-on-dead-units] [--strict]\n' +
        '            what each rule MATCHED — the stale-selector detector (+ each selfTest, + dead globs)\n' +
        '  list      [--plane <p>]         every declared rule, with severity + empty-match policy\n' +
        '  explain   <id>                  the concrete inputs one rule resolved\n' +
        "  try       --rule-file <f> | --wiring 'declared=<g>:<p> registered=<g>:<p>' [--flags <f>]\n" +
        '            dry-run a candidate rule (and its selfTest) WITHOUT touching config\n' +
        '  scaffold-selftest <id> [--margin N] [--write]\n' +
        "            generate the rule's selfTest from what it matches today\n" +
        '(`shrk gate`, singular, runs the quality-gate pipeline — a different verb.)\n',
    );
    return ExitCode.UsageError;
  },
};
