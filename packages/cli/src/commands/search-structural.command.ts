import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  applyRewritePlan,
  PatternRegistryStore,
  planRewrite,
  runSearch,
  signRewritePlan,
  STARTER_PATTERNS,
  verifySignedRewritePlan,
  type IPatternEnvelope,
  type IRewritePlan,
  type ISignedRewritePlan,
  type RewriteRecipe,
  type StructuralPattern,
} from '@shrkcrft/structural-search';
import {
  flagBool,
  flagPositiveInt,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk search structural` — declarative AST pattern matching with
 * optional rewrite mode (Wave 8). Patterns are JSON (no executable
 * predicates) — either inline via --pattern or from a file via
 * --pattern-file.
 *
 * Rewrite flow:
 *   1. Pass `--rewrite '<json>'` (a `RewriteRecipe`) to compute a
 *      rewrite plan.
 *   2. Preview is shown by default (no fs writes).
 *   3. Pass `--apply` to actually write the changes.
 *
 * The plan can be inspected as JSON via `--json` and replayed via
 * `--plan-in <path>` (write the plan with `--plan-out <path>` first).
 */
export const searchStructuralCommand: ICommandHandler = {
  name: 'search-structural',
  description:
    'Run an AST-shape pattern over the project. Patterns are declarative JSON. Optional rewrite mode: --rewrite <recipe-json> previews; --apply writes the change to disk.',
  usage:
    'shrk search-structural (--pattern <json> | --pattern-file <path>) [--limit N] [--rewrite <recipe-json>] [--rewrite-file <path>] [--apply] [--dry-run] [--plan-out <path>] [--plan-in <path>] [--sign] [--verify-signature] [--secret-env <VAR>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    // `shrk search-structural registry ...` — pattern registry subverbs.
    // Dispatch before any pattern parsing so a missing pattern file
    // doesn't reject a registry-only call.
    if (args.positional[0] === 'registry') {
      return runRegistry({ ...args, positional: args.positional.slice(1) });
    }
    const planInPath = flagString(args, 'plan-in');
    if (planInPath) {
      return runFromSavedPlan(cwd, planInPath, args, wantJson);
    }
    const inline = flagString(args, 'pattern');
    const patternFile = flagString(args, 'pattern-file');
    if (!inline && !patternFile) {
      process.stderr.write(this.usage + '\n');
      return 2;
    }
    let pattern: StructuralPattern;
    try {
      pattern = parseJson<StructuralPattern>(inline, patternFile, cwd);
    } catch (e) {
      process.stderr.write(`Pattern parse error: ${(e as Error).message}\n`);
      return 2;
    }
    const limit = flagPositiveInt(args, 'limit', 200);

    // Rewrite path?
    const recipeInline = flagString(args, 'rewrite');
    const recipeFile = flagString(args, 'rewrite-file');
    if (recipeInline || recipeFile) {
      let recipe: RewriteRecipe;
      try {
        recipe = parseJson<RewriteRecipe>(recipeInline, recipeFile, cwd);
      } catch (e) {
        process.stderr.write(`Recipe parse error: ${(e as Error).message}\n`);
        return 2;
      }
      return runRewrite(cwd, pattern, recipe, args, wantJson);
    }

    // Plain match path.
    const result = runSearch({ projectRoot: cwd, pattern, limit });
    if (wantJson) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header(`Structural search: ${result.pattern.summary}`));
    process.stdout.write(kv('files scanned', String(result.filesScanned)) + '\n');
    process.stdout.write(kv('matches', String(result.matchCount)) + '\n');
    if (result.truncated) process.stdout.write(kv('truncated', 'yes') + '\n');
    for (const m of result.matches.slice(0, 50)) {
      process.stdout.write(`  ${m.file}:${m.line}:${m.column}  ${m.nodeKind}  ${m.excerpt}\n`);
    }
    for (const d of result.diagnostics.slice(0, 10)) {
      process.stdout.write(`! ${d}\n`);
    }
    return 0;
  },
};

async function runRewrite(
  cwd: string,
  pattern: StructuralPattern,
  recipe: RewriteRecipe,
  args: ParsedArgs,
  wantJson: boolean,
): Promise<number> {
  const apply = flagBool(args, 'apply');
  const dryRun = flagBool(args, 'dry-run');
  const planOut = flagString(args, 'plan-out');
  const wantSign = flagBool(args, 'sign');
  const secretEnv = flagString(args, 'secret-env') ?? 'SHRKCRFT_REWRITE_SECRET';

  const plan = planRewrite({ projectRoot: cwd, pattern, recipe });

  if (planOut) {
    const abs = nodePath.isAbsolute(planOut) ? planOut : nodePath.resolve(cwd, planOut);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    const payload = wantSign
      ? signPlanOrFail(plan, secretEnv)
      : plan;
    if (!payload) return 2;
    writeFileSync(abs, JSON.stringify(payload, null, 2), 'utf8');
  }

  if (!apply) {
    // Preview only.
    if (wantJson) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header(`Rewrite plan (preview): ${recipe.kind}`));
    process.stdout.write(kv('files scanned', String(plan.filesScanned)) + '\n');
    process.stdout.write(kv('files to change', String(plan.files.length)) + '\n');
    process.stdout.write(kv('total edits', String(plan.totalEdits)) + '\n');
    if (planOut) process.stdout.write(kv('plan written to', planOut) + '\n');
    for (const f of plan.files.slice(0, 20)) {
      process.stdout.write(`\n  ${f.path}:\n`);
      for (const e of f.edits.slice(0, 5)) {
        process.stdout.write(`    L${e.line}  ${truncate(e.before)}  →  ${truncate(e.replacement)}\n`);
      }
      if (f.edits.length > 5) process.stdout.write(`    … (${f.edits.length - 5} more edits)\n`);
    }
    if (plan.files.length > 20) {
      process.stdout.write(`\n  … (${plan.files.length - 20} more files)\n`);
    }
    for (const d of plan.diagnostics.slice(0, 10)) process.stdout.write(`! ${d}\n`);
    process.stdout.write(`\nTo write these changes: rerun with --apply.\n`);
    return 0;
  }

  // Apply path.
  const result = applyRewritePlan(plan, { projectRoot: cwd, dryRun });
  if (wantJson) {
    process.stdout.write(asJson({ plan, result, dryRun }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Rewrite ${dryRun ? '(dry-run)' : '(applied)'}: ${recipe.kind}`));
  process.stdout.write(kv('files attempted', String(result.filesAttempted)) + '\n');
  process.stdout.write(kv('files changed', String(result.filesChanged)) + '\n');
  process.stdout.write(kv('bytes written', String(result.bytesWritten)) + '\n');
  if (result.conflicts.length > 0) {
    process.stdout.write(kv('conflicts (skipped)', String(result.conflicts.length)) + '\n');
    for (const c of result.conflicts.slice(0, 10)) process.stdout.write(`  • ${c}\n`);
  }
  for (const d of result.diagnostics.slice(0, 10)) process.stdout.write(`! ${d}\n`);
  return result.conflicts.length > 0 ? 1 : 0;
}

