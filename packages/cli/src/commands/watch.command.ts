import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import * as nodePath from 'node:path';
import { buildTaskPacket, inspectSharkcraft } from '@shrkcrft/inspector';
import {
  SemanticIndex,
  TaskType,
  buildFocusedContext,
  classifyTask,
  listIndexableFiles,
  parseTaskTypeOverride,
  type IFocusedContext,
} from '@shrkcrft/embeddings';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const FEED_DIR = nodePath.join('.sharkcraft', 'feed');
const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_INTERVAL_MS = 0; // off by default; --interval to enable
const MANIFEST_SCHEMA = 'sharkcraft.shrk-watch-manifest/v1';

interface IWatchManifest {
  schema: typeof MANIFEST_SCHEMA;
  pid: number;
  slug: string;
  task: string;
  startedAt: string;
  feedPath: string;
  intervalMs: number;
  debounceMs: number;
}

function manifestPath(cwd: string, slug: string): string {
  return nodePath.join(cwd, FEED_DIR, `${slug}.pid.json`);
}

function readManifest(path: string): IWatchManifest | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as IWatchManifest;
    if (m.schema !== MANIFEST_SCHEMA || typeof m.pid !== 'number') return null;
    return m;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `shrk watch "<task>"` — emit a fresh task-focused context bundle on
 * stdout JSONL each time the workspace changes.
 *
 * Designed to run in a terminal *next to* Claude Code so the agent has
 * a continuously-refreshed "feed" of the most relevant code for the
 * current task — no extra LLM calls, just BGE-ranked deltas.
 *
 * Surfaces:
 *   - stdout: one JSON line per packet, NDJSON-style.
 *   - filesystem: same packet appended to
 *     `.sharkcraft/feed/<slug>.jsonl` so other tools (or the user)
 *     can tail it from elsewhere.
 *
 * Cost: every emission is O(BGE-search + re-rank) — typically
 * 100–300 ms for ~10 candidate files. We never call a generative LLM.
 */
