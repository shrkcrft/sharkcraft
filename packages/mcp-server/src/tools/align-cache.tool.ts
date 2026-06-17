import { alignVolatileTokens, restoreVolatileTokens, type IAlignmentMap } from '@shrkcrft/compress';
import type { IToolDefinition } from '../server/tool-definition.ts';

function asAlignmentMap(value: unknown): IAlignmentMap | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const m = value as { version?: unknown; bindings?: unknown };
  if (m.version !== 1 || !Array.isArray(m.bindings)) return undefined;
  return value as IAlignmentMap;
}

/**
 * Active cache-aligner: replace volatile tokens with stable placeholders so a
 * provider KV-cache prefix stays steady across turns. Returns the map in the
 * payload (never writes disk) so the host carries it forward — honouring
 * MCP-never-writes. Reversible via `restore_cache`.
 */
export const alignCacheTool: IToolDefinition = {
  name: 'align_cache',
  description:
    'Replace volatile tokens (UUIDs, JWTs, ISO timestamps, hashes, epochs) in a blob with stable `«vk:…»` placeholders so a provider KV-cache prefix stays stable across turns — same information, fewer cache-busting tokens. Returns the aligned text plus a map; pass the map back in next turn (and to `restore_cache`) so placeholders stay stable. Deterministic, reversible, no model. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The text to align.' },
      map: { type: 'object', description: 'A prior alignment map to carry forward (optional).' },
    },
    required: ['content'],
    additionalProperties: false,
  },
  handler(input) {
    const content = typeof input.content === 'string' ? input.content : '';
    if (content.length === 0) {
      return {
        isError: true,
        text: 'align_cache requires a non-empty "content" string.',
        error: { code: 'invalid-input', message: 'content is required' },
      };
    }
    const prior = asAlignmentMap(input.map);
    const result = alignVolatileTokens(content, prior);
    return {
      data: {
        aligned: result.aligned,
        map: result.map,
        replaced: result.replaced,
        restoreWith: 'restore_cache { "content": "<aligned>", "map": <map> }',
      },
      text: result.aligned,
    };
  },
};

/** The restore half of {@link alignCacheTool}. Read-only. */
export const restoreCacheTool: IToolDefinition = {
  name: 'restore_cache',
  description:
    'Reverse `align_cache`: restore the original volatile tokens in an aligned blob using its map. Lossless. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Aligned text containing `«vk:…»` placeholders.' },
      map: { type: 'object', description: 'The alignment map returned by `align_cache`.' },
    },
    required: ['content', 'map'],
    additionalProperties: false,
  },
  handler(input) {
    const content = typeof input.content === 'string' ? input.content : '';
    const map = asAlignmentMap(input.map);
    if (!map) {
      return {
        isError: true,
        text: 'restore_cache requires the `map` returned by align_cache.',
        error: { code: 'invalid-input', message: 'a valid alignment map is required' },
      };
    }
    const restored = restoreVolatileTokens(content, map);
    return { data: { restored }, text: restored };
  },
};