async function runFromSavedPlan(cwd: string, planPath: string, args: ParsedArgs, wantJson: boolean): Promise<number> {
  const abs = nodePath.isAbsolute(planPath) ? planPath : nodePath.resolve(cwd, planPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    process.stderr.write(`Plan file read error: ${(e as Error).message}\n`);
    return 2;
  }
  const apply = flagBool(args, 'apply');
  const dryRun = flagBool(args, 'dry-run');
  const verify = flagBool(args, 'verify-signature');
  const secretEnv = flagString(args, 'secret-env') ?? 'SHRKCRFT_REWRITE_SECRET';
  if (!apply) {
    process.stderr.write('Replaying a saved plan requires --apply (or --apply --dry-run).\n');
    return 2;
  }
  const wrapper = raw as { schema?: string };
  const isSigned = wrapper.schema === 'sharkcraft.structural-rewrite-plan-signed/v1';
  if (verify) {
    if (!isSigned) {
      process.stderr.write('--verify-signature passed but plan is not signed.\n');
      return 1;
    }
    const secret = process.env[secretEnv];
    if (!secret) {
      process.stderr.write(`Missing secret: env var ${secretEnv} not set.\n`);
      return 1;
    }
    const v = verifySignedRewritePlan(raw as ISignedRewritePlan, { secret });
    if (!v.ok) {
      process.stderr.write(`Signature verification failed (${v.reason}): ${v.message ?? ''}\n`);
      return 1;
    }
  }
  const plan: IRewritePlan = isSigned ? (raw as ISignedRewritePlan).plan : (raw as IRewritePlan);
  const result = applyRewritePlan(plan, { projectRoot: cwd, dryRun });
  if (wantJson) {
    process.stdout.write(asJson({ result, dryRun, verified: verify }) + '\n');
    return result.conflicts.length > 0 ? 1 : 0;
  }
  process.stdout.write(header(`Rewrite ${dryRun ? '(dry-run)' : '(applied)'} from saved plan`));
  if (verify) process.stdout.write(kv('signature', 'verified') + '\n');
  process.stdout.write(kv('files changed', String(result.filesChanged)) + '\n');
  process.stdout.write(kv('conflicts (skipped)', String(result.conflicts.length)) + '\n');
  return result.conflicts.length > 0 ? 1 : 0;
}

