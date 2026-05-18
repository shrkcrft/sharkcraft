import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAgentBrief,
  BriefMode,
  getChangedFiles,
  inspectSharkcraft,
  setDevNextAction,
  writeDevSessionState,
  scanDevSession,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const VALID_MODES = new Set(Object.values(BriefMode));

function resolveMode(args: ParsedArgs): BriefMode | undefined {
  const raw = flagString(args, 'mode');
  if (!raw) return undefined;
  if (!VALID_MODES.has(raw as BriefMode)) {
    process.stderr.write(`Unknown --mode "${raw}". Use ${[...VALID_MODES].join('|')}.\n`);
    process.exit(2);
  }
  return raw as BriefMode;
}

export const briefCommand: ICommandHandler = {
  name: 'brief',
  description:
    'Render a single Markdown / JSON brief for an AI agent before it starts work. Read-only.',
  usage:
    'shrk brief "<task>" [--mode compact|full|review|implementation|handoff] [--since ref] [--staged] [--files a,b] [--bundle id] [--session id] [--output file.md] [--chunk [--output-dir <dir>]] [--section-budget rules=N,impact=N] [--max-tokens N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const mode = resolveMode(args);
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const files = flagList(args, 'files');
    const bundleId = flagString(args, 'bundle');
    const sessionId = flagString(args, 'session');
    const maxTokens = flagNumber(args, 'max-tokens');

    const fileSet: string[] = [...files];
    if (since) fileSet.push(...getChangedFiles(cwd, { since }));
    if (staged) fileSet.push(...getChangedFiles(cwd, { staged: true }));

    const wantChunked = flagBool(args, 'chunk') || flagBool(args, 'chunked');
    const outputDir = flagString(args, 'output-dir');
    const sectionBudgetRaw = flagString(args, 'section-budget');
    const sectionBudgets: Record<string, number> = {};
    if (sectionBudgetRaw) {
      for (const pair of sectionBudgetRaw.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v && !Number.isNaN(Number(v))) sectionBudgets[k.trim()] = Number(v);
      }
    }

    const brief = await buildAgentBrief(inspection, {
      ...(task ? { task } : {}),
      ...(mode ? { mode } : {}),
      files: [...new Set(fileSet)],
      ...(since ? { since } : {}),
      staged,
      ...(bundleId ? { bundleId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(wantChunked ? { chunked: true } : {}),
      ...(Object.keys(sectionBudgets).length > 0 ? { sectionBudgets } : {}),
    });

    if (wantChunked) {
      const dir = outputDir
        ? nodePath.isAbsolute(outputDir)
          ? outputDir
          : nodePath.resolve(cwd, outputDir)
        : null;
      // Hashes for every section, used for cross-session delta detection.
      const sectionHashes: Record<string, string> = {};
      for (const c of brief.chunks ?? []) {
        sectionHashes[c.sectionId] = createHash('sha256').update(c.body).digest('hex');
      }
      if (dir) {
        mkdirSync(dir, { recursive: true });
        for (const c of brief.chunks ?? []) {
          writeFileSync(nodePath.join(dir, c.file), c.body, 'utf8');
        }
        writeFileSync(
          nodePath.join(dir, 'section-hashes.json'),
          JSON.stringify({ schema: 'sharkcraft.brief-section-hashes/v1', task: brief.task, sectionHashes }, null, 2) + '\n',
          'utf8',
        );
      }
      // Optional comparison against a previous brief chunk directory.
      let compareReport: ReturnType<typeof compareBriefDirs> | null = null;
      const compareWith = flagString(args, 'compare-with');
      if (compareWith) {
        const otherAbs = nodePath.isAbsolute(compareWith)
          ? compareWith
          : nodePath.resolve(cwd, compareWith);
        compareReport = compareBriefDirs(brief.chunks ?? [], otherAbs);
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({ ...brief, outputDir: dir, sectionHashes, compare: compareReport }) + '\n',
        );
      } else {
        if (dir) {
          process.stdout.write(`Wrote ${brief.chunks?.length ?? 0} chunk(s) to ${dir}\n`);
        } else {
          for (const c of brief.chunks ?? []) {
            process.stdout.write(`\n--- ${c.file} (${c.tokenEstimate} toks) ---\n`);
            process.stdout.write(c.body);
          }
        }
        if (compareReport) {
          process.stdout.write(
            `\nCompare vs ${compareReport.otherDir}:\n` +
              `  unchanged=${compareReport.unchanged.length}  changed=${compareReport.changed.length}  new=${compareReport.added.length}  removed=${compareReport.removed.length}\n`,
          );
          if (compareReport.changed.length > 0) {
            process.stdout.write('  changed:\n');
            for (const c of compareReport.changed.slice(0, 20))
              process.stdout.write(`    ~ ${c.sectionId} (${c.file})\n`);
          }
          if (compareReport.added.length > 0) {
            process.stdout.write('  new:\n');
            for (const c of compareReport.added.slice(0, 20))
              process.stdout.write(`    + ${c.sectionId} (${c.file})\n`);
          }
          if (compareReport.removed.length > 0) {
            process.stdout.write('  removed:\n');
            for (const c of compareReport.removed.slice(0, 20))
              process.stdout.write(`    - ${c.sectionId} (${c.file})\n`);
          }
        }
      }
      return 0;
    }

    const output = flagString(args, 'output');
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, brief.markdown, 'utf8');
      // If --session was used and output went into the session dir, record the path.
      if (sessionId) {
        const load = scanDevSession(cwd, sessionId);
        if (load?.state) {
          const dir = load.dir;
          if (abs.startsWith(dir + nodePath.sep)) {
            const updated = setDevNextAction(load.state, load.state.nextAction);
            // mutate session.json with brief path stored under nextAction-adjacent metadata via warnings is awkward;
            // we just leave the path on disk.
            writeDevSessionState(cwd, updated);
          }
        }
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ ...brief, outputPath: abs }) + '\n');
      } else {
        process.stdout.write(`Wrote ${abs}\n`);
      }
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(brief) + '\n');
      return 0;
    }
    process.stdout.write(brief.markdown);
    return 0;
  },
};

