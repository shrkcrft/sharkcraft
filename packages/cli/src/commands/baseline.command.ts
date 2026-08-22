/**
 * `shrk baseline` — the committed-baseline drift engine.
 *
 *   shrk baseline list                      # every declared baseline
 *   shrk baseline check [--id X]            # recompute + diff vs committed
 *   shrk baseline diff  [--id X]            # human-readable +added/−removed (never fails)
 *   shrk baseline update [--id X]           # the explicit, reviewable bless step
 *   shrk baseline explain --id X            # what it will run/extract, without judging
 *
 * Rules come from `sharkcraft.config.ts baselines[]`. A `compute.kind:
 * "command"` baseline SPAWNS a shell command — which is why the pack-plane
 * merge seam (`resolveProjectConfig`) drops any pack-contributed baseline that
 * declares one. Everything reaching this command with a `run` therefore came
 * from the repo's OWN config, the same trust boundary `verificationCommands`
 * uses.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IBaselineRule } from '@shrkcrft/core';
import { failsWhenEmpty } from '@shrkcrft/core';
import {
  baselineCount,
  baselineFails,
  computeBaselineFromExtractor,
  diffBaseline,
  matchesAny,
  type IBaselineDiff,
} from '@shrkcrft/boundaries';
import { resolveChangedFiles, resolveProjectConfig } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { buildGateEnvelope } from '../gates/gate-envelope.ts';

const SCHEMA = 'sharkcraft.baseline/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Loaded rules + the merge notes, or a config-load failure. */
interface ILoadedBaselines {
  readonly rules: readonly IBaselineRule[];
  readonly planeDiagnostics: readonly string[];
  readonly sharkcraftDirRel: string;
}

async function loadBaselines(
  cwd: string,
): Promise<{ ok: true; value: ILoadedBaselines } | { ok: false; message: string }> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
  return {
    ok: true,
    value: {
      rules: loaded.value.config.baselines ?? [],
      planeDiagnostics: loaded.value.planeDiagnostics,
      sharkcraftDirRel: rel && !rel.startsWith('..') ? rel : '',
    },
  };
}