function signPlanOrFail(plan: IRewritePlan, secretEnv: string): ISignedRewritePlan | undefined {
  const secret = process.env[secretEnv];
  if (!secret) {
    process.stderr.write(`Missing secret: env var ${secretEnv} not set (required for --sign).\n`);
    return undefined;
  }
  return signRewritePlan(plan, { secret });
}

function parseJson<T>(inline: string | undefined, fileFlag: string | undefined, cwd: string): T {
  if (inline) return JSON.parse(inline) as T;
  const abs = nodePath.isAbsolute(fileFlag!)
    ? fileFlag!
    : nodePath.resolve(cwd, fileFlag!);
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
}

async function runRegistry(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const sub = args.positional[0] ?? 'list';
  const store = new PatternRegistryStore(cwd);

  if (sub === 'list') {
    const reg = store.read();
    if (wantJson) {
      process.stdout.write(asJson({ path: store.absPath, registry: reg }) + '\n');
      return 0;
    }
    if (reg.patterns.length === 0) {
      process.stdout.write('No patterns registered.\n');
      process.stdout.write(`(file: ${store.absPath})\n`);
      return 0;
    }
    process.stdout.write(header(`Pattern registry (${reg.patterns.length})`));
    process.stdout.write(kv('path', store.absPath) + '\n');
    for (const p of reg.patterns) {
      const err = p.lastValidationError ? ` ✗ ${p.lastValidationError}` : '';
      const validated = p.lastValidatedAt ? ` [validated ${p.lastValidatedAt}]` : '';
      process.stdout.write(`  • ${p.id} (${p.pattern.kind})${validated}${err}\n`);
      if (p.title) process.stdout.write(`    ${p.title}\n`);
    }
    return 0;
  }

  if (sub === 'add') {
    const id = flagString(args, 'id');
    const inline = flagString(args, 'pattern');
    const patternFile = flagString(args, 'pattern-file');
    const title = flagString(args, 'title');
    const description = flagString(args, 'description');
    if (!id) {
      process.stderr.write('Usage: shrk search-structural registry add --id <id> (--pattern <json> | --pattern-file <path>) [--title "..."] [--description "..."]\n');
      return 2;
    }
    if (!inline && !patternFile) {
      process.stderr.write('Missing pattern body (--pattern or --pattern-file).\n');
      return 2;
    }
    let pattern: StructuralPattern;
    try {
      pattern = parseJson<StructuralPattern>(inline, patternFile, cwd);
    } catch (e) {
      process.stderr.write(`Pattern parse error: ${(e as Error).message}\n`);
      return 2;
    }
    const envelope: IPatternEnvelope = {
      schema: 'sharkcraft.structural-pattern/v1',
      id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      pattern,
    };
    const { result, entry } = store.add(envelope);
    if (!result.ok) {
      if (wantJson) {
        process.stdout.write(asJson({ ok: false, error: result.error }) + '\n');
      } else {
        process.stderr.write(`Pattern rejected: ${result.error}\n`);
      }
      return 2;
    }
    if (wantJson) {
      process.stdout.write(asJson({ ok: true, entry, path: store.absPath }) + '\n');
      return 0;
    }
    process.stdout.write(`Pattern registered: ${entry?.id} (${entry?.pattern.kind})\n`);
    process.stdout.write(`  → ${store.absPath}\n`);
    return 0;
  }

  if (sub === 'remove') {
    const id = args.positional[1] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk search-structural registry remove <id>\n');
      return 2;
    }
    const removed = store.remove(id);
    if (wantJson) {
      process.stdout.write(asJson({ removed, id }) + '\n');
      return removed ? 0 : 1;
    }
    process.stdout.write(removed ? `Removed pattern "${id}".\n` : `No pattern with id "${id}".\n`);
    return removed ? 0 : 1;
  }

  if (sub === 'validate') {
    const result = store.validateAll();
    if (wantJson) {
      process.stdout.write(asJson(result) + '\n');
      return result.failed === 0 ? 0 : 1;
    }
    process.stdout.write(header('Pattern registry validation'));
    process.stdout.write(kv('total', String(result.total)) + '\n');
    process.stdout.write(kv('failed', String(result.failed)) + '\n');
    if (result.failed > 0) {
      process.stdout.write('\nFailures:\n');
      for (const e of result.errors) {
        process.stdout.write(`  ✗ ${e.id} — ${e.error}\n`);
      }
      return 1;
    }
    process.stdout.write('\nAll patterns valid.\n');
    return 0;
  }

  if (sub === 'clear') {
    const cleared = store.clear();
    if (wantJson) {
      process.stdout.write(asJson({ cleared, path: store.absPath }) + '\n');
      return 0;
    }
    process.stdout.write(cleared ? `Cleared ${store.absPath}\n` : 'No registry file to clear.\n');
    return 0;
  }

  if (sub === 'seed') {
    const force = flagBool(args, 'force');
    const existing = store.read();
    if (existing.patterns.length > 0 && !force) {
      const msg = `Registry already has ${existing.patterns.length} pattern(s). Use --force to merge / overwrite seed entries.\n`;
      if (wantJson) {
        process.stdout.write(asJson({ ok: false, error: 'non-empty' }) + '\n');
        return 1;
      }
      process.stderr.write(msg);
      return 1;
    }
    const added: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const envelope of STARTER_PATTERNS) {
      const { result, entry } = store.add(envelope);
      if (result.ok && entry) {
        added.push(entry.id);
      } else {
        failed.push({ id: envelope.id ?? '?', error: result.error ?? 'unknown' });
      }
    }
    if (wantJson) {
      process.stdout.write(
        asJson({ ok: failed.length === 0, added, failed, path: store.absPath }) + '\n',
      );
      return failed.length === 0 ? 0 : 1;
    }
    process.stdout.write(`Seeded ${added.length} starter pattern(s) → ${store.absPath}\n`);
    for (const id of added) process.stdout.write(`  + ${id}\n`);
    if (failed.length > 0) {
      process.stdout.write('\nFailures:\n');
      for (const f of failed) process.stdout.write(`  ✗ ${f.id} — ${f.error}\n`);
    }
    return failed.length === 0 ? 0 : 1;
  }

  process.stderr.write('Usage: shrk search-structural registry <list|add|remove|validate|clear|seed> [--json]\n');
  return 2;
}