export const watchCommand: ICommandHandler = {
  name: 'watch',
  description:
    'Emit a focused-context packet on stdout JSONL each time the workspace changes (or every --interval seconds). No LLM calls.',
  usage:
    'shrk watch "<task>" [--interval N] [--debounce ms] [--task-type <type>] [--once] [--quiet] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk watch "<task>" [--interval N] [--once] [--debounce ms]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const once = flagBool(args, 'once');
    const quiet = flagBool(args, 'quiet') || flagBool(args, 'json');
    const debounceMs = flagNumber(args, 'debounce') ?? DEFAULT_DEBOUNCE_MS;
    const intervalSec = flagNumber(args, 'interval') ?? 0;
    const intervalMs = intervalSec > 0 ? intervalSec * 1000 : DEFAULT_INTERVAL_MS;
    const overrideRaw = flagString(args, 'task-type');
    const taskTypeOverride = parseTaskTypeOverride(overrideRaw);

    const index = await SemanticIndex.tryLoad(cwd);
    if (!index) {
      process.stderr.write(
        '[shrk watch] no semantic index — run `shrk smart-context embeddings-build` first.\n',
      );
      return 1;
    }

    const slug = slugify(task);
    const feedDir = nodePath.join(cwd, FEED_DIR);
    mkdirSync(feedDir, { recursive: true });
    const feedPath = nodePath.join(feedDir, `${slug}.jsonl`);
    const manifestFilePath = manifestPath(cwd, slug);

    // Daemon manifest check — one watcher per (cwd, slug). Allows the agent
    // and the human to know which watcher owns which feed, and prevents two
    // processes from racing on the same JSONL.
    if (!once) {
      const existing = readManifest(manifestFilePath);
      if (existing && isProcessAlive(existing.pid)) {
        if (flagBool(args, 'replace')) {
          try {
            process.kill(existing.pid, 'SIGTERM');
          } catch {
            // best effort
          }
          // Give the old process a moment to clean up.
          await new Promise((r) => setTimeout(r, 250));
        } else {
          process.stderr.write(
            `[shrk watch] another watcher is already running for slug "${slug}" (pid ${existing.pid}).\n` +
              `  → Use \`shrk watch list\` to see active feeds.\n` +
              `  → Use \`shrk watch stop ${slug}\` to stop it.\n` +
              `  → Pass --replace to take over.\n`,
          );
          return 1;
        }
      } else if (existing) {
        // Stale manifest (pid not alive) — clean up.
        try {
          rmSync(manifestFilePath, { force: true });
        } catch {
          /* ignore */
        }
      }
      const manifest: IWatchManifest = {
        schema: MANIFEST_SCHEMA,
        pid: process.pid,
        slug,
        task,
        startedAt: new Date().toISOString(),
        feedPath,
        intervalMs,
        debounceMs,
      };
      writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }

    if (!quiet) {
      process.stderr.write(
        `[shrk watch] task: "${task}"\n[shrk watch] feed: ${feedPath}\n[shrk watch] press Ctrl+C to stop.\n`,
      );
    }

    let lastHash = '';
    let lastEmittedAt = 0;
    const emit = async (reason: string): Promise<void> => {
      const packet = await buildPacket({
        cwd,
        task,
        index,
        taskTypeOverride,
        reason,
      });
      const fingerprint = packet.fingerprint;
      if (fingerprint === lastHash) {
        // Same content — skip noisy duplicate emissions.
        return;
      }
      lastHash = fingerprint;
      lastEmittedAt = Date.now();
      const line = asJson(packet);
      process.stdout.write(line + '\n');
      try {
        appendFileSync(feedPath, line + '\n', 'utf8');
      } catch (e) {
        process.stderr.write(`[shrk watch] feed write failed: ${(e as Error).message}\n`);
      }
    };

    // Initial emission.
    await emit('start');
    if (once) return 0;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEmit = (reason: string): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void emit(reason);
      }, debounceMs);
    };

    const watchers: FSWatcher[] = [];
    const roots = ['packages', 'examples', 'sharkcraft', 'docs', 'libs']
      .map((p) => nodePath.join(cwd, p))
      .filter((abs) => existsSync(abs));
    for (const root of roots) {
      try {
        const w = fsWatch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          if (!shouldReactTo(String(filename))) return;
          scheduleEmit(`change:${filename}`);
        });
        watchers.push(w);
      } catch (e) {
        process.stderr.write(`[shrk watch] could not watch ${root}: ${(e as Error).message}\n`);
      }
    }

    // Optional interval-based emission so an idle workspace still
    // produces fresh packets (handy for "every N seconds, refresh").
    const intervalHandle =
      intervalMs > 0
        ? setInterval(() => {
            if (Date.now() - lastEmittedAt < intervalMs / 2) return;
            scheduleEmit('interval');
          }, intervalMs)
        : null;

    return new Promise<number>((resolve) => {
      const shutdown = (code: number): void => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (intervalHandle) clearInterval(intervalHandle);
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        }
        try {
          if (existsSync(manifestFilePath)) {
            const cur = readManifest(manifestFilePath);
            if (cur && cur.pid === process.pid) rmSync(manifestFilePath, { force: true });
          }
        } catch {
          /* ignore */
        }
        if (!quiet) process.stderr.write('\n[shrk watch] stopped.\n');
        resolve(code);
      };
      const onSignal = (): void => shutdown(0);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });
  },
};

