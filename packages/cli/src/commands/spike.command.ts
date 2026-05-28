import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const SMART_CONTEXT_DIR = nodePath.join('.sharkcraft', 'smart-context');

interface IFirstSpike {
  proposedCommand?: string | null;
  proposedFiles?: Array<{ path: string; purpose?: string }>;
  schemaOutline?: unknown;
  successCriteria?: string[];
}

interface IParsedPlan {
  task?: string;
  summary?: string;
  recommendedMvp?: { architectureName?: string; why?: string; explicitlyNotInScope?: string[] };
  firstSpike?: IFirstSpike;
  // ai-plan style fields (we also support those)
  filesToRead?: Array<{ path: string; why?: string }>;
  likelyFilesToModify?: Array<{ path: string; why?: string }>;
  [k: string]: unknown;
}

/**
 * `shrk spike <slug>` — turn a saved smart-context plan into starter
 * files for the recommended MVP.
 *
 * Reads `.sharkcraft/smart-context/<slug>.plan.json` (written by
 * smart-context when --save + focused/ai-plan succeeded), grabs
 * `firstSpike.proposedFiles[]`, and writes a placeholder file at each
 * proposed path that does not already exist. The placeholders carry a
 * short header derived from `purpose` plus the plan's
 * `schemaOutline` when present, so the human opening the file knows
 * why it exists and what shape to fill in.
 *
 * Safety:
 *   - Never overwrites an existing file.
 *   - Refuses to write outside the workspace.
 *   - `--dry-run` prints what would happen.
 *   - `--force` is intentionally absent — a re-spike should mean
 *     "delete then rerun" so the user gets a fresh prompt about it.
 */
