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
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
  IWiringSource,
} from '@shrkcrft/core';
import { resolvePlaneExtractors } from '@shrkcrft/core';
import { explainWiring, inspectSource, scanRegistry } from '@shrkcrft/boundaries';
import {
  BaselineRuleSchema,
  DocReferenceRuleSchema,
  GeneratedArtifactRuleSchema,
  PolicyRuleSchema,
  RegistrationIdiomSchema,
  RegistryDeclarationSchema,
  WiringRuleSchema,
} from '@shrkcrft/config';
import {
  inspectSharkcraft,
  warmReferenceRegistries,
  refExists,
  resolveChangedFiles,
  resolveProjectConfig,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { clearFileReadCache } from '@shrkcrft/boundaries';
import {
  firstUnknownFlag,
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';

import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import {
  collectGateRules,
  GATE_PLANES,
  type GatePlane,
  type IGateRuleView,
} from '../gates/gate-rule-view.ts';
import { buildGateCoverage } from '../gates/rule-coverage.ts';
import { buildGateEnvelope } from '../gates/gate-envelope.ts';
import { ruleTouchedBy } from '../gates/gate-rule-globs.ts';
import { runGatePlanes } from '../gates/run-gate-planes.ts';
import { baselineExplainCommand } from './baseline.command.ts';
import { generatedExplainCommand } from './generated.command.ts';
import { docsReferencesExplainCommand } from './docs-references.command.ts';
import { renderPolicyExplain, runPolicyExplain } from './policy-lint.command.ts';
import { renderWiringExplain } from './wiring.command.ts';

const SCHEMA = 'sharkcraft.gates/v1';

interface IPrepared {
  readonly cwd: string;
  readonly rules: readonly IGateRuleView[];
  readonly excludeDirs: string[];
  readonly planeDiagnostics: readonly string[];
  /** The config's named `extractors`, for the shared-extractor coverage view. */
  readonly extractors: Readonly<Record<string, IWiringSource>>;
}

async function prepare(
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
  const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
  return {
    ok: true,
    value: {
      cwd,
      rules: collectGateRules(loaded.value.config),
      excludeDirs: rel && !rel.startsWith('..') ? [rel] : [],
      planeDiagnostics: loaded.value.planeDiagnostics,
      extractors: loaded.value.config.extractors ?? {},
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
function resolveScope(
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
function narrowToScope(
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
  'cwd',
  'id',
  'rule-file',
  'wiring',
  'no-hints',
  'exit-trailer',
]);

/**
 * Reject an unrecognized flag rather than ignoring it.
 *
 * Without this a mistyped `--changed-only` parses as an unrelated `true`, the
 * verb runs its UNSCOPED form, and exit `0` reads as "the scoped check passed".
 * A flag the tool does not understand must never look like a satisfied request.
 */
function rejectUnknownFlags(args: ParsedArgs): number | undefined {
  const bad = firstUnknownFlag(args, GATES_FLAGS);
  if (bad === undefined) return undefined;
  process.stderr.write(
    `Unknown flag "--${bad}". \`shrk gates\` accepts: ` +
      `${[...GATES_FLAGS].filter((f) => f !== 'cwd' && f !== 'no-hints' && f !== 'exit-trailer').map((f) => `--${f}`).join(', ')}.\n`,
  );
  return ExitCode.UsageError;
}

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
): { ok: true; rules: readonly IGateRuleView[] } | { ok: false } {
  let rules = planes ? all.filter((r) => planes.has(r.plane)) : all;
  if (!only) return { ok: true, rules };
  const wanted = only.split(',').map((x) => x.trim()).filter(Boolean);
  const known = new Set(all.map((r) => r.id));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown rule id(s) in --only: ${unknown.join(', ')}. Run \`shrk gates list\` to see the ${all.length} declared rule(s).\n`,
    );
    return { ok: false };
  }
  rules = rules.filter((r) => wanted.includes(r.id));
  return { ok: true, rules };
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
  await warmReferenceRegistries(inspection);
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
    if (rules.length === 0) return writeNoRules(json);

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
    for (const d of prep.value.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    process.stdout.write('\nRun `shrk gates coverage` to see what each one actually matches.\n');
    return ExitCode.VerifiedPass;
  },
};

export const gatesCoverageCommand: ICommandHandler = {
  name: 'coverage',
  description:
    'What every rule MATCHED against the live tree — the stale-selector detector. A rule matching 0 files/ids is a bug in the rule, never a pass. Also runs each rule\'s declared selfTest expectations.',
  usage: 'shrk gates coverage [--plane <p>] [--changed-only | --since <ref>] [--only <ids>] [--strict] [--json]',
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-cache']),
  async run(args: ParsedArgs): Promise<number> {
    const flagReject = rejectUnknownFlags(args);
    if (flagReject !== undefined) return flagReject;
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const filtered = filterRules(prep.value.rules, planes.planes, flagString(args, 'only'));
    if (!filtered.ok) return ExitCode.UsageError;
    if (filtered.rules.length === 0) return writeNoRules(json);

    // Scoping the STALE-SELECTOR check to the diff is what moves it from a
    // CI-only report to something you can afford on every save — a stale glob
    // is then caught the moment you cause it, not the next morning.
    const scope = resolveScope(args, prep.value.cwd);
    if (scope.error) {
      process.stderr.write(`Cannot scope to the changeset: ${scope.error}\n`);
      return ExitCode.UsageError;
    }
    const { selected, skippedByScope } = narrowToScope(filtered.rules, scope.files);
    if (selected.length === 0) {
      // Nothing in scope means nothing was PROVEN — never a green.
      if (json) {
        process.stdout.write(
          asJson({
            schema: 'sharkcraft.gate-coverage/v1',
            rules: [],
            total: 0,
            scoped: true,
            skippedByScope,
            exitCode: ExitCode.NotVerified,
          }) + '\n',
        );
      } else {
        process.stdout.write(header('Gate-rule coverage'));
        process.stdout.write(
          `  No rule's footprint intersects the changeset (${skippedByScope} skipped by scope).\n` +
            '  Nothing was checked — this is NOT a pass.\n',
        );
      }
      return ExitCode.NotVerified;
    }
    const rules = selected;

    const report = buildGateCoverage(
      prep.value.cwd,
      rules,
      prep.value.excludeDirs,
      prep.value.extractors,
      false,
      await inspectionIfNeeded(prep.value.cwd, rules),
    );
    // A rule that matched nothing is NOT-VERIFIED (2) by default — it neither
    // passed nor failed, it never ran. `failOnEmpty` on the rule (or the global
    // --strict promotion) turns that into a hard failure.
    const hardFailures = report.rules.filter(
      (r) => r.status === 'error' || r.status === 'failed-expectation' || (r.status === 'empty' && r.failOnEmpty),
    );
    const softEmpty = report.rules.filter((r) => r.status === 'empty' && !r.failOnEmpty);
    const exit =
      hardFailures.length > 0
        ? ExitCode.Failure
        : softEmpty.length > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    if (json) {
      process.stdout.write(
        asJson({
          ...report,
          hardFailures: hardFailures.length,
          ...(scope.files ? { scoped: true, skippedByScope } : {}),
          exitCode: exit,
          gate: buildGateEnvelope(
            'gates coverage',
            exit,
            report.rules.map((r) => ({
              id: r.id,
              type: r.plane,
              status:
                r.status === 'ok'
                  ? ('passed' as const)
                  : r.status === 'empty'
                    ? r.failOnEmpty
                      ? ('failed' as const)
                      : ('skipped' as const)
                    : r.status === 'error'
                      ? ('error' as const)
                      : ('failed' as const),
              severity: r.failOnEmpty ? ('error' as const) : ('warning' as const),
              counts: { files: r.filesMatched, units: r.unitsMatched },
              violations: r.expectationFailures.map((f) => ({ id: r.id, message: f })),
              ...(r.status === 'empty' ? { skipReason: `matched 0 ${r.unitLabel}` } : {}),
              ...(r.error ? { error: r.error } : {}),
            })),
          ),
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
    process.stdout.write(
      kv('matched nothing', `${report.empty}${report.empty > 0 ? '  ← stale selector suspects' : ''}`) + '\n',
    );
    if (report.errored > 0) process.stdout.write(kv('misconfigured', String(report.errored)) + '\n');
    if (report.expectationFailures > 0) {
      process.stdout.write(kv('broken selfTest', String(report.expectationFailures)) + '\n');
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
    for (const r of report.rules) {
      const mark =
        r.status === 'ok' ? '✓' : r.status === 'empty' ? (r.failOnEmpty ? '✗' : '–') : '✗';
      process.stdout.write(
        `  ${mark} [${r.plane}] ${r.id}${r.viaExtractor ? ` (via $use:${r.viaExtractor})` : ''}` +
          `  —  ${r.unitsMatched} ${r.unitLabel} across ${r.filesMatched} file(s)\n`,
      );
      if (r.sampleIds.length > 0) {
        process.stdout.write(`      e.g. ${r.sampleIds.join(', ')}\n`);
      }
      if (r.status === 'empty') {
        process.stdout.write(
          `      ${r.failOnEmpty ? 'FAILED' : 'SKIPPED'} — matched nothing; the selector is probably stale\n`,
        );
        // When the engine knows WHY a correct zero-match is probably not what
        // the author meant, say so here rather than leaving them to rediscover
        // it — this is the one dead end `import-edges` reliably produces.
        if (r.hint) process.stdout.write(`      → ${r.hint}\n`);
      }
      if (r.error) process.stdout.write(`      ! ${r.error}\n`);
      for (const f of r.expectationFailures) process.stdout.write(`      ! selfTest: ${f}\n`);
    }
    if (exit === ExitCode.VerifiedPass) {
      process.stdout.write('\nEvery rule is connected to something. ✓\n');
    } else if (exit === ExitCode.NotVerified) {
      process.stdout.write(
        `\n${softEmpty.length} rule(s) matched nothing — NOT a pass. Fix the selector, or set \`failOnEmpty: true\`\n` +
          'once the rule is known to have real subjects (then this becomes a hard failure).\n',
      );
    }
    return exit;
  },
};


export const gatesCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Run EVERY data-defined rule plane\'s violation check in one pass — one exit code, one JSON envelope. The CI / pre-commit primitive. Distinct from `gates coverage` (are the rules still connected) and `shrk quality` (the whole pre-PR bundle).',
  usage:
    'shrk gates check [--plane <p>] [--only <ids>] [--changed-only | --since <ref>] [--no-spawn] [--strict] [--json]',
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-spawn', 'no-cache']),
  async run(args: ParsedArgs): Promise<number> {
    const flagReject = rejectUnknownFlags(args);
    if (flagReject !== undefined) return flagReject;
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const filtered = filterRules(prep.value.rules, planes.planes, flagString(args, 'only'));
    if (!filtered.ok) return ExitCode.UsageError;
    if (filtered.rules.length === 0) return writeNoRules(json);

    const scope = resolveScope(args, prep.value.cwd);
    if (scope.error) {
      process.stderr.write(`Cannot scope to the changeset: ${scope.error}\n`);
      return ExitCode.UsageError;
    }
    const { selected, skippedByScope } = narrowToScope(filtered.rules, scope.files);

    const noSpawn = flagBool(args, 'no-spawn');
    const run =
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
    const exit =
      blocking.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skipped > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    const diagnostics = [...run.diagnostics, ...prep.value.planeDiagnostics];
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          configured: filtered.rules.length,
          selected: selected.length,
          evaluated,
          skipped,
          skippedByScope,
          ...(scope.files ? { scoped: true, changedFiles: scope.files.length } : {}),
          noSpawn,
          strict,
          failed: blocking.length,
          failedWarnings: failedWarnings.length,
          verdict: blocking.length > 0 ? 'errors' : evaluated === 0 ? 'not-verified' : 'pass',
          diagnostics,
          exitCode: exit,
          gate: buildGateEnvelope('gates check', exit, run.results),
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Gate check — every rule plane'));
    process.stdout.write(
      kv('evaluated', `${evaluated} of ${filtered.rules.length}` +
        (skippedByScope > 0 ? ` (${skippedByScope} skipped by scope)` : '')) + '\n',
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

    for (const plane of GATE_PLANES) {
      const inPlane = run.results.filter((r) => r.type === plane);
      if (inPlane.length === 0) continue;
      for (const r of inPlane) {
        const mark =
          r.status === 'passed' ? '✓' : r.status === 'skipped' ? '–' : r.severity === 'error' ? '✗' : '!';
        const counts = Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ');
        process.stdout.write(`  ${mark} [${plane}] ${r.id}${counts ? `  (${counts})` : ''}\n`);
        if (r.status === 'skipped' && r.skipReason) {
          process.stdout.write(`      SKIPPED — ${r.skipReason}\n`);
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

    if (strict && failedWarnings.length > 0 && exit === ExitCode.Failure) {
      process.stdout.write(
        `\n${failedWarnings.length} warning rule(s) reported findings and --strict promoted them to failures.\n`,
      );
    } else if (exit === ExitCode.VerifiedPass && failedWarnings.length > 0) {
      // A warning-severity rule reports without blocking, but the banner must
      // still say it FIRED. "Everything passed" next to a printed violation is
      // the kind of half-truth that trains people to stop reading the output.
      process.stdout.write(
        `\nNo blocking violations, but ${failedWarnings.length} warning rule(s) reported findings.\n` +
          (skippedByScope > 0 ? `(${skippedByScope} rule(s) outside the changeset were not run)\n` : ''),
      );
    } else if (exit === ExitCode.VerifiedPass && skippedByScope === 0) {
      process.stdout.write('\nEvery declared rule ran and passed. ✓\n');
    } else if (exit === ExitCode.NotVerified) {
      process.stdout.write(
        `\n${skipped} rule(s) in scope checked NOTHING — this is not a pass.\n` +
          'Run `shrk gates coverage` to see which selectors are stale.\n',
      );
    } else if (skippedByScope > 0) {
      process.stdout.write(
        `\nEvery rule in scope passed. ✓  (${skippedByScope} outside the changeset were not run)\n`,
      );
    }
    return exit;
  },
};


/** Parse `--wiring 'declared=<glob>:<pattern> registered=<glob>:<pattern>'`. */
function parseInlineWiring(spec: string): { rule?: IWiringRule; error?: string } {
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
    const colon = rest.lastIndexOf(':');
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
  });
  return {
    rule: { id: '(try)', declared: toSource(declared), registered: toSource(registered) },
  };
}

export const gatesTryCommand: ICommandHandler = {
  name: 'try',
  description:
    'Dry-run a rule spec against the live tree WITHOUT adding it to config — the rule-authoring REPL. Prints the resolved sets and the diff, so a selector is tightened before it is committed.',
  usage:
    "shrk gates try --rule-file <rule.json> [--plane <p>] [--full | --limit N] | --wiring 'declared=<glob>:<pat> registered=<glob>:<pat>' [--json]",
  booleanFlags: new Set(['json', 'full']),
  async run(args: ParsedArgs): Promise<number> {
    const flagReject = rejectUnknownFlags(args);
    if (flagReject !== undefined) return flagReject;
    const ruleFile = flagString(args, 'rule-file') ?? args.positional[0];
    const inline = flagString(args, 'wiring');
    if (!ruleFile && !inline) {
      process.stderr.write(
        'Usage: shrk gates try --rule-file <rule.json> [--plane <p>] [--full | --limit N]\n' +
          "       shrk gates try --wiring 'declared=<glob>:<pat> registered=<glob>:<pat>'\n" +
          '  Runs the extraction and prints the resolved sets — config is never touched.\n' +
          '    --full       dump the WHOLE extracted set (default: first 5)\n' +
          '    --limit N    dump the first N\n',
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
    const excludeDirs = loaded.ok
      ? (() => {
          const rel = nodePath
            .relative(cwd, loaded.value.sharkcraftDir)
            .split(nodePath.sep)
            .join('/');
          return rel && !rel.startsWith('..') ? [rel] : [];
        })()
      : [];

    let raw: unknown;
    let plane: GatePlane = 'wiring';
    if (inline) {
      const parsed = parseInlineWiring(inline);
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

    // Resolve `$use` exactly as the loader would, so a candidate referencing a
    // shared extractor is tried against the real shared definition.
    const planeKey = PLANE_CONFIG_KEY[plane];
    const resolved = resolvePlaneExtractors({ [planeKey]: [parsed.data] }, extractors);
    if (resolved.errors.length > 0) {
      const summary = resolved.errors.map((e) => e.message).join('; ');
      if (json) process.stdout.write(asJson({ schema: SCHEMA, plane, valid: false, error: summary }) + '\n');
      else process.stderr.write(`Unresolvable extractor reference: ${summary}\n`);
      return ExitCode.UsageError;
    }
    const resolvedByKey = resolved as unknown as Record<string, readonly unknown[] | undefined>;
    const rule = resolvedByKey[planeKey]?.[0] ?? parsed.data;

    const view: IGateRuleView = {
      id: (rule as { id?: string; name?: string }).id ?? (rule as { name?: string }).name ?? '(try)',
      plane,
      severity: 'error',
      failOnEmpty: false,
      raw: rule as IGateRuleView['raw'],
    };

    // The wiring plane already has a BOTH-SIDES explainer (resolved declared
    // set, resolved registered set, and the set-difference between them) — the
    // exact view an author tightening a selector needs. Reuse it rather than
    // printing a second, thinner one that could disagree with `gates explain`.
    if (plane === 'wiring') {
      const explain = explainWiring(cwd, rule as IWiringRule, { excludeDirs });
      const code = renderWiringExplain(explain, json);
      if (!json) {
        process.stdout.write(
          '\n  Nothing was written. Paste the rule into `wiringRules[]` to keep it.\n',
        );
      }
      // An empty side means the selector proved nothing — not a pass.
      return explain.declared.distinctCount === 0 || explain.registered.distinctCount === 0
        ? ExitCode.NotVerified
        : code;
    }

    // The candidate's COVERAGE (what it matched) is the answer the author
    // needs, and the violation run tells them whether the rule would be green.
    const coverage = buildGateCoverage(
      cwd,
      [view],
      excludeDirs,
      extractors,
      true,
      await inspectionIfNeeded(cwd, [view]),
    );
    // `noSpawn` is not a performance choice here: a `--rule-file` is arbitrary
    // JSON, and honouring a `regen` / `compute.run` from it would turn a
    // read-only preview into shell execution from an untrusted file.
    const run = runGatePlanes([view], {
      cwd,
      excludeDirs,
      noSpawn: true,
      ...(await inspectionIfNeeded(cwd, [view]).then((i) => (i ? { inspection: i } : {}))),
    });
    const result = run.results[0];
    const cov = coverage.rules[0]!;
    const allIds = cov.allIds ?? cov.sampleIds;

    if (json) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.gates-try/v1',
          plane,
          valid: true,
          coverage: cov,
          ...(cov.hint ? { hint: cov.hint } : {}),
          result: result ?? null,
          note: 'nothing was written — paste the rule into sharkcraft.config.ts to keep it',
        }) + '\n',
      );
      return cov.status === 'empty' ? ExitCode.NotVerified : ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`gates try — candidate ${plane} rule "${view.id}"`));
    process.stdout.write(kv('files matched', String(cov.filesMatched)) + '\n');
    process.stdout.write(kv(cov.unitLabel, String(cov.unitsMatched)) + '\n');
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
    if (cov.status === 'empty') {
      process.stdout.write(
        '\n  This selector matched NOTHING — tighten it before adding it to config.\n',
      );
      if (cov.hint) process.stdout.write(`  → ${cov.hint}\n`);
    }
    process.stdout.write('\n  Nothing was written. Paste the rule into sharkcraft.config.ts to keep it.\n');
    return cov.status === 'empty' ? ExitCode.NotVerified : ExitCode.VerifiedPass;
  },
};

/** Which config key each plane's rules live under, for `$use` resolution. */
const PLANE_CONFIG_KEY: Readonly<Record<GatePlane, string>> = {
  wiring: 'wiringRules',
  policy: 'policyRules',
  registry: 'registries',
  registration: 'registrationGraph',
  baseline: 'baselines',
  generated: 'generatedArtifacts',
  'doc-reference': 'docReferences',
};

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

/** Render a registry inventory as the trust-layer explain view. */
function explainRegistry(cwd: string, decl: IRegistryDeclaration, excludeDirs: readonly string[]): void {
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
}

/** Render the three sides of a registration idiom. */
function explainRegistration(cwd: string, idiom: IRegistrationIdiom, excludeDirs: readonly string[]): void {
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
      explainRegistry(prep.value.cwd, view.raw as IRegistryDeclaration, prep.value.excludeDirs);
    } else {
      explainRegistration(prep.value.cwd, view.raw as IRegistrationIdiom, prep.value.excludeDirs);
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

export const gatesCommand: ICommandHandler = {
  name: 'gates',
  description:
    'Rule-authoring trust layer: run every plane\'s violation check in one pass (`check`), list every data-defined rule, show what each one MATCHED (`coverage` — the stale-selector detector), explain any one of them, and dry-run a candidate rule before adding it (`try`). Never writes config. Not `shrk gate`, singular, which runs the quality-gate pipeline.',
  usage: 'shrk gates check | coverage | list | explain <id> | try --rule-file <f>',
  booleanFlags: new Set(['json', 'strict', 'changed-only', 'no-spawn']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    process.stderr.write(
      (sub ? `Unknown subcommand "${sub}". ` : '') +
        'Usage: shrk gates <subcommand>\n' +
        '  check     [--plane <p>] [--only <ids>] [--changed-only|--since <ref>] [--no-spawn]\n' +
        '            run EVERY plane\'s violation check — one exit code (the CI / pre-commit primitive)\n' +
        '  coverage  [--plane <p>] [--changed-only|--since <ref>] [--strict]\n' +
        '            what each rule MATCHED — the stale-selector detector\n' +
        '  list      [--plane <p>]         every declared rule, with severity + empty-match policy\n' +
        '  explain   <id>                  the concrete inputs one rule resolved\n' +
        "  try       --rule-file <f> | --wiring 'declared=<g>:<p> registered=<g>:<p>'\n" +
        '            dry-run a candidate rule WITHOUT touching config\n' +
        '(`shrk gate`, singular, runs the quality-gate pipeline — a different verb.)\n',
    );
    return ExitCode.UsageError;
  },
};
