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
import type { IGeneratedArtifactRule } from '@shrkcrft/core';
import {
  checkProvenanceHeaders,
  compareGeneratedTrees,
  scanGeneratedFiles,
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

/** Run `regen` into a fresh temp dir and read the result back. Always cleans up. */
function runRegen(cwd: string, rule: IGeneratedArtifactRule, committed: ReadonlyMap<string, string>): IRegenResult {
  const tmp = mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'shrk-generated-'));
  try {
    const command = rule.regen!.split('{TMP}').join(tmp);
    const child = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: rule.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

interface IGeneratedOutcome {
  readonly rule: IGeneratedArtifactRule;
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly committedCount: number;
  readonly treeDiff?: IGeneratedTreeDiff;
  readonly provenance: readonly IProvenanceFinding[];
  readonly error?: string;
  readonly skipReason?: string;
  /** True when the drift half was deliberately not run (`--headers-only` / no `regen`). */
  readonly driftChecked: boolean;
}

function evaluateRule(
  cwd: string,
  rule: IGeneratedArtifactRule,
  excludeDirs: readonly string[],
  headersOnly: boolean,
): IGeneratedOutcome {
  const scan = scanGeneratedFiles(cwd, rule, excludeDirs);
  const severity = rule.severity ?? 'error';

  if (scan.generated.size === 0) {
    const failed = rule.failOnEmpty === true;
    return {
      rule,
      status: failed ? 'failed' : 'skipped',
      committedCount: 0,
      provenance: [],
      driftChecked: false,
      skipReason: `0 files matched generatedGlob (${rule.generatedGlob.join(', ')})`,
    };
  }

  const headers = checkProvenanceHeaders(rule, scan.generated, scan.outside);
  if (headers.error) {
    return {
      rule,
      status: 'error',
      committedCount: scan.generated.size,
      provenance: [],
      driftChecked: false,
      error: headers.error,
    };
  }

  let treeDiff: IGeneratedTreeDiff | undefined;
  let error: string | undefined;
  const wantDrift = !headersOnly && rule.regen !== undefined;
  if (wantDrift) {
    const regen = runRegen(cwd, rule, scan.generated);
    if (regen.error) error = regen.error;
    else treeDiff = compareGeneratedTrees(scan.generated, regen.files!, rule.compare ?? 'bytes');
  }

  const hardFindings = headers.findings.filter((f) => f.severity === 'error');
  const drifted = (treeDiff?.differences.length ?? 0) > 0;
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
    driftChecked: wantDrift && error === undefined,
  };
}

function hintFor(rule: IGeneratedArtifactRule): string {
  return (
    rule.hint ??
    (rule.regen
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
    ...(o.treeDiff ? { differences: o.treeDiff.differences, regeneratedCount: o.treeDiff.regeneratedCount } : {}),
    provenance: o.provenance,
    ...(o.error ? { error: o.error } : {}),
    ...(o.skipReason ? { skipReason: o.skipReason } : {}),
    hint: hintFor(o.rule),
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
    return { ok: false, code: ExitCode.NotVerified };
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
      return { ok: false, code: ExitCode.NotVerified };
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
      process.stdout.write(`      regen  ${r.regen ?? '(header-only — never spawns)'}\n`);
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

    const outcomes = prep.rules.map((r) => evaluateRule(prep.cwd, r, prep.excludeDirs, headersOnly));
    const failed = outcomes.filter(
      (o) => o.status === 'failed' || (o.status === 'error' && (o.rule.severity ?? 'error') === 'error'),
    );
    const evaluated = outcomes.filter((o) => o.status !== 'skipped').length;
    const exit =
      failed.length > 0
        ? ExitCode.Failure
        : evaluated === 0
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
        process.stdout.write(
          `  ✓ ${o.rule.id}  (${o.committedCount} files` +
            `${o.driftChecked ? ', byte-identical to a fresh regen' : ', headers only'})\n`,
        );
      } else {
        process.stdout.write(`  ✗ ${o.rule.id}  ${diffs.length} file(s) differ from a fresh regen\n`);
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
      if (o.status === 'failed') process.stdout.write(`      → ${hintFor(o.rule)}\n`);
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
      if (!rule.regen) {
        results.push({ id: rule.id, ran: false, error: 'header-only rule — nothing to regenerate' });
        continue;
      }
      // `{TMP}` is the CHECK contract; `update` writes in place, so it is
      // substituted with the project root and the regen writes its real output.
      const command = rule.regen.split('{TMP}').join(prep.cwd);
      const child = spawnSync(command, {
        cwd: prep.cwd,
        shell: true,
        encoding: 'utf8',
        timeout: rule.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        stdio: json ? 'pipe' : 'inherit',
      });
      if (child.error) {
        results.push({ id: rule.id, ran: false, error: child.error.message });
      } else if (child.status !== 0) {
        results.push({ id: rule.id, ran: true, error: `exited ${child.status ?? 'null'}` });
      } else {
        results.push({ id: rule.id, ran: true });
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
      return ExitCode.NotVerified;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const rule = prep.all.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No generated-artifact rule "${id}". Declared: ${prep.all.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.NotVerified;
    }
    // explain never spawns — the point is to show what the rule SEES.
    const scan = scanGeneratedFiles(prep.cwd, rule, prep.excludeDirs);
    const outcome = evaluateRule(prep.cwd, rule, prep.excludeDirs, true);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.generated-explain/v1',
          ...outcomeJson(outcome),
          files: [...scan.generated.keys()],
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
    process.stdout.write(kv('regen', rule.regen ?? '(header-only)') + '\n');
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

