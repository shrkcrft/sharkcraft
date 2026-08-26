/**
 * `shrk generated {list,check,update,explain}` — the generated-artifact drift +
 * provenance GATE. It shares the `generated` noun with the classifier verbs
 * (`report` / `protect`, in `ingest.command.ts`) on purpose: that half FINDS
 * what is generated, this half proves it has not drifted.
 *
 *   shrk generated list                       # every declared artifact set
 *   shrk generated check [--id X]             # regen → temp dir → diff BOTH ways + headers
 *       [--headers-only]                      #   header contract only; never spawns
 *   shrk generated update [--id X]            # run regen in place (the bless step)
 *   shrk generated explain --id X             # what it will run + what it currently sees
 *
 * The build compiles a hand-edited generated file perfectly happily; only
 * regenerate-into-a-temp-dir-and-diff catches the edit. `regen` therefore
 * SPAWNS a shell command, which is why the pack-plane merge seam drops any
 * pack-contributed rule declaring one — a header-only rule (no `regen`) is
 * fully useful and never spawns, so packs can still ship it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { failsWhenEmpty, type IGeneratedArtifactRule } from '@shrkcrft/core';
import {
  checkProvenanceHeaders,
  compareGeneratedTrees,
  scanGeneratedFiles,
  type IGeneratedFileDiff,
  type IGeneratedScan,
  type IGeneratedTreeDiff,
  type IProvenanceFinding,
} from '@shrkcrft/boundaries';
import { resolveProjectConfig } from '@shrkcrft/inspector';
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

const SCHEMA = 'sharkcraft.generated-drift/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on the temp tree read — a runaway regen must not be read into memory whole. */
const MAX_REGEN_FILE_BYTES = 2_000_000;

interface ILoadedRules {
  readonly rules: readonly IGeneratedArtifactRule[];
  readonly planeDiagnostics: readonly string[];
  readonly excludeDirs: string[];
}

async function loadRules(
  cwd: string,
): Promise<{ ok: true; value: ILoadedRules } | { ok: false; message: string }> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
  return {
    ok: true,
    value: {
      rules: loaded.value.config.generatedArtifacts ?? [],
      planeDiagnostics: loaded.value.planeDiagnostics,
      excludeDirs: rel && !rel.startsWith('..') ? [rel] : [],
    },
  };
}

/** Read a regenerated temp tree into path→content, relative to `root`. */
function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = nodePath.join(abs, e.name);
      if (e.isDirectory()) {
        visit(child);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (statSync(child).size > MAX_REGEN_FILE_BYTES) continue;
        out.set(nodePath.relative(root, child).split(nodePath.sep).join('/'), readFileSync(child, 'utf8'));
      } catch {
        // unreadable — skip
      }
    }
  };
  visit(root);
  return out;
}

/** Number of trailing path SEGMENTS `a` and `b` share (0 when none). */
function sharedSuffixSegments(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n += 1;
  return n;
}

/**
 * Re-key a regenerated tree onto the committed paths.
 *
 * A regen writes into `{TMP}` under its own root, which is rarely the repo
 * root, while committed files are keyed project-relative. The two sets are
 * matched on the LONGEST shared path suffix — not the first suffix that
 * happens to match, because `a.json` alone would otherwise bind to whichever
 * `…/a.json` the iteration reached first and silently compare two unrelated
 * files. Ties break lexically so the mapping is deterministic, each committed
 * path is claimed at most once, and anything unmatched keeps its temp-relative
 * key and surfaces as `only-regenerated` rather than disappearing.
 */
function alignToCommitted(
  temp: ReadonlyMap<string, string>,
  committed: ReadonlyMap<string, string>,
): Map<string, string> {
  const committedPaths = [...committed.keys()].sort();
  const claimed = new Set<string>();
  const out = new Map<string, string>();
  // Best-match first: a temp path with a longer shared suffix has the stronger
  // claim on a committed path, so resolve those before the weaker ones.
  const scored = [...temp.keys()]
    .map((tempPath) => {
      let best: { path: string; score: number } | undefined;
      for (const c of committedPaths) {
        const score = sharedSuffixSegments(tempPath, c);
        if (score > 0 && (best === undefined || score > best.score)) best = { path: c, score };
      }
      return { tempPath, best };
    })
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0) || a.tempPath.localeCompare(b.tempPath));

  for (const { tempPath, best } of scored) {
    const content = temp.get(tempPath)!;
    if (best && !claimed.has(best.path)) {
      claimed.add(best.path);
      out.set(best.path, content);
    } else {
      out.set(tempPath, content);
    }
  }
  return out;
}

