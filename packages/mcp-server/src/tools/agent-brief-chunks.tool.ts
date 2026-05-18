import { createHash } from 'node:crypto';
import { buildAgentBrief, BriefMode, type IAgentBrief } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface ICachedBrief {
  briefId: string;
  brief: IAgentBrief;
  expiresAt: number;
  /** Hash of the canonical input — also used as the cache key. */
  inputHash: string;
  /** Map of sectionId → sha256 of the section body, for delta comparison. */
  sectionHashes: Record<string, string>;
  /** Original task for delta-by-task lookup. */
  task: string;
}

const VALID_MODES = new Set(Object.values(BriefMode));
const CACHE = new Map<string, ICachedBrief>();
const TTL_MS = 60 * 60 * 1000; // one hour
const SERVER_STARTED_AT = Date.now();

function gcCache(): void {
  const now = Date.now();
  for (const [k, v] of CACHE) {
    if (v.expiresAt < now) CACHE.delete(k);
  }
}

function canonicalInput(input: Record<string, unknown>): string {
  return JSON.stringify({
    task: input['task'] ?? '',
    mode: input['mode'] ?? '',
    files: [...((input['files'] as string[]) ?? [])].sort(),
    bundleId: input['bundleId'] ?? '',
    sessionId: input['sessionId'] ?? '',
    maxTokens: input['maxTokens'] ?? null,
    sectionBudgets: input['sectionBudgets'] ?? {},
  });
}

function computeBriefId(input: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalInput(input)).digest('hex').slice(0, 16);
}

interface IChunkInputShape {
  task?: unknown;
  mode?: unknown;
  files?: unknown;
  bundleId?: unknown;
  sessionId?: unknown;
  maxTokens?: unknown;
  sectionBudgets?: unknown;
}