/** Narrow to `--id`, refusing an unknown id rather than silently selecting nothing. */
function selectRules(
  rules: readonly IBaselineRule[],
  id: string | undefined,
): { ok: true; rules: readonly IBaselineRule[] } | { ok: false; message: string } {
  if (!id) return { ok: true, rules };
  const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(rules.map((r) => r.id));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown baseline id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}`,
    };
  }
  return { ok: true, rules: rules.filter((r) => wanted.includes(r.id)) };
}

/** The current value of a baseline, recomputed from scratch. */
interface IComputed {
  readonly text: string;
  readonly error?: string;
  readonly filesScanned?: number;
}

function computeCurrent(cwd: string, rule: IBaselineRule, excludeDirs: readonly string[]): IComputed {
  if (rule.compute.kind === 'extractor') {
    const source = rule.compute.source;
    if (!source) return { text: '', error: 'compute.kind "extractor" but no `source` declared' };
    const res = computeBaselineFromExtractor(cwd, source, excludeDirs);
    return res.error
      ? { text: '', error: res.error, filesScanned: res.filesScanned }
      : { text: res.text, filesScanned: res.filesScanned };
  }
  const run = rule.compute.run;
  if (!run || run.trim() === '') {
    return { text: '', error: 'compute.kind "command" but no `run` declared' };
  }
  const child = spawnSync(run, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: rule.compute.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) return { text: '', error: `compute command failed to start: ${child.error.message}` };
  if (child.status !== 0) {
    const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return {
      text: '',
      error: `compute command exited ${child.status ?? 'null'}${tail ? ` — ${tail}` : ''}`,
    };
  }
  return { text: String(child.stdout ?? '') };
}

/** One rule's outcome, shared by check / diff / update. */
interface IBaselineOutcome {
  readonly rule: IBaselineRule;
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly diff?: IBaselineDiff;
  readonly committed?: string;
  readonly current?: string;
  readonly committedCount: number;
  readonly currentCount: number;
  readonly error?: string;
  readonly skipReason?: string;
  /** The recompute produced 0 entries while the baseline has some — likely a broken compute. */
  readonly emptyCompute?: boolean;
  /** No committed artifact exists yet — `committed` is absent, not zero. */
  readonly missingBaseline?: boolean;
}

function evaluateRule(
  cwd: string,
  rule: IBaselineRule,
  excludeDirs: readonly string[],
  changedFiles: readonly string[] | undefined,
): IBaselineOutcome {
  // --changed-only is honest about what it CANNOT scope: a command compute with
  // no `watchFiles` has no file footprint, so it is reported as skipped rather
  // than quietly passing.
  if (changedFiles !== undefined) {
    const globs =
      rule.watchFiles && rule.watchFiles.length > 0
        ? rule.watchFiles
        : rule.compute.kind === 'extractor'
          ? (rule.compute.source?.files ?? [])
          : undefined;
    if (globs === undefined) {
      return {
        rule,
        status: 'skipped',
        committedCount: 0,
        currentCount: 0,
        skipReason: 'command compute with no `watchFiles` cannot be scoped to a changeset',
      };
    }
    if (!changedFiles.some((f) => matchesAny(f, globs))) {
      return {
        rule,
        status: 'skipped',
        committedCount: 0,
        currentCount: 0,
        skipReason: 'no watched file changed',
      };
    }
  }

  const abs = nodePath.resolve(cwd, rule.baseline);
  if (!existsSync(abs)) {
    // No artifact yet. `check` must still fail (nothing to compare against),
    // but the CURRENT side is knowable and is exactly what the author needs to
    // see before blessing — so compute it rather than reporting a false `0`.
    const first = computeCurrent(cwd, rule, excludeDirs);
    return {
      rule,
      status: 'error',
      committedCount: 0,
      ...(first.error ? {} : { current: first.text }),
      currentCount: first.error ? 0 : baselineCount(rule, first.text),
      missingBaseline: true,
      error:
        first.error ??
        `committed baseline ${rule.baseline} does not exist — create it with \`shrk baseline update --id ${rule.id}\``,
    };
  }
  let committed: string;
  try {
    committed = readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      rule,
      status: 'error',
      committedCount: 0,
      currentCount: 0,
      error: `could not read ${rule.baseline}: ${(e as Error).message}`,
    };
  }

  const computed = computeCurrent(cwd, rule, excludeDirs);
  if (computed.error) {
    return { rule, status: 'error', committed, committedCount: 0, currentCount: 0, error: computed.error };
  }

  const committedCount = baselineCount(rule, committed);
  const currentCount = baselineCount(rule, computed.text);

  // A recompute that produced NOTHING compared nothing — and left as a pass it
  // would "match" an empty baseline forever, the silent-green this plane exists
  // to prevent. But this only holds when the COMMITTED side is empty too: if
  // the baseline has entries and the recompute has none, that is real drift
  // (everything vanished) and must be reported as such, not swallowed as a skip.
  if (currentCount === 0 && committedCount === 0) {
    return {
      rule,
      status: failsWhenEmpty(rule) ? 'failed' : 'skipped',
      committed,
      current: computed.text,
      committedCount,
      currentCount,
      skipReason: 'the recompute produced no entries (and the committed baseline is empty too)',
    };
  }

  const diff = diffBaseline(rule, committed, computed.text);
  return {
    rule,
    status: baselineFails(rule, diff) ? 'failed' : 'passed',
    diff,
    committed,
    current: computed.text,
    committedCount,
    currentCount,
    // A total wipe is far more often a broken compute than a real emptying —
    // say so next to the diff so it is not blessed by reflex.
    ...(currentCount === 0 ? { emptyCompute: true } : {}),
  };
}

function hintFor(rule: IBaselineRule): string {
  return rule.hint ?? `review the diff, then bless it with \`shrk baseline update --id ${rule.id}\``;
}

function outcomeJson(o: IBaselineOutcome): Record<string, unknown> {
  return {
    id: o.rule.id,
    ...(o.rule.description ? { description: o.rule.description } : {}),
    baseline: o.rule.baseline,
    severity: o.rule.severity ?? 'error',
    direction: o.rule.direction ?? 'two-way',
    status: o.status,
    committedCount: o.committedCount,
    currentCount: o.currentCount,
    ...(o.diff ? { diff: { added: o.diff.added, removed: o.diff.removed, mode: o.diff.mode, canonical: o.diff.canonical } } : {}),
    ...(o.error ? { error: o.error } : {}),
    ...(o.skipReason ? { skipReason: o.skipReason } : {}),
    ...(o.emptyCompute ? { emptyCompute: true } : {}),
    ...(o.missingBaseline ? { missingBaseline: true } : {}),
    hint: hintFor(o.rule),
  };
}

