/**
 * The ONE body behind `shrk check registry-lifecycle` and `shrk registry
 * lifecycle`.
 *
 * The two verbs used to carry copy-pasted bodies with two copies of the exit
 * ternary — both of which forgot the file cap, so a scan that examined 2000 of
 * 2103 candidates printed `missing removers 0` and exited 0 while a real
 * violation sat in the 103 it never read. Now both delegate here, the engine
 * owns the coverage records, and the exit is settled through the gate envelope
 * like every other verdict verb:
 *
 *   - a missing remover → `1` (a violation in the examined scope is real);
 *   - a cap, an expired budget, a signal, an over-budget / unreadable file,
 *     nothing in scope, or no registrations → `2`, with the continuation
 *     (`--offset <n>`) that actually reaches the remainder;
 *   - otherwise `0`;
 *   - a malformed flag → `3` with the usage line.
 */
import {
  renderRegistryLifecycleReportText,
  resolveChangedFiles,
  resolveProjectConfig,
  runRegistryLifecycleScan,
  type IRegistryLifecycleReport,
} from '@shrkcrft/inspector';
import { ERROR_CODES, type IVerdictCoverage } from '@shrkcrft/core';
import {
  firstUnknownFlag,
  flagBool,
  flagString,
  resolveCwd,
  spellFlagAsTyped,
  type ParsedArgs,
} from '../command-registry.ts';
import { GLOBAL_FLAGS } from '../dispatch/global-flags.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson } from '../output/format-output.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';

/** The two verbs this body answers for — the gate envelope's `verb`. */
type RegistryLifecycleVerb = 'check registry-lifecycle' | 'registry lifecycle';

/** The flag grammar both verbs share (one usage line, one allowlist). */
export const REGISTRY_LIFECYCLE_FLAGS_USAGE =
  '[--scope <dir>] [--changed-only] [--since <ref>] [--limit <n>] [--offset <n>] [--budget-ms <n>] [--allow-empty] [--json]';

/**
 * Every flag the verbs honour, plus every dispatcher global (THE list in
 * dispatch/global-flags.ts), which may reach the handler; anything else is a
 * typo that would otherwise read as a satisfied request.
 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'scope',
  'changed-only',
  'since',
  'limit',
  'offset',
  'budget-ms',
  ALLOW_EMPTY_FLAG,
  ...GLOBAL_FLAGS,
]);

function usage(verb: RegistryLifecycleVerb): string {
  return `Usage: shrk ${verb} ${REGISTRY_LIFECYCLE_FLAGS_USAGE}`;
}

/**
 * A non-negative integer flag. `undefined` when absent; an error string when
 * present but not an integer ≥ 0 (a bare `--limit`, `--limit abc`, `--limit -1`).
 */
function intFlag(args: ParsedArgs, name: string): number | undefined | { readonly error: string } {
  if (!args.flags.has(name)) return undefined;
  const raw = args.flags.get(name);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return { error: `--${name} needs a non-negative integer (got ${typeof raw === 'string' ? `"${raw}"` : 'no value'})` };
  }
  return Number(raw.trim());
}

/** One argument, shell-safe — a path with a space still pastes as one word. */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command a continuation re-runs: this verb plus every scoping flag the user passed. */
function continuationCommand(verb: RegistryLifecycleVerb, args: ParsedArgs): string {
  const parts = [`shrk ${verb}`];
  // main.ts lifts a global `--cwd` into `args.globalCwd` before the handler
  // runs (resolveCwd reads it there), so reading the flag alone dropped it —
  // and a continuation pasted from another directory paged the wrong root.
  const cwd = flagString(args, 'cwd') ?? args.globalCwd;
  if (cwd) parts.push(`--cwd ${shellArg(cwd)}`);
  const scope = flagString(args, 'scope');
  if (scope) parts.push(`--scope ${shellArg(scope)}`);
  if (flagBool(args, 'changed-only')) parts.push('--changed-only');
  const since = flagString(args, 'since');
  if (since) parts.push(`--since ${shellArg(since)}`);
  const limit = flagString(args, 'limit');
  if (limit) parts.push(`--limit ${limit}`);
  const budget = flagString(args, 'budget-ms');
  if (budget) parts.push(`--budget-ms ${budget}`);
  return parts.join(' ');
}

/** The one rule result: the lifecycle rule, judged over the registrations it found. */
function lifecycleRule(report: IRegistryLifecycleReport, coverage: IVerdictCoverage): IGateRuleResult {
  return {
    id: 'registry-lifecycle',
    type: 'lifecycle',
    status: report.missingRemovers.length > 0 ? 'failed' : 'passed',
    severity: 'error',
    counts: {
      candidates: report.totalFiles,
      filesScanned: report.filesScanned,
      registersFound: report.registersFound,
      matchedPairs: report.matchedPairs.length,
      missingRemovers: report.missingRemovers.length,
      oneShotBootstrap: report.oneShotBootstrap.length,
      ignored: report.ignored.length,
      overBudgetFiles: report.overBudgetFiles.length,
    },
    violations: report.missingRemovers.map((m) => ({
      id: m.registerName,
      file: m.file,
      line: m.line,
      message: `no ${m.expectedRemoverNames.slice(0, 3).join(' / ')}`,
      hint: m.suggestion,
    })),
    coverage,
  };
}