/** `shrk watch list` — show all active and stale watch manifests. */
export const watchListCommand: ICommandHandler = {
  name: 'list',
  description: 'List active shrk-watch daemons by reading manifests in .sharkcraft/feed/.',
  usage: 'shrk watch list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const dir = nodePath.join(cwd, FEED_DIR);
    if (!existsSync(dir)) {
      if (json) process.stdout.write(asJson({ active: [], stale: [] }) + '\n');
      else process.stdout.write('No watch feeds yet.\n');
      return 0;
    }
    const entries = readdirSync(dir).filter((n) => n.endsWith('.pid.json'));
    const active: Array<IWatchManifest & { feedSize?: number }> = [];
    const stale: Array<{ slug: string; pid: number; startedAt: string }> = [];
    for (const name of entries) {
      const m = readManifest(nodePath.join(dir, name));
      if (!m) continue;
      if (isProcessAlive(m.pid)) {
        let feedSize: number | undefined;
        try {
          feedSize = statSync(m.feedPath).size;
        } catch {
          /* ignore */
        }
        active.push({ ...m, ...(feedSize !== undefined ? { feedSize } : {}) });
      } else {
        stale.push({ slug: m.slug, pid: m.pid, startedAt: m.startedAt });
      }
    }
    if (json) {
      process.stdout.write(asJson({ active, stale }) + '\n');
      return 0;
    }
    if (active.length === 0 && stale.length === 0) {
      process.stdout.write('No watch feeds.\n');
      return 0;
    }
    if (active.length > 0) {
      process.stdout.write(`Active watchers (${active.length}):\n`);
      for (const w of active) {
        process.stdout.write(
          `  ${w.slug.padEnd(50)}  pid ${String(w.pid).padEnd(8)}  ${w.startedAt}\n    → ${w.feedPath}${w.feedSize !== undefined ? ` (${w.feedSize} bytes)` : ''}\n`,
        );
      }
    }
    if (stale.length > 0) {
      process.stdout.write(`\nStale manifests (process not alive):\n`);
      for (const w of stale) {
        process.stdout.write(`  ${w.slug} (pid ${w.pid}, started ${w.startedAt})\n`);
      }
      process.stdout.write('  → Run `shrk watch prune` to clean them up.\n');
    }
    return 0;
  },
};

/** `shrk watch stop <slug>` — SIGTERM the matching watcher. */
export const watchStopCommand: ICommandHandler = {
  name: 'stop',
  description: 'Stop a running shrk-watch daemon by slug (sends SIGTERM and waits for it to exit).',
  usage: 'shrk watch stop <slug> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const slug = args.positional[0]?.trim();
    if (!slug) {
      process.stderr.write('Usage: shrk watch stop <slug>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const path = manifestPath(cwd, slug);
    const m = readManifest(path);
    if (!m) {
      if (json) process.stdout.write(asJson({ status: 'not-found', slug }) + '\n');
      else process.stderr.write(`No watcher manifest found for slug "${slug}".\n`);
      return 1;
    }
    if (!isProcessAlive(m.pid)) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
      if (json) process.stdout.write(asJson({ status: 'stale', slug, pid: m.pid }) + '\n');
      else process.stdout.write(`Watcher for "${slug}" was stale (pid ${m.pid}); cleaned up manifest.\n`);
      return 0;
    }
    try {
      process.kill(m.pid, 'SIGTERM');
    } catch (e) {
      process.stderr.write(`Failed to signal pid ${m.pid}: ${(e as Error).message}\n`);
      return 1;
    }
    // Wait briefly for the process to exit and clean its own manifest.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (!isProcessAlive(m.pid)) break;
    }
    if (json) process.stdout.write(asJson({ status: 'stopped', slug, pid: m.pid }) + '\n');
    else process.stdout.write(`Stopped watcher "${slug}" (pid ${m.pid}).\n`);
    return 0;
  },
};