interface IRegenResult {
  readonly files?: ReadonlyMap<string, string>;
  readonly error?: string;
}

/**
 * Run ONE regen command into a fresh temp dir and read the result back, keyed
 * onto the committed paths it corresponds to. Always cleans up.
 *
 * `committed` is the slice this command OWNS, not the whole tree — that is what
 * keeps a multi-writer tree honest: each command's output is aligned against
 * (and later diffed against) only its own files, so writer A's output can never
 * be reported as writer B's stale committed file.
 */
function runOneRegen(
  cwd: string,
  command: string,
  committed: ReadonlyMap<string, string>,
  timeoutMs: number,
): IRegenResult {
  const tmp = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'shrk-generated-'));
  try {
    const child = spawnSync(command.split('{TMP}').join(tmp), {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) return { error: `regen failed to start: ${child.error.message}` };
    if (child.status !== 0) {
      const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
      return { error: `regen exited ${child.status ?? 'null'}${tail ? ` — ${tail}` : ''}` };
    }
    const tree = readTree(tmp);
    if (tree.size === 0) {
      return { error: 'regen wrote no files into {TMP} — the command probably ignores the output path' };
    }
    return { files: alignToCommitted(tree, committed) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every regen command a rule declares, paired with the committed slice it owns. */
interface IRegenUnit {
  readonly label: string;
  readonly command: string;
  readonly committed: ReadonlyMap<string, string>;
  readonly timeoutMs: number;
}

/**
 * The regen units for a rule: one per `sources[]` writer, or a single unit for
 * the classic `regen` form. A rule declaring neither yields none (header-only).
 */
function regenUnitsOf(rule: IGeneratedArtifactRule, scan: IGeneratedScan): IRegenUnit[] {
  const fallback = rule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (scan.slices.length > 0) {
    return scan.slices.map((slice) => ({
      label: slice.label,
      command: slice.regen,
      committed: slice.files,
      timeoutMs: slice.timeoutMs ?? fallback,
    }));
  }
  if (rule.regen === undefined) return [];
  // Single-writer: the checkable set, so a hand-maintained bless inside the
  // glob is not compared against output no generator produces.
  return [{ label: rule.id, command: rule.regen, committed: scan.checkable, timeoutMs: fallback }];
}

/**
 * One rule's outcome. Exported so `shrk gates check` aggregates the SAME
 * evaluation the per-plane verb runs, rather than a second implementation that
 * could drift from it.
 */
export interface IGeneratedOutcome {
  readonly rule: IGeneratedArtifactRule;
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly committedCount: number;
  readonly treeDiff?: IGeneratedTreeDiff;
  readonly provenance: readonly IProvenanceFinding[];
  readonly error?: string;
  readonly skipReason?: string;
  /** True when the drift half was deliberately not run (`--headers-only` / no `regen`). */
  readonly driftChecked: boolean;
  /** Files excluded from every check by `handMaintained`. */
  readonly handMaintained: readonly string[];
  /** Per-writer drift results, for a multi-writer rule. */
  readonly writers: readonly IWriterOutcome[];
}

/** One writer's slice result inside a multi-writer rule. */
interface IWriterOutcome {
  readonly label: string;
  readonly committedCount: number;
  readonly differences: number;
  readonly error?: string;
}

export function evaluateGeneratedRule(
  cwd: string,
  rule: IGeneratedArtifactRule,
  excludeDirs: readonly string[],
  headersOnly: boolean,
): IGeneratedOutcome {
  const scan = scanGeneratedFiles(cwd, rule, excludeDirs);
  const severity = rule.severity ?? 'error';

  if (scan.generated.size === 0) {
    const failed = failsWhenEmpty(rule);
    return {
      rule,
      status: failed ? 'failed' : 'skipped',
      committedCount: 0,
      provenance: [],
      driftChecked: false,
      handMaintained: [],
      writers: [],
      skipReason: `0 files matched generatedGlob (${rule.generatedGlob.join(', ')})`,
    };
  }

  // Headers + byte checks run over the CHECKABLE set — a hand-maintained bless
  // is excluded from both, which is the whole point of declaring it.
  const headers = checkProvenanceHeaders(rule, scan.checkable, scan.outside, {
    unclassified: scan.unclassified,
    staleHandMaintained: scan.staleHandMaintained,
  });
  if (headers.error) {
    return {
      rule,
      status: 'error',
      committedCount: scan.generated.size,
      provenance: [],
      driftChecked: false,
      handMaintained: scan.handMaintained,
      writers: [],
      error: headers.error,
    };
  }

  const units = headersOnly ? [] : regenUnitsOf(rule, scan);
  const differences: IGeneratedFileDiff[] = [];
  const writers: IWriterOutcome[] = [];
  const errors: string[] = [];
  let committedCompared = 0;
  let regeneratedCount = 0;
  for (const unit of units) {
    const regen = runOneRegen(cwd, unit.command, unit.committed, unit.timeoutMs);
    if (regen.error) {
      errors.push(units.length > 1 ? `${unit.label}: ${regen.error}` : regen.error);
      writers.push({ label: unit.label, committedCount: unit.committed.size, differences: 0, error: regen.error });
      continue;
    }
    const diff = compareGeneratedTrees(unit.committed, regen.files!, rule.compare ?? 'bytes');
    differences.push(...diff.differences);
    committedCompared += diff.committedCount;
    regeneratedCount += diff.regeneratedCount;
    writers.push({ label: unit.label, committedCount: unit.committed.size, differences: diff.differences.length });
  }

  const ranAnyWriter = units.length > 0 && errors.length < units.length;
  const treeDiff: IGeneratedTreeDiff | undefined = ranAnyWriter
    ? { differences, committedCount: committedCompared, regeneratedCount }
    : undefined;
  const error = errors.length > 0 ? errors.join(' · ') : undefined;

  const hardFindings = headers.findings.filter((f) => f.severity === 'error');
  const drifted = differences.length > 0;
  // A writer that failed to RUN proved nothing, so the rule is in error even if
  // its siblings were clean — a partial regen must never read as a full pass.
  const status: IGeneratedOutcome['status'] =
    error !== undefined
      ? 'error'
      : drifted || (hardFindings.length > 0 && severity === 'error')
        ? 'failed'
        : 'passed';

  return {
    rule,
    status,
    committedCount: scan.generated.size,
    ...(treeDiff ? { treeDiff } : {}),
    provenance: headers.findings,
    ...(error ? { error } : {}),
    driftChecked: units.length > 0 && errors.length === 0,
    handMaintained: scan.handMaintained,
    writers: writers.length > 1 ? writers : [],
  };
}

export function generatedHintFor(rule: IGeneratedArtifactRule): string {
  return (
    rule.hint ??
    (rule.regen || rule.sources
      ? `regenerate with \`shrk generated update --id ${rule.id}\` and commit the result`
      : 'add the provenance header to the generated file, or move it out of the generated glob')
  );
}

function outcomeJson(o: IGeneratedOutcome): Record<string, unknown> {
  return {
    id: o.rule.id,
    ...(o.rule.description ? { description: o.rule.description } : {}),
    status: o.status,
    severity: o.rule.severity ?? 'error',
    committedCount: o.committedCount,
    driftChecked: o.driftChecked,
    handMaintained: o.handMaintained,
    ...(o.writers.length > 0 ? { writers: o.writers } : {}),
    ...(o.treeDiff ? { differences: o.treeDiff.differences, regeneratedCount: o.treeDiff.regeneratedCount } : {}),
    provenance: o.provenance,
    ...(o.error ? { error: o.error } : {}),
    ...(o.skipReason ? { skipReason: o.skipReason } : {}),
    hint: generatedHintFor(o.rule),
  };
}

async function prepare(
  args: ParsedArgs,
): Promise<
  | { ok: true; cwd: string; rules: readonly IGeneratedArtifactRule[]; all: readonly IGeneratedArtifactRule[]; excludeDirs: string[]; planeDiagnostics: readonly string[] }
  | { ok: false; code: number }
> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await loadRules(cwd);
  if (!loaded.ok) {
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: loaded.message }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const id = flagString(args, 'id');
  let rules = loaded.value.rules;
  if (id) {
    const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(rules.map((r) => r.id));
    const unknown = wanted.filter((w) => !known.has(w));
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown generated-artifact id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}\n`,
      );
      return { ok: false, code: ExitCode.UsageError };
    }
    rules = rules.filter((r) => wanted.includes(r.id));
  }
  return {
    ok: true,
    cwd,
    rules,
    all: loaded.value.rules,
    excludeDirs: loaded.value.excludeDirs,
    planeDiagnostics: loaded.value.planeDiagnostics,
  };
}

function writeNoRules(json: boolean): number {
  if (json) {
    process.stdout.write(asJson({ schema: SCHEMA, results: [], evaluated: 0, verdict: 'not-verified' }) + '\n');
    return ExitCode.NotVerified;
  }
  process.stdout.write(header('Generated artifacts'));
  process.stdout.write(
    '  No generated-artifact rules declared. Add `generatedArtifacts[]` to\n' +
      '  sharkcraft.config.ts to catch hand-edited generated files and missing\n' +
      '  "do not edit" headers (see docs/generated-drift.md).\n',
  );
  return ExitCode.NotVerified;
}

export const generatedListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every declared generated-artifact rule: its globs, regen command, and header contract.',
  usage: 'shrk generated list [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.all.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          rules: prep.all.map((r) => ({
            id: r.id,
            description: r.description ?? null,
            generatedGlob: r.generatedGlob,
            regen: r.regen ?? null,
            sources: r.sources ?? null,
            handMaintained: r.handMaintained ?? null,
            handMaintainedMarker: r.handMaintainedMarker ?? null,
            compare: r.compare ?? 'bytes',
            provenanceHeader: r.provenanceHeader ?? null,
            failOnEmpty: r.failOnEmpty === true,
          })),
          diagnostics: prep.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Generated artifacts (${prep.all.length})`));
    for (const r of prep.all) {
      process.stdout.write(`  • ${r.id}\n`);
      process.stdout.write(`      glob   ${r.generatedGlob.join(', ')}\n`);
      if (r.sources && r.sources.length > 0) {
        process.stdout.write(`      regen  ${r.sources.length} writer(s):\n`);
        r.sources.forEach((src, i) => {
          process.stdout.write(`               [${src.id ?? i}] ${src.regen}\n`);
          process.stdout.write(`                    owns ${src.glob.join(', ')}\n`);
        });
      } else {
        process.stdout.write(`      regen  ${r.regen ?? '(header-only — never spawns)'}\n`);
      }
      if (r.handMaintained && r.handMaintained.length > 0) {
        process.stdout.write(`      hand   ${r.handMaintained.join(', ')}  (exempt from header + byte checks)\n`);
      }
      if (r.handMaintainedMarker) {
        process.stdout.write(`      marker /${r.handMaintainedMarker}/  (in-file bless)\n`);
      }
      if (r.provenanceHeader) {
        process.stdout.write(
          `      header /${r.provenanceHeader.mustMatch}/${r.provenanceHeader.forbidOutside ? '  + mislabel check' : ''}\n`,
        );
      }
      if (r.description) process.stdout.write(`      ${r.description}\n`);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    return ExitCode.VerifiedPass;
  },
};