/**
 * The config-load row. An EXISTING sharkcraft.config.ts that failed to load
 * means the configured skip set was never applied: errored (never
 * `evaluated`), and its engine-owned coverage — 1 config file expected, 0
 * examined — settles a clean run to 2. `--allow-empty` cannot waive it
 * (expected is 1, not 0).
 */
function configRule(coverage: IVerdictCoverage): IGateRuleResult {
  return {
    id: 'config',
    type: 'lifecycle',
    status: 'error',
    severity: 'error',
    counts: {},
    violations: [],
    error: `sharkcraft.config.ts ${coverage.reason ?? 'failed to load'}`,
    coverage,
  };
}

/**
 * Install SIGTERM / SIGINT handlers that abort the scan for the duration of the
 * run. The JS thread yields between files, so a kill prints the partial report
 * (and the `--offset` that continues it) instead of zero bytes.
 */
function trapSignals(controller: AbortController): () => void {
  const onSignal = (): void => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}

/** Settle first, render second — one envelope for text and `--json`. */
function settle(
  verb: RegistryLifecycleVerb,
  report: IRegistryLifecycleReport,
  args: ParsedArgs,
): IGateEnvelope {
  const proposed = report.missingRemovers.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
  const rules = [
    lifecycleRule(report, {
      ...report.registrationCoverage,
      ...allowEmptyValve(args, report.registrationCoverage.expected),
    }),
    ...(report.configCoverage ? [configRule(report.configCoverage)] : []),
  ];
  const run: IVerdictCoverage = { ...report.coverage, ...allowEmptyValve(args, report.coverage.expected) };
  // Two literals, not one variable: the contract lock reads the literal FIRST
  // argument of every envelope build and asserts it is a registered verdict verb.
  return verb === 'registry lifecycle'
    ? buildGateEnvelope('registry lifecycle', proposed, rules, run)
    : buildGateEnvelope('check registry-lifecycle', proposed, rules, run);
}

/** The clean sentence — printed only through `verdictLine`, i.e. only at a settled 0. */
function cleanSentence(report: IRegistryLifecycleReport): string {
  const window =
    report.offset > 0
      ? ` (candidates ${report.offset + 1}–${report.totalFiles} of ${report.totalFiles}; earlier ones were not examined in this run)`
      : '';
  return (
    `No missing removers — ${report.registersFound} register* declaration(s) judged across ` +
    `${report.filesScanned} file(s)${window}. ✓`
  );
}

/**
 * The `--json` reason for the SETTLED verdict, derived from the envelope —
 * never the engine's pre-settlement one, which paired `verdict: 'pass'` (an
 * `--allow-empty` acceptance) with a not-verified reason.
 *
 *   - exit 0: the acceptance lines, or nothing;
 *   - exit 1: the engine's failure reason, plus any `also not verified: …`;
 *   - exit 2: the shortfalls.
 */