/** Print one outcome's ±diff, capped so a huge drift stays readable. */
function writeDiff(o: IBaselineOutcome, cap = 25): void {
  if (!o.diff) return;
  for (const a of o.diff.added.slice(0, cap)) process.stdout.write(`      + ${a}\n`);
  if (o.diff.added.length > cap) process.stdout.write(`      + … (${o.diff.added.length - cap} more)\n`);
  for (const r of o.diff.removed.slice(0, cap)) process.stdout.write(`      - ${r}\n`);
  if (o.diff.removed.length > cap) process.stdout.write(`      - … (${o.diff.removed.length - cap} more)\n`);
}

/** Shared prologue: load config, select rules, resolve the changed scope. */
async function prepare(
  args: ParsedArgs,
  opts: { changedAware: boolean },
): Promise<
  | { ok: true; cwd: string; rules: readonly IBaselineRule[]; all: readonly IBaselineRule[]; excludeDirs: string[]; changedFiles?: readonly string[]; planeDiagnostics: readonly string[] }
  | { ok: false; code: number }
> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await loadBaselines(cwd);
  if (!loaded.ok) {
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: loaded.message }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const selected = selectRules(loaded.value.rules, flagString(args, 'id') ?? undefined);
  if (!selected.ok) {
    process.stderr.write(selected.message + '\n');
    return { ok: false, code: ExitCode.UsageError };
  }
  let changedFiles: readonly string[] | undefined;
  if (opts.changedAware) {
    const since = flagString(args, 'since');
    if (flagBool(args, 'changed-only') || since) {
      changedFiles = resolveChangedFiles({
        projectRoot: cwd,
        ...(since ? { since } : {}),
        ...(!since ? { includeWorktree: true } : {}),
      }).files;
    }
  }
  return {
    ok: true,
    cwd,
    rules: selected.rules,
    all: loaded.value.rules,
    excludeDirs: loaded.value.sharkcraftDirRel ? [loaded.value.sharkcraftDirRel] : [],
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    planeDiagnostics: loaded.value.planeDiagnostics,
  };
}

/** The "no baselines declared" landing, shared by every subverb. */
function writeNoRules(json: boolean): number {
  if (json) {
    process.stdout.write(asJson({ schema: SCHEMA, results: [], evaluated: 0, verdict: 'not-verified' }) + '\n');
    return ExitCode.NotVerified;
  }
  process.stdout.write(header('Baselines'));
  process.stdout.write(
    '  No baselines declared. Add `baselines[]` to sharkcraft.config.ts to replace a\n' +
      '  hand-rolled "committed file + recompute script + drift test" trio with one\n' +
      '  two-way engine (see docs/baseline-drift.md).\n',
  );
  return ExitCode.NotVerified;
}