export const generatedCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Regenerate into a temp dir and diff BOTH ways (hand-edited file AND regen-writes-a-subset), plus the "do not edit" header contract.',
  usage: 'shrk generated check [--id <ids>] [--headers-only] [--json]',
  booleanFlags: new Set(['json', 'headers-only']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const headersOnly = flagBool(args, 'headers-only');
    if (prep.rules.length === 0) return writeNoRules(json);

    const outcomes = prep.rules.map((r) => evaluateGeneratedRule(prep.cwd, r, prep.excludeDirs, headersOnly));
    const failed = outcomes.filter(
      (o) => o.status === 'failed' || (o.status === 'error' && (o.rule.severity ?? 'error') === 'error'),
    );
    const evaluated = outcomes.filter((o) => o.status !== 'skipped').length;
    const skippedCount = outcomes.length - evaluated;
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
          headersOnly,
          results: outcomes.map(outcomeJson),
          evaluated,
          skipped: outcomes.filter((o) => o.status === 'skipped').length,
          verdict: failed.length > 0 ? 'errors' : evaluated === 0 ? 'not-verified' : 'pass',
          diagnostics: prep.planeDiagnostics,
          gate: buildGateEnvelope(
            'generated check',
            exit,
            outcomes.map((o) => ({
              id: o.rule.id,
              type: 'generated' as const,
              status: o.status,
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
              ...(o.skipReason ? { skipReason: o.skipReason } : {}),
              ...(o.error ? { error: o.error } : {}),
            })),
          ),
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Generated-artifact drift'));
    process.stdout.write(kv('evaluated', `${evaluated} of ${prep.rules.length}`) + '\n');
    if (headersOnly) process.stdout.write(kv('scope', 'headers only — no regen was run') + '\n');
    for (const o of outcomes) {
      if (o.status === 'skipped') {
        process.stdout.write(`  – ${o.rule.id}  SKIPPED — ${o.skipReason}\n`);
        continue;
      }
      if (o.status === 'error') {
        process.stdout.write(`  ! ${o.rule.id}  ${o.error}\n`);
        continue;
      }
      const diffs = o.treeDiff?.differences ?? [];
      if (o.status === 'passed') {
        const exempt = o.handMaintained.length > 0 ? `, ${o.handMaintained.length} hand-maintained` : '';
        process.stdout.write(
          `  ✓ ${o.rule.id}  (${o.committedCount} files${exempt}` +
            `${o.driftChecked ? ', byte-identical to a fresh regen' : ', headers only'})\n`,
        );
        for (const w of o.writers) {
          process.stdout.write(`      · ${w.label}: ${w.committedCount} file(s) verified\n`);
        }
      } else {
        process.stdout.write(`  ✗ ${o.rule.id}  ${diffs.length} file(s) differ from a fresh regen\n`);
        for (const w of o.writers) {
          process.stdout.write(
            `      · ${w.label}: ${w.error ? `ERROR — ${w.error}` : `${w.differences} of ${w.committedCount} differ`}\n`,
          );
        }
        for (const d of diffs.slice(0, 25)) {
          const label =
            d.kind === 'content'
              ? 'hand-edited (or source changed)'
              : d.kind === 'only-committed'
                ? 'committed but regen no longer produces it'
                : 'regen produces it but it is not committed';
          process.stdout.write(`      • ${d.file}  — ${label}\n`);
        }
        if (diffs.length > 25) process.stdout.write(`      … (${diffs.length - 25} more)\n`);
      }
      for (const f of o.provenance.slice(0, 25)) {
        process.stdout.write(`      [${f.severity}] ${f.file} — ${f.message}\n`);
      }
      if (o.provenance.length > 25) {
        process.stdout.write(`      … (${o.provenance.length - 25} more header finding(s))\n`);
      }
      if (o.status === 'failed') process.stdout.write(`      → ${generatedHintFor(o.rule)}\n`);
    }
    for (const d of prep.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    if (exit === ExitCode.NotVerified) {
      process.stdout.write('\nNothing was checked — this is NOT a pass. Every rule matched 0 files.\n');
    } else if (exit === ExitCode.VerifiedPass) {
      process.stdout.write('\nEvery generated artifact matches its source. ✓\n');
    }
    return exit;
  },
};