export const spikeCommand: ICommandHandler = {
  name: 'spike',
  description:
    'Scaffold starter files for a saved smart-context plan\'s recommended MVP. Reads .sharkcraft/smart-context/<slug>.plan.json.',
  usage: 'shrk spike <slug> [--dry-run] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const slug = args.positional[0]?.trim();
    if (!slug) {
      process.stderr.write('Usage: shrk spike <slug> [--dry-run] [--json]\n');
      process.stderr.write('       (slug comes from `shrk smart-context list`)\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const dryRun = flagBool(args, 'dry-run');

    const planPath = resolvePlanPath(cwd, slug);
    if (!planPath) {
      process.stderr.write(
        `No structured plan found for slug "${slug}". Looked under .sharkcraft/smart-context/.\n` +
          `Tip: run smart-context with --save and a structured-output mode (--ai-plan or --focused --plan) first.\n`,
      );
      return 1;
    }

    let plan: IParsedPlan;
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8')) as IParsedPlan;
    } catch (e) {
      process.stderr.write(`Failed to parse ${planPath}: ${(e as Error).message}\n`);
      return 1;
    }

    const proposed = plan.firstSpike?.proposedFiles ?? [];
    if (proposed.length === 0) {
      process.stderr.write(
        `Plan at ${planPath} has no firstSpike.proposedFiles[]. Re-run smart-context with --focused --plan (architecture tasks fill this in).\n`,
      );
      return 1;
    }

    interface IScaffoldItem {
      path: string;
      absolute: string;
      action: 'create' | 'skip-exists' | 'skip-unsafe';
      reason?: string;
    }
    const items: IScaffoldItem[] = [];
    for (const entry of proposed) {
      const raw = entry?.path?.trim();
      if (!raw || raw.length === 0) continue;
      // Refuse placeholder-y paths like `.../<timestamp>.json`.
      if (/[<>{}]/.test(raw)) {
        items.push({ path: raw, absolute: '', action: 'skip-unsafe', reason: 'placeholder syntax' });
        continue;
      }
      const safe = safeJoin(cwd, raw);
      if (!safe) {
        items.push({ path: raw, absolute: '', action: 'skip-unsafe', reason: 'escapes workspace' });
        continue;
      }
      if (existsSync(safe)) {
        items.push({ path: raw, absolute: safe, action: 'skip-exists' });
        continue;
      }
      items.push({ path: raw, absolute: safe, action: 'create' });
    }

    const willCreate = items.filter((i) => i.action === 'create');
    const skipExists = items.filter((i) => i.action === 'skip-exists');
    const skipUnsafe = items.filter((i) => i.action === 'skip-unsafe');

    if (!dryRun) {
      for (const item of willCreate) {
        const purpose = proposed.find((p) => p.path === item.path)?.purpose ?? '';
        const body = renderStarter({
          path: item.path,
          purpose,
          plan,
        });
        mkdirSync(nodePath.dirname(item.absolute), { recursive: true });
        writeFileSync(item.absolute, body, 'utf8');
      }
    }

    if (json) {
      process.stdout.write(
        asJson({
          slug,
          planPath,
          dryRun,
          created: willCreate.map((i) => i.path),
          skippedExisting: skipExists.map((i) => i.path),
          skippedUnsafe: skipUnsafe.map((i) => ({ path: i.path, reason: i.reason })),
          proposedCommand: plan.firstSpike?.proposedCommand ?? null,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Spike for: ${slug}`));
    process.stdout.write(kv('plan', planPath) + '\n');
    if (plan.recommendedMvp?.architectureName) {
      process.stdout.write(kv('mvp', plan.recommendedMvp.architectureName) + '\n');
    }
    process.stdout.write('\n');
    if (willCreate.length > 0) {
      process.stdout.write(`Files ${dryRun ? 'that would be created' : 'created'} (${willCreate.length}):\n`);
      for (const item of willCreate) {
        const purpose = proposed.find((p) => p.path === item.path)?.purpose ?? '';
        process.stdout.write(`  + ${item.path}${purpose ? `  — ${purpose}` : ''}\n`);
      }
    } else {
      process.stdout.write('Nothing new to create.\n');
    }
    if (skipExists.length > 0) {
      process.stdout.write(`\nSkipped (already exist):\n`);
      for (const item of skipExists) process.stdout.write(`  · ${item.path}\n`);
    }
    if (skipUnsafe.length > 0) {
      process.stdout.write(`\nSkipped (unsafe):\n`);
      for (const item of skipUnsafe) {
        process.stdout.write(`  ! ${item.path} — ${item.reason ?? 'unsafe'}\n`);
      }
    }
    if (plan.firstSpike?.proposedCommand) {
      process.stdout.write(`\nNext: run \`${plan.firstSpike.proposedCommand}\`\n`);
    }
    if (plan.firstSpike?.successCriteria && plan.firstSpike.successCriteria.length > 0) {
      process.stdout.write(`\nSuccess criteria:\n`);
      for (const c of plan.firstSpike.successCriteria) process.stdout.write(`  - ${c}\n`);
    }
    return 0;
  },
};

function resolvePlanPath(cwd: string, slug: string): string | null {
  const dir = nodePath.join(cwd, SMART_CONTEXT_DIR);
  if (!existsSync(dir)) return null;
  // Exact match first.
  const exact = nodePath.join(dir, `${slug}.plan.json`);
  if (existsSync(exact)) return exact;
  // Otherwise tolerate <slug>-plan.plan.json and similar suffix patterns.
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.plan.json')) continue;
      const base = name.replace(/\.plan\.json$/, '');
      if (base === slug || base.startsWith(slug)) {
        return nodePath.join(dir, name);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function safeJoin(cwd: string, candidate: string): string | null {
  const normalised = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  if (nodePath.isAbsolute(normalised)) {
    // Permit only if inside cwd.
    const resolved = nodePath.resolve(normalised);
    if (!resolved.startsWith(cwd + nodePath.sep) && resolved !== cwd) return null;
    return resolved;
  }
  const resolved = nodePath.resolve(cwd, normalised);
  if (!resolved.startsWith(cwd + nodePath.sep)) return null;
  return resolved;
}

function renderStarter(input: { path: string; purpose: string; plan: IParsedPlan }): string {
  const ext = nodePath.extname(input.path).toLowerCase();
  const commentOpen = pickCommentOpen(ext);
  const lines: string[] = [];
  const taskOrSummary = input.plan.summary ?? input.plan.task ?? 'smart-context spike';
  lines.push(`${commentOpen} Spike scaffold: ${input.path}`);
  if (input.purpose) lines.push(`${commentOpen} Purpose: ${input.purpose}`);
  lines.push(`${commentOpen} Generated by \`shrk spike\` from a smart-context plan.`);
  lines.push(`${commentOpen} Plan summary: ${taskOrSummary}`);
  const mvp = input.plan.recommendedMvp?.architectureName;
  if (mvp) lines.push(`${commentOpen} MVP: ${mvp}`);
  lines.push(`${commentOpen} Replace this header with the real implementation.`);
  if (input.plan.firstSpike?.schemaOutline !== undefined && (ext === '.json' || ext === '.md')) {
    lines.push('');
    if (ext === '.json') {
      const outlined = typeof input.plan.firstSpike.schemaOutline === 'string'
        ? input.plan.firstSpike.schemaOutline
        : JSON.stringify(input.plan.firstSpike.schemaOutline, null, 2);
      lines.push(outlined);
    } else {
      lines.push('```json');
      lines.push(
        typeof input.plan.firstSpike.schemaOutline === 'string'
          ? input.plan.firstSpike.schemaOutline
          : JSON.stringify(input.plan.firstSpike.schemaOutline, null, 2),
      );
      lines.push('```');
    }
  }
  // For .ts/.tsx files leave a TODO line so the file is syntactically valid.
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
    lines.push('');
    lines.push('// TODO(spike): implement.');
    lines.push('export {};');
  }
  return lines.join('\n') + '\n';
}

function pickCommentOpen(ext: string): string {
  switch (ext) {
    case '.json':
      return '//'; // not technically valid JSON; we replace this body below for .json files
    case '.md':
      return '<!--';
    case '.yml':
    case '.yaml':
      return '#';
    case '.sh':
      return '#';
    default:
      return '//';
  }
}

void statSync;