function inputForBrief(input: IChunkInputShape): Parameters<typeof buildAgentBrief>[1] {
  const task = typeof input.task === 'string' ? input.task : undefined;
  const modeRaw = typeof input.mode === 'string' ? input.mode : undefined;
  const mode = modeRaw && VALID_MODES.has(modeRaw as BriefMode) ? (modeRaw as BriefMode) : undefined;
  const files = Array.isArray(input.files) ? (input.files as string[]) : [];
  const bundleId = typeof input.bundleId === 'string' ? input.bundleId : undefined;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
  const maxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : undefined;
  const sectionBudgets =
    typeof input.sectionBudgets === 'object' && input.sectionBudgets !== null
      ? (input.sectionBudgets as Record<string, number>)
      : undefined;
  return {
    ...(task ? { task } : {}),
    ...(mode ? { mode } : {}),
    files,
    ...(bundleId ? { bundleId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(sectionBudgets ? { sectionBudgets } : {}),
    chunked: true,
  };
}

export const startAgentBriefChunksTool: IToolDefinition = {
  name: 'start_agent_brief_chunks',
  description:
    'Build a chunked agent brief and cache it server-side. Returns a deterministic briefId + index. Use `get_agent_brief_chunk` / `get_agent_brief_chunk_index` to retrieve chunks individually. Optional `previousSectionHashes` lets the caller request a section-level delta even when no in-memory cache exists. Read-only — no filesystem writes.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      mode: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      bundleId: { type: 'string' },
      sessionId: { type: 'string' },
      maxTokens: { type: 'number' },
      sectionBudgets: { type: 'object' },
      previousSectionHashes: { type: 'object' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    gcCache();
    const briefId = computeBriefId(input as Record<string, unknown>);
    const inputHash = createHash('sha256')
      .update(canonicalInput(input as Record<string, unknown>))
      .digest('hex');
    let cached = CACHE.get(briefId);
    let reused = false;
    let previousBriefId: string | null = null;
    let deltaSummary:
      | { reused: number; changed: number; unchanged: number; new: number; removed: number }
      | null = null;
    let priorSectionHashes: Record<string, string> | null = null;
    // Caller can pass previousSectionHashes directly so the delta works
    // across server restarts / cold caches.
    const explicitPrior = (input as { previousSectionHashes?: unknown }).previousSectionHashes;
    if (explicitPrior && typeof explicitPrior === 'object') {
      const candidate: Record<string, string> = {};
      for (const [k, v] of Object.entries(explicitPrior)) {
        if (typeof v === 'string') candidate[k] = v;
      }
      if (Object.keys(candidate).length > 0) {
        priorSectionHashes = candidate;
      }
    }
    if (cached) {
      reused = true;
    } else {
      // Look for the most recent cached brief with the same `task` so we can
      // report which sections actually changed.
      const taskRaw = (input as { task?: unknown })['task'];
      const task = typeof taskRaw === 'string' ? taskRaw : '';
      if (task && !priorSectionHashes) {
        let best: ICachedBrief | null = null;
        for (const candidate of CACHE.values()) {
          if (candidate.task !== task) continue;
          if (!best || candidate.expiresAt > best.expiresAt) best = candidate;
        }
        if (best) {
          previousBriefId = best.briefId;
          priorSectionHashes = best.sectionHashes;
        }
      }
      const brief = await buildAgentBrief(ctx.inspection, inputForBrief(input as IChunkInputShape));
      const sectionHashes: Record<string, string> = {};
      for (const c of brief.chunks ?? []) {
        sectionHashes[c.sectionId] = createHash('sha256').update(c.body).digest('hex');
      }
      cached = {
        briefId,
        brief,
        expiresAt: Date.now() + TTL_MS,
        inputHash,
        sectionHashes,
        task,
      };
      CACHE.set(briefId, cached);
      if (priorSectionHashes) {
        let same = 0;
        let changed = 0;
        let added = 0;
        const seen = new Set<string>();
        for (const [id, h] of Object.entries(sectionHashes)) {
          seen.add(id);
          const prev = priorSectionHashes[id];
          if (prev === undefined) added += 1;
          else if (prev === h) same += 1;
          else changed += 1;
        }
        let removed = 0;
        for (const id of Object.keys(priorSectionHashes)) if (!seen.has(id)) removed += 1;
        deltaSummary = { reused: same, changed, unchanged: same, new: added, removed };
      }
    }
    const chunks = cached.brief.chunks ?? [];
    return {
      data: {
        briefId,
        mode: cached.brief.mode,
        task: cached.brief.task,
        totalChunks: chunks.length,
        totalTokenEstimate: cached.brief.totalTokenEstimate,
        cacheTtlMs: TTL_MS,
        expiresAt: new Date(cached.expiresAt).toISOString(),
        deterministicInputHash: inputHash,
        canRecreate: true,
        reused,
        previousBriefId,
        delta: deltaSummary,
        sectionHashes: cached.sectionHashes,
        serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
        index: chunks.map((c, i) => ({
          order: i,
          file: c.file,
          sectionId: c.sectionId,
          title: c.title,
          tokenEstimate: c.tokenEstimate,
        })),
      },
    };
  },
};

export const getAgentBriefChunkIndexTool: IToolDefinition = {
  name: 'get_agent_brief_chunk_index',
  description: 'Return the chunk index for a brief previously started via `start_agent_brief_chunks`. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['briefId'],
    properties: { briefId: { type: 'string' } },
  },
  handler(input) {
    gcCache();
    const briefId = String(input['briefId'] ?? '');
    const cached = CACHE.get(briefId);
    if (!cached) {
      return {
        isError: true,
        text: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted. Re-run start_agent_brief_chunks with the same input — briefIds are deterministic.`,
        data: {
          error: {
            code: 'cache-miss',
            message: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted.`,
            briefId,
            canRecreate: true,
            recommendedCall: {
              tool: 'start_agent_brief_chunks',
              note:
                'Call start_agent_brief_chunks with the original inputs. The briefId is deterministic so re-creating with the same input recovers the same id.',
            },
            serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
          },
        },
        error: {
          code: 'cache-miss',
          message: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted.`,
          details: {
            briefId,
            canRecreate: true,
            recommendedCall: {
              tool: 'start_agent_brief_chunks',
              note:
                'Call start_agent_brief_chunks with the original inputs. The briefId is deterministic so re-creating with the same input recovers the same id.',
            },
            serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
          },
        },
      };
    }
    const chunks = cached.brief.chunks ?? [];
    return {
      data: {
        briefId,
        mode: cached.brief.mode,
        task: cached.brief.task,
        totalChunks: chunks.length,
        totalTokenEstimate: cached.brief.totalTokenEstimate,
        expiresAt: new Date(cached.expiresAt).toISOString(),
        deterministicInputHash: cached.inputHash,
        canRecreate: true,
        index: chunks.map((c, i) => ({
          order: i,
          file: c.file,
          sectionId: c.sectionId,
          title: c.title,
          tokenEstimate: c.tokenEstimate,
        })),
      },
    };
  },
};

export const getAgentBriefChunkTool: IToolDefinition = {
  name: 'get_agent_brief_chunk',
  description:
    'Retrieve one chunk of a previously-started brief by id and either `order` or `sectionId`. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['briefId'],
    properties: {
      briefId: { type: 'string' },
      order: { type: 'number' },
      sectionId: { type: 'string' },
    },
  },
  handler(input) {
    gcCache();
    const briefId = String(input['briefId'] ?? '');
    const cached = CACHE.get(briefId);
    if (!cached) {
      return {
        isError: true,
        text: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted. Re-run start_agent_brief_chunks with the same input — briefIds are deterministic.`,
        data: {
          error: {
            code: 'cache-miss',
            message: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted.`,
            briefId,
            canRecreate: true,
            recommendedCall: {
              tool: 'start_agent_brief_chunks',
              note:
                'Call start_agent_brief_chunks with the original inputs. The briefId is deterministic so re-creating with the same input recovers the same id.',
            },
            serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
          },
        },
        error: {
          code: 'cache-miss',
          message: `No cached brief for id "${briefId}". Cache may have evicted or the server restarted.`,
          details: {
            briefId,
            canRecreate: true,
            recommendedCall: {
              tool: 'start_agent_brief_chunks',
              note:
                'Call start_agent_brief_chunks with the original inputs. The briefId is deterministic so re-creating with the same input recovers the same id.',
            },
            serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
          },
        },
      };
    }
    const chunks = cached.brief.chunks ?? [];
    const order = typeof input['order'] === 'number' ? (input['order'] as number) : undefined;
    const sectionId =
      typeof input['sectionId'] === 'string' ? (input['sectionId'] as string) : undefined;
    let chunk = chunks[0];
    if (typeof order === 'number') {
      chunk = chunks[order];
    } else if (sectionId) {
      chunk = chunks.find((c) => c.sectionId === sectionId);
    }
    if (!chunk) {
      return {
        isError: true,
        text: `No chunk for order=${order ?? '?'} sectionId=${sectionId ?? '?'}.`,
        error: {
          code: 'not-found',
          message: `No chunk for order=${order ?? '?'} sectionId=${sectionId ?? '?'}.`,
          details: { briefId, totalChunks: chunks.length },
        },
      };
    }
    return {
      data: {
        briefId,
        file: chunk.file,
        sectionId: chunk.sectionId,
        title: chunk.title,
        body: chunk.body,
        tokenEstimate: chunk.tokenEstimate,
        expiresAt: new Date(cached.expiresAt).toISOString(),
      },
    };
  },
};

export function _resetAgentBriefChunkCache(): void {
  CACHE.clear();
}