export const generatedUpdateCommand: ICommandHandler = {
  name: 'update',
  description:
    'Run the declared regen command in place — the one-command bless step after an intentional source change. Writes files.',
  usage: 'shrk generated update [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.rules.length === 0) return writeNoRules(json);

    const results: { id: string; ran: boolean; error?: string }[] = [];
    for (const rule of prep.rules) {
      // A multi-writer rule blesses by running EVERY writer — regenerating one
      // slice and calling the artifact updated is how a mixed tree drifts.
      const commands: { label: string; command: string; timeoutMs: number }[] =
        rule.sources && rule.sources.length > 0
          ? rule.sources.map((src, i) => ({
              label: `${rule.id}/${src.id ?? i}`,
              command: src.regen,
              timeoutMs: src.timeoutMs ?? rule.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            }))
          : rule.regen
            ? [{ label: rule.id, command: rule.regen, timeoutMs: rule.timeoutMs ?? DEFAULT_TIMEOUT_MS }]
            : [];
      if (commands.length === 0) {
        results.push({ id: rule.id, ran: false, error: 'header-only rule — nothing to regenerate' });
        continue;
      }
      for (const { label, command, timeoutMs } of commands) {
        // `{TMP}` is the CHECK contract; `update` writes in place, so it is
        // substituted with the project root and the regen writes its real output.
        const child = spawnSync(command.split('{TMP}').join(prep.cwd), {
          cwd: prep.cwd,
          shell: true,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          stdio: json ? 'pipe' : 'inherit',
        });
        if (child.error) {
          results.push({ id: label, ran: false, error: child.error.message });
        } else if (child.status !== 0) {
          results.push({ id: label, ran: true, error: `exited ${child.status ?? 'null'}` });
        } else {
          results.push({ id: label, ran: true });
        }
      }
    }
    const failed = results.filter((r) => r.error !== undefined);
    if (json) {
      process.stdout.write(asJson({ schema: SCHEMA, results }) + '\n');
      return failed.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
    }
    process.stdout.write(header('Generated update'));
    for (const r of results) {
      process.stdout.write(`  ${r.error ? '!' : '✓'} ${r.id}${r.error ? ` — ${r.error}` : ''}\n`);
    }
    if (failed.length === 0) {
      process.stdout.write('\nRegenerated. Review `git diff` before committing.\n');
    }
    return failed.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
  },
};