/** `shrk watch prune` — remove stale manifests. */
export const watchPruneCommand: ICommandHandler = {
  name: 'prune',
  description: 'Remove stale shrk-watch manifests (pid not alive). Safe to run anytime.',
  usage: 'shrk watch prune [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const dir = nodePath.join(cwd, FEED_DIR);
    if (!existsSync(dir)) {
      if (json) process.stdout.write(asJson({ removed: [] }) + '\n');
      else process.stdout.write('No feed directory; nothing to prune.\n');
      return 0;
    }
    const removed: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.pid.json'))) {
      const path = nodePath.join(dir, name);
      const m = readManifest(path);
      if (!m || !isProcessAlive(m.pid)) {
        try {
          rmSync(path, { force: true });
          removed.push(m?.slug ?? name);
        } catch {
          /* ignore */
        }
      }
    }
    if (json) process.stdout.write(asJson({ removed }) + '\n');
    else process.stdout.write(removed.length === 0 ? 'No stale manifests.\n' : `Pruned: ${removed.join(', ')}\n`);
    return 0;
  },
};

interface IWatchPacket {
  schema: 'sharkcraft.shrk-watch-packet/v1';
  task: string;
  taskSlug: string;
  taskType: string;
  emittedAt: string;
  reason: string;
  fingerprint: string;
  focused: {
    model: string;
    approxTokens: number;
    files: IFocusedContext['files'];
    rules: IFocusedContext['rules'];
    docHits: IFocusedContext['docHits'];
    verificationCommands: readonly string[];
  };
  hints: {
    pull: 'shrk smart-context "<task>" --focused --tiny-only --json';
    plan: 'shrk smart-context "<task>" --focused --plan --save';
    spike: 'shrk spike <slug>';
  };
}

async function buildPacket(input: {
  cwd: string;
  task: string;
  index: SemanticIndex;
  taskTypeOverride: TaskType | null;
  reason: string;
}): Promise<IWatchPacket> {
  const inspection = await inspectSharkcraft({ cwd: input.cwd });
  const packet = buildTaskPacket(inspection, input.task, { maxTokens: 3500 });
  const focused = await buildFocusedContext({
    cwd: input.cwd,
    task: input.task,
    index: input.index,
    rules: packet.relevantRules,
    verificationCommands: packet.verificationCommands,
  });
  const taskType = input.taskTypeOverride ?? classifyTask(input.task).type;
  const summarisedFiles = focused.files.map((f) => ({
    path: f.path,
    fileSimilarity: f.fileSimilarity,
    summary: f.summary,
    blocks: f.blocks.map((b) => ({
      name: b.name,
      kind: b.kind,
      startLine: b.startLine,
      similarity: b.similarity,
    })),
  }));
  // Fingerprint = which files + their similarities + which blocks ranked.
  // Same diff round-trip = same fingerprint = no re-emission.
  const fp = createHash('sha1')
    .update(JSON.stringify({ taskType, files: summarisedFiles }))
    .digest('hex')
    .slice(0, 16);
  return {
    schema: 'sharkcraft.shrk-watch-packet/v1',
    task: input.task,
    taskSlug: slugify(input.task),
    taskType,
    emittedAt: new Date().toISOString(),
    reason: input.reason,
    fingerprint: fp,
    focused: {
      model: focused.model,
      approxTokens: focused.approxTokens,
      files: focused.files,
      rules: focused.rules,
      docHits: focused.docHits,
      verificationCommands: focused.verificationCommands,
    },
    hints: {
      pull: 'shrk smart-context "<task>" --focused --tiny-only --json',
      plan: 'shrk smart-context "<task>" --focused --plan --save',
      spike: 'shrk spike <slug>',
    },
  };
}

function shouldReactTo(filename: string): boolean {
  if (filename.startsWith('.git/')) return false;
  if (filename.includes('node_modules/')) return false;
  if (filename.includes('/dist/') || filename.endsWith('/dist')) return false;
  if (filename.includes('.sharkcraft/')) return false; // never feed our own writes back in
  if (filename.includes('.next/')) return false;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|md|json|yml|yaml)$/.test(filename)) return true;
  return false;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .slice(0, 60) || 'task'
  );
}