interface IBriefCompareEntry {
  sectionId: string;
  file: string;
}

interface IBriefCompareReport {
  otherDir: string;
  unchanged: IBriefCompareEntry[];
  changed: IBriefCompareEntry[];
  added: IBriefCompareEntry[];
  removed: IBriefCompareEntry[];
}

function sectionIdFromFile(name: string): string {
  // Chunks are named NN-<sectionId>.md (e.g. 01-task.md). Strip the prefix.
  const trimmed = name.replace(/\.md$/, '');
  const m = /^\d+-(.+)$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

function compareBriefDirs(
  currentChunks: readonly { file: string; sectionId: string; body: string }[],
  otherDir: string,
): IBriefCompareReport {
  const currentMap = new Map<string, { file: string; body: string }>();
  for (const c of currentChunks) currentMap.set(c.sectionId, { file: c.file, body: c.body });

  const otherMap = new Map<string, { file: string; body: string }>();
  if (existsSync(otherDir)) {
    for (const f of readdirSync(otherDir)) {
      if (!f.endsWith('.md')) continue;
      const full = nodePath.join(otherDir, f);
      if (!statSync(full).isFile()) continue;
      const id = sectionIdFromFile(f);
      try {
        otherMap.set(id, { file: f, body: readFileSync(full, 'utf8') });
      } catch {
        /* skip */
      }
    }
  }
  const unchanged: IBriefCompareEntry[] = [];
  const changed: IBriefCompareEntry[] = [];
  const added: IBriefCompareEntry[] = [];
  const removed: IBriefCompareEntry[] = [];
  for (const [id, cur] of currentMap) {
    const other = otherMap.get(id);
    if (!other) {
      added.push({ sectionId: id, file: cur.file });
    } else if (other.body === cur.body) {
      unchanged.push({ sectionId: id, file: cur.file });
    } else {
      changed.push({ sectionId: id, file: cur.file });
    }
  }
  for (const [id, other] of otherMap) {
    if (!currentMap.has(id)) removed.push({ sectionId: id, file: other.file });
  }
  return { otherDir, unchanged, changed, added, removed };
}

void existsSync;