export const baselineListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every declared baseline: what it pins, how it recomputes, which direction fails.',
  usage: 'shrk baseline list [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.all.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          baselines: prep.all.map((r) => ({
            id: r.id,
            description: r.description ?? null,
            baseline: r.baseline,
            compute: r.compute.kind,
            direction: r.direction ?? 'two-way',
            keyBy: r.keyBy ?? null,
            failOnEmpty: r.failOnEmpty === true,
          })),
          diagnostics: prep.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Baselines (${prep.all.length})`));
    for (const r of prep.all) {
      process.stdout.write(`  • ${r.id}  →  ${r.baseline}\n`);
      process.stdout.write(
        `      compute ${r.compute.kind}${r.compute.kind === 'command' ? ` (${r.compute.run})` : ''}` +
          `  ·  direction ${r.direction ?? 'two-way'}${r.keyBy ? `  ·  keyBy ${r.keyBy}` : ''}` +
          `${r.failOnEmpty ? '  ·  failOnEmpty' : ''}\n`,
      );
      if (r.description) process.stdout.write(`      ${r.description}\n`);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    return ExitCode.VerifiedPass;
  },
};

export const baselineCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Recompute every declared baseline and fail on drift. Two-way by default — a LOST entry fails exactly like a gained one.',
  usage: 'shrk baseline check [--id <ids>] [--changed-only] [--since <ref>] [--json]',
  booleanFlags: new Set(['json', 'changed-only']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: true });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.rules.length === 0) return writeNoRules(json);

    const outcomes = prep.rules.map((r) =>
      evaluateRule(prep.cwd, r, prep.excludeDirs, prep.changedFiles),
    );
    const failed = outcomes.filter(
      (o) => o.status === 'failed' || (o.status === 'error' && (o.rule.severity ?? 'error') === 'error'),
    );
    const evaluated = outcomes.filter((o) => o.status !== 'skipped').length;
    // 0 only when a NON-EMPTY scope was actually compared; 2 when nothing was.
    // A skipped baseline is "partially verified", never a green 0.
    const skippedCount = outcomes.filter((o) => o.status === 'skipped').length;
    const exit =
      failed.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skippedCount > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          results: outcomes.map(outcomeJson),
          evaluated,
          skipped: outcomes.filter((o) => o.status === 'skipped').length,
          verdict: failed.length > 0 ? 'errors' : evaluated === 0 ? 'not-verified' : 'pass',
          diagnostics: prep.planeDiagnostics,
          gate: buildGateEnvelope(
            'baseline check',
            exit,
            outcomes.map((o) => ({
              id: o.rule.id,
              type: 'baseline' as const,
              status: o.status,
              severity: o.rule.severity ?? 'error',
              counts: { committed: o.committedCount, current: o.currentCount },
              violations: [
                ...(o.diff?.added ?? []).map((id) => ({ id, message: 'added', hint: hintFor(o.rule) })),
                ...(o.diff?.removed ?? []).map((id) => ({ id, message: 'removed', hint: hintFor(o.rule) })),
              ],
              ...(o.skipReason ? { skipReason: o.skipReason } : {}),
              ...(o.error ? { error: o.error } : {}),
            })),
          ),
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Baseline drift'));
    process.stdout.write(kv('evaluated', `${evaluated} of ${prep.rules.length}`) + '\n');
    for (const o of outcomes) {
      if (o.status === 'passed') {
        process.stdout.write(`  ✓ ${o.rule.id}  (${o.currentCount} entries, no drift)\n`);
        continue;
      }
      if (o.status === 'skipped') {
        process.stdout.write(`  – ${o.rule.id}  SKIPPED — ${o.skipReason}\n`);
        continue;
      }
      if (o.status === 'error') {
        process.stdout.write(`  ! ${o.rule.id}  ${o.error}\n`);
        if (o.missingBaseline && o.currentCount > 0) {
          process.stdout.write(
            `      the compute currently yields ${o.currentCount} entr${o.currentCount === 1 ? 'y' : 'ies'} — ` +
              `run \`shrk baseline update --id ${o.rule.id}\` to bless them.\n`,
          );
        }
        continue;
      }
      const added = o.diff?.added.length ?? 0;
      const removed = o.diff?.removed.length ?? 0;
      process.stdout.write(
        `  ✗ ${o.rule.id}  DRIFT — ${added} added, ${removed} removed ` +
          `(${o.committedCount} committed → ${o.currentCount} now, ${o.diff?.mode})\n`,
      );
      writeDiff(o);
      if (o.emptyCompute) {
        process.stdout.write(
          '      ! the recompute produced 0 entries — check the compute before blessing this.\n',
        );
      }
      process.stdout.write(`      → ${hintFor(o.rule)}\n`);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    if (exit === ExitCode.NotVerified) {
      process.stdout.write(
        '\nNothing was compared — this is NOT a pass. Every selected baseline was skipped.\n',
      );
    } else if (exit === ExitCode.VerifiedPass) {
      process.stdout.write('\nEvery baseline matches its committed artifact. ✓\n');
    }
    return exit;
  },
};

