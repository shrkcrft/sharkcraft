import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IToolDefinition } from '../server/tool-definition.ts';

const FEED_DIR = nodePath.join('.sharkcraft', 'feed');
const MANIFEST_SCHEMA = 'sharkcraft.shrk-watch-manifest/v1';

/**
 * `smart_context_feed` — read-only MCP surface for an active
 * `shrk watch` JSONL feed.
 *
 * Two modes:
 *   - `list`  → returns active watch manifests under .sharkcraft/feed/.
 *   - `tail`  → returns the JSONL tail of one slug, optionally
 *               filtered by `since` (emittedAt ISO timestamp) or `tailLines`.
 *
 * The agent uses `list` first to discover which watcher is running for
 * which task, then `tail` to pull new packets since the last call.
 * Nothing is written; the daemon CLI (`shrk watch`) is the only
 * producer.
 */
export const smartContextFeedTool: IToolDefinition = {
  name: 'smart_context_feed',
  description:
    'Poll the JSONL feed of an active `shrk watch` daemon. Read-only. Use mode="list" to discover slugs and mode="tail" to pull packets.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string' },
      slug: { type: 'string' },
      since: { type: 'string' },
      tailLines: { type: 'number' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mode = typeof input['mode'] === 'string' ? (input['mode'] as string) : 'list';
    if (mode !== 'list' && mode !== 'tail') {
      return { data: { error: 'invalid-mode', valid: ['list', 'tail'] } };
    }
    const dir = nodePath.join(ctx.cwd, FEED_DIR);
    if (mode === 'list') {
      return { data: listFeeds(dir) };
    }
    const slug = typeof input['slug'] === 'string' ? (input['slug'] as string).trim() : '';
    if (slug.length === 0) {
      return { data: { error: 'slug is required for mode=tail' } };
    }
    const since = typeof input['since'] === 'string' ? (input['since'] as string) : undefined;
    const tailLines = typeof input['tailLines'] === 'number' ? (input['tailLines'] as number) : 50;
    return { data: tailFeed(dir, slug, { since, tailLines }) };
  },
};

interface IManifestSummary {
  slug: string;
  pid: number;
  task: string;
  startedAt: string;
  feedPath: string;
  alive: boolean;
  feedExists: boolean;
}

function listFeeds(dir: string): { active: IManifestSummary[]; stale: IManifestSummary[] } {
  if (!existsSync(dir)) return { active: [], stale: [] };
  const active: IManifestSummary[] = [];
  const stale: IManifestSummary[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { active: [], stale: [] };
  }
  for (const name of entries) {
    if (!name.endsWith('.pid.json')) continue;
    const path = nodePath.join(dir, name);
    let m: {
      schema?: string;
      pid?: number;
      slug?: string;
      task?: string;
      startedAt?: string;
      feedPath?: string;
    };
    try {
      m = JSON.parse(readFileSync(path, 'utf8')) as never;
    } catch {
      continue;
    }
    if (m.schema !== MANIFEST_SCHEMA || typeof m.pid !== 'number') continue;
    const summary: IManifestSummary = {
      slug: m.slug ?? '',
      pid: m.pid,
      task: m.task ?? '',
      startedAt: m.startedAt ?? '',
      feedPath: m.feedPath ?? '',
      alive: isProcessAlive(m.pid),
      feedExists: m.feedPath ? existsSync(m.feedPath) : false,
    };
    (summary.alive ? active : stale).push(summary);
  }
  return { active, stale };
}

function tailFeed(
  dir: string,
  slug: string,
  options: { since?: string; tailLines: number },
): {
  slug: string;
  feedPath: string;
  packets: Array<Record<string, unknown>>;
  totalLines: number;
  filteredOut: number;
  feedExists: boolean;
} {
  const feedPath = nodePath.join(dir, `${slug}.jsonl`);
  if (!existsSync(feedPath)) {
    return { slug, feedPath, packets: [], totalLines: 0, filteredOut: 0, feedExists: false };
  }
  let body: string;
  try {
    body = readFileSync(feedPath, 'utf8');
  } catch {
    return { slug, feedPath, packets: [], totalLines: 0, filteredOut: 0, feedExists: true };
  }
  const rawLines = body.split('\n').filter((l) => l.trim().length > 0);
  const packets: Array<Record<string, unknown>> = [];
  let filteredOut = 0;
  for (const line of rawLines) {
    try {
      const p = JSON.parse(line) as Record<string, unknown>;
      if (options.since) {
        const emittedAt = typeof p['emittedAt'] === 'string' ? (p['emittedAt'] as string) : '';
        if (emittedAt && emittedAt <= options.since) {
          filteredOut += 1;
          continue;
        }
      }
      packets.push(p);
    } catch {
      filteredOut += 1;
    }
  }
  // Keep only the trailing N once filtered.
  const tailed = options.tailLines > 0 ? packets.slice(-options.tailLines) : packets;
  return {
    slug,
    feedPath,
    packets: tailed,
    totalLines: rawLines.length,
    filteredOut,
    feedExists: true,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