export const generatedExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Show what ONE generated-artifact rule sees right now: files matched, header contract results, mislabel candidates — without running the regen.',
  usage: 'shrk generated explain --id <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk generated explain --id <id>\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const rule = prep.all.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No generated-artifact rule "${id}". Declared: ${prep.all.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    // explain never spawns — the point is to show what the rule SEES.
    const scan = scanGeneratedFiles(prep.cwd, rule, prep.excludeDirs);
    const outcome = evaluateGeneratedRule(prep.cwd, rule, prep.excludeDirs, true);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.generated-explain/v1',
          ...outcomeJson(outcome),
          files: [...scan.generated.keys()],
          checkable: [...scan.checkable.keys()],
          handMaintained: scan.handMaintained,
          markedHandMaintained: scan.markedHandMaintained,
          staleHandMaintained: scan.staleHandMaintained,
          unclassified: scan.unclassified,
          slices: scan.slices.map((sl) => ({
            label: sl.label,
            regen: sl.regen,
            glob: sl.glob,
            files: [...sl.files.keys()],
          })),
          outsideScanned: scan.outside.size,
          outsideGlobs: scan.outsideGlobs,
          regen: rule.regen ?? null,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Generated artifact: ${rule.id}`));
    if (rule.description) process.stdout.write(`  ${rule.description}\n`);
    process.stdout.write(kv('glob', rule.generatedGlob.join(', ')) + '\n');
    process.stdout.write(kv('files matched', String(scan.generated.size)) + '\n');
    if (scan.slices.length > 0) {
      process.stdout.write(kv('writers', String(scan.slices.length)) + '\n');
      for (const sl of scan.slices) {
        process.stdout.write(`      [${sl.label}] ${sl.files.size} file(s) — ${sl.regen}\n`);
        process.stdout.write(`            owns ${sl.glob.join(', ')}\n`);
      }
    } else {
      process.stdout.write(kv('regen', rule.regen ?? '(header-only)') + '\n');
    }
    if (scan.handMaintained.length > 0) {
      process.stdout.write(
        kv('hand-maintained', `${scan.handMaintained.length} file(s) — exempt from header + byte checks`) + '\n',
      );
      const marked = new Set(scan.markedHandMaintained);
      // Say WHICH mechanism blessed each file: a config entry and an in-file
      // marker are reviewed in different places, so "why is this exempt?" has
      // two different answers and the reader needs to know which one applies.
      for (const f of scan.handMaintained.slice(0, 20)) {
        process.stdout.write(`      ${f}${marked.has(f) ? '  (in-file marker)' : '  (handMaintained[])'}\n`);
      }
    }
    if (scan.unclassified.length > 0) {
      process.stdout.write(
        kv('unclassified', `${scan.unclassified.length} file(s) — owned by no writer, not blessed`) + '\n',
      );
      for (const f of scan.unclassified.slice(0, 20)) process.stdout.write(`      ${f}\n`);
    }
    for (const pattern of scan.staleHandMaintained) {
      process.stdout.write(`  ! handMaintained "${pattern}" matches no file — stale bless\n`);
    }
    process.stdout.write(kv('compare', rule.compare ?? 'bytes') + '\n');
    if (rule.provenanceHeader) {
      process.stdout.write(kv('header', `/${rule.provenanceHeader.mustMatch}/`) + '\n');
      if (rule.provenanceHeader.forbidOutside) {
        process.stdout.write(
          kv('mislabel scan', `${scan.outside.size} file(s) via ${scan.outsideGlobs.join(', ')}`) + '\n',
        );
      }
    }
    process.stdout.write(kv('header findings', String(outcome.provenance.length)) + '\n');
    for (const f of outcome.provenance.slice(0, 50)) {
      process.stdout.write(`  [${f.kind}] ${f.file} — ${f.message}\n`);
    }
    if (scan.generated.size > 0) {
      process.stdout.write('\n  files:\n');
      for (const f of [...scan.generated.keys()].slice(0, 50)) process.stdout.write(`    ${f}\n`);
      if (scan.generated.size > 50) process.stdout.write(`    … (${scan.generated.size - 50} more)\n`);
    }
    process.stdout.write(
      `\n  Run \`shrk generated check --id ${rule.id}\` to regenerate into a temp dir and diff.\n`,
    );
    return ExitCode.VerifiedPass;
  },
};