function settledReason(env: IGateEnvelope, report: IRegistryLifecycleReport): string | undefined {
  if (env.exit === ExitCode.VerifiedPass) return env.accepted.length > 0 ? env.accepted.join('; ') : undefined;
  if (env.exit === ExitCode.Failure) {
    const parts = [
      ...(report.verdict === 'fail' && report.verdictReason ? [report.verdictReason] : []),
      ...(env.shortfalls.length > 0 ? [`also not verified: ${env.shortfalls.join('; ')}`] : []),
    ];
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return env.shortfalls.length > 0 ? env.shortfalls.join('; ') : undefined;
}

/** True when every shortfall is an empty scope (so `--allow-empty` would clear it). */
function onlyEmptyShortfalls(report: IRegistryLifecycleReport): boolean {
  // A config that failed to load is never an empty scope: --allow-empty cannot clear it.
  if (report.configCoverage) return false;
  const c = report.coverage;
  if (c.capped) return false;
  const filesEmptyOrFull = c.expected === 0 || c.examined >= c.expected;
  return filesEmptyOrFull && (c.expected === 0 || report.registrationCoverage.expected === 0);
}

/**
 * Run a lifecycle scan for `verb`. `options.signal` is the in-process test seam
 * for SIGTERM / SIGINT: aborting it prints the partial report and exits `2`.
 */
export async function runRegistryLifecycle(
  args: ParsedArgs,
  verb: RegistryLifecycleVerb,
  options: { readonly signal?: AbortSignal } = {},
): Promise<number> {
  const json = flagBool(args, 'json');
  const badFlag = (error: string): number => {
    process.stderr.write(`${error}\n${usage(verb)}\n`);
    return ExitCode.UsageError;
  };
  // `--offset -1`: the parser reads `-1` as a flag of its own and leaves
  // `--offset` valueless. Report the malformed VALUE — what `intFlag` promises —
  // never an unknown `--1`.
  for (const name of ['limit', 'offset', 'budget-ms']) {
    const at = args.flags.get(name) === true ? (args.argv ?? []).indexOf(`--${name}`) : -1;
    const next = at >= 0 ? args.argv?.[at + 1] : undefined;
    if (next !== undefined && /^-\d/.test(next)) {
      return badFlag(`--${name} needs a non-negative integer (got "${next}")`);
    }
  }
  const unknown = firstUnknownFlag(args, KNOWN_FLAGS);
  if (unknown !== undefined) {
    process.stderr.write(`unknown option '${spellFlagAsTyped(unknown, args.argv)}'\n${usage(verb)}\n`);
    return ExitCode.UsageError;
  }
  const limit = intFlag(args, 'limit');
  if (typeof limit === 'object') return badFlag(limit.error);
  const offset = intFlag(args, 'offset');
  if (typeof offset === 'object') return badFlag(offset.error);
  const budgetMs = intFlag(args, 'budget-ms');
  if (typeof budgetMs === 'object') return badFlag(budgetMs.error);

  const cwd = resolveCwd(args);
  const scope = flagString(args, 'scope');
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  // `--changed-only` scopes the scan to the diff (tracked + untracked), so it
  // runs inline in seconds; the full-tree walk is bounded by the budget.
  let files: readonly string[] | undefined;
  if (changedOnly || since) {
    const changed = resolveChangedFiles({
      projectRoot: cwd,
      ...(since ? { since } : {}),
      ...(changedOnly && !since ? { includeWorktree: true } : {}),
    });
    files = changed.files;
  }
  // The full-tree walk honours the project's skip-dir config (skipDirsAdd
  // extends the defaults; skipDirs replaces them and is warned about).
  let skipDirs: readonly string[] | undefined;
  let skipDirsAdd: readonly string[] | undefined;
  let configLoadError: { readonly file: string | null; readonly message: string } | undefined;
  if (files === undefined) {
    const loaded = await resolveProjectConfig(cwd);
    if (loaded.ok) {
      skipDirs = loaded.value.config.registryLifecycle?.skipDirs;
      skipDirsAdd = loaded.value.config.registryLifecycle?.skipDirsAdd;
    } else if (loaded.error.code !== ERROR_CODES.SHARKCRAFT_FOLDER_NOT_FOUND) {
      // A config that EXISTS but failed to load is not "no config": the
      // configured skip set was never applied. The engine records it as a
      // coverage shortfall, so the run can never settle to 0 over a scope the
      // project did not ask for.
      const fullPath = loaded.error.details?.['fullPath'];
      configLoadError = { file: typeof fullPath === 'string' ? fullPath : null, message: loaded.error.message };
    }
    // Only the slow full-tree path needs the heartbeat (JSON keeps stdout clean).
    if (!json) {
      process.stderr.write('⏳ Scanning source for register*/remove* symmetry (bounded by a wall-clock budget)…\n');
    }
  }

  const controller = new AbortController();
  const forward = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forward, { once: true });
  const release = trapSignals(controller);
  let report: IRegistryLifecycleReport;
  try {
    report = await runRegistryLifecycleScan(
      {
        projectRoot: cwd,
        ...(files !== undefined ? { files } : {}),
        ...(scope ? { scope } : {}),
        ...(skipDirs ? { skipDirs } : {}),
        ...(skipDirsAdd ? { skipDirsAdd } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(configLoadError ? { configLoadError } : {}),
      },
      { signal: controller.signal },
    );
  } finally {
    release();
    options.signal?.removeEventListener('abort', forward);
  }

  // An offset past the last candidate is a typo'd continuation, not an empty
  // scope: refusing it keeps `--allow-empty` from printing ✓ over "candidates
  // 2103–2102 of 2102". Only once the walk completed — before that,
  // `totalFiles` is a lower bound.
  if (offset !== undefined && offset > 0 && report.walkComplete && offset >= report.totalFiles) {
    return badFlag(`--offset ${offset} is past the last candidate (${report.totalFiles} candidate(s) in scope)`);
  }

  const env = settle(verb, report, args);
  const exit = env.exit;
  if (json) {
    process.stdout.write(
      asJson({
        ...report,
        verdict: planeVerdictForExit(exit),
        // The reason for the SETTLED verdict (omitted when there is none) —
        // never the engine's pre-settlement one.
        verdictReason: settledReason(env, report),
        exitCode: exit,
        gate: env,
      }) + '\n',
    );
    return exit;
  }
  process.stdout.write(renderRegistryLifecycleReportText(report, { command: continuationCommand(verb, args) }));
  const lead =
    exit === ExitCode.NotVerified && onlyEmptyShortfalls(report)
      ? 'Nothing to judge in scope. Pass --allow-empty to accept an empty scope explicitly.'
      : undefined;
  const line = verdictLine(env, cleanSentence(report), lead);
  if (line) process.stdout.write(`\n${line}\n`);
  return exit;
}