export const baselineDiffCommand: ICommandHandler = {
  name: 'diff',
  description:
    'Show the +added / −removed entries for each baseline without failing — the inspection verb (always exits 0 when it ran).',
  usage: 'shrk baseline diff [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.rules.length === 0) return writeNoRules(json);

    const outcomes = prep.rules.map((r) => evaluateRule(prep.cwd, r, prep.excludeDirs, undefined));
    if (json) {
      process.stdout.write(
        asJson({ schema: SCHEMA, results: outcomes.map(outcomeJson), inspection: true }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header('Baseline diff (inspection — never fails)'));
    for (const o of outcomes) {
      const added = o.diff?.added.length ?? 0;
      const removed = o.diff?.removed.length ?? 0;
      process.stdout.write(
        `\n${o.rule.id}  (${o.rule.baseline})  ${o.status === 'error' ? `! ${o.error}` : `+${added} / -${removed}`}\n`,
      );
      writeDiff(o, 100);
    }
    return ExitCode.VerifiedPass;
  },
};

export const baselineUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Rewrite the committed baseline from the current value — the explicit, reviewable bless step. Writes files.',
  usage: 'shrk baseline update [--id <ids>] [--dry-run] [--json]',
  booleanFlags: new Set(['json', 'dry-run']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const dryRun = flagBool(args, 'dry-run');
    if (prep.rules.length === 0) return writeNoRules(json);

    const written: { id: string; path: string; bytes: number; changed: boolean }[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const rule of prep.rules) {
      const computed = computeCurrent(prep.cwd, rule, prep.excludeDirs);
      if (computed.error) {
        errors.push({ id: rule.id, error: computed.error });
        continue;
      }
      if (computed.text.trim() === '' && failsWhenEmpty(rule)) {
        errors.push({
          id: rule.id,
          error: 'refusing to write an EMPTY baseline for a `failOnEmpty` rule — fix the compute first',
        });
        continue;
      }
      const abs = nodePath.resolve(prep.cwd, rule.baseline);
      const previous = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
      const changed = previous !== computed.text;
      if (!dryRun && changed) {
        mkdirSync(nodePath.dirname(abs), { recursive: true });
        writeFileSync(abs, computed.text, 'utf8');
      }
      written.push({ id: rule.id, path: rule.baseline, bytes: computed.text.length, changed });
    }

    if (json) {
      process.stdout.write(
        asJson({ schema: SCHEMA, dryRun, written, errors }) + '\n',
      );
      return errors.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
    }
    process.stdout.write(header(dryRun ? 'Baseline update (dry run)' : 'Baseline update'));
    for (const w of written) {
      process.stdout.write(
        `  ${w.changed ? (dryRun ? 'would write' : 'wrote') : 'unchanged '} ${w.path}  (${w.bytes} bytes)\n`,
      );
    }
    for (const e of errors) process.stdout.write(`  ! ${e.id}: ${e.error}\n`);
    if (written.some((w) => w.changed) && !dryRun) {
      process.stdout.write('\nReview the diff before committing — this is the bless step.\n');
    }
    return errors.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
  },
};

export const baselineExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Show what ONE baseline will compute and compare — the command or extractor, the canonical form, both entry counts and the diff — without turning it into a verdict.',
  usage: 'shrk baseline explain --id <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk baseline explain --id <id>\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args, { changedAware: false });
    if (!prep.ok) return prep.code;
    const rule = prep.all.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No baseline "${id}". Declared: ${prep.all.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    const outcome = evaluateRule(prep.cwd, rule, prep.excludeDirs, undefined);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.baseline-explain/v1',
          ...outcomeJson(outcome),
          compute: rule.compute,
          watchFiles: rule.watchFiles ?? null,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Baseline: ${rule.id}`));
    if (rule.description) process.stdout.write(`  ${rule.description}\n`);
    process.stdout.write(kv('committed', rule.baseline) + '\n');
    process.stdout.write(
      kv('compute', rule.compute.kind === 'command' ? `command · ${rule.compute.run}` : `extractor · ${rule.compute.source?.extract ?? 'sugar'}`) + '\n',
    );
    process.stdout.write(kv('direction', rule.direction ?? 'two-way') + '\n');
    process.stdout.write(kv('canonical', outcome.diff?.canonical ?? rule.compute.canonical ?? 'auto') + '\n');
    if (rule.keyBy) process.stdout.write(kv('keyBy', rule.keyBy) + '\n');
    process.stdout.write(
      kv(
        'entries',
        outcome.missingBaseline
          ? `committed (none yet) → ${outcome.currentCount} now`
          : `${outcome.committedCount} committed → ${outcome.currentCount} now`,
      ) + '\n',
    );
    process.stdout.write(kv('status', outcome.status) + '\n');
    if (outcome.error) process.stdout.write(`  ! ${outcome.error}\n`);
    if (outcome.skipReason) process.stdout.write(`  – ${outcome.skipReason}\n`);
    if (outcome.diff && (outcome.diff.added.length > 0 || outcome.diff.removed.length > 0)) {
      process.stdout.write('\n  diff:\n');
      writeDiff(outcome, 100);
    }
    return ExitCode.VerifiedPass;
  },
};

export const baselineCommand: ICommandHandler = {
  name: 'baseline',
  description:
    'Committed-baseline drift engine: recompute a ledger/digest/allow-list and fail on drift in BOTH directions. Read-only except `update`.',
  usage: 'shrk baseline list | check | diff | update | explain --id <id>',
  booleanFlags: new Set(['json', 'changed-only', 'dry-run']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    process.stderr.write(
      (sub ? `Unknown subcommand "${sub}". ` : '') +
        'Usage: shrk baseline list | check [--id X] | diff | update | explain --id <id>\n',
    );
    return ExitCode.UsageError;
  },
};
