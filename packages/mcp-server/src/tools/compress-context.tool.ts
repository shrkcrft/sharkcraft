import {
  compressContent,
  EContentType,
  type ICompressOptions,
} from '@shrkcrft/compress';
import type { IToolDefinition } from '../server/tool-definition.ts';

const CONTENT_TYPES = new Set<string>(Object.values(EContentType));

/**
 * Deterministic context compressor exposed to agents — shrink a blob before it
 * re-enters the prompt, with no model in the loop: it's a pure function of the
 * input. Reversible via the CCR store wired into the server context.
 */
export const compressContextTool: IToolDefinition = {
  name: 'compress_context',
  description:
    'Deterministically compress a blob (tool output, build/test log, grep/search results, unified diff, or JSON) BEFORE you feed it back to the model — same information, far fewer tokens. Routes by content type, hoists JSON object-array schemas into dense tables, and reduces logs/search/diffs to their highest-signal lines. Reversible: when a lossy pass drops detail it caches the original and emits a `<<ccr:KEY>>` marker — call `retrieve_original` to get the full text back. No AI involved; same bytes in, same bytes out. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The text to compress.' },
      contentType: {
        type: 'string',
        description:
          'Force a content class instead of auto-detecting: json | json-array | git-diff | search-results | build-log | source-code | markdown | plain-text.',
      },
      query: {
        type: 'string',
        description: 'Optional task/query text that biases which lines or matches are kept.',
      },
      maxItems: {
        type: 'integer',
        minimum: 1,
        description: 'Soft cap on retained lines / matches / hunks (compressor-specific).',
      },
      maxTokens: {
        type: 'integer',
        minimum: 1,
        description:
          'Token budget for a JSON array. When set and the lossless columnar form still exceeds it, falls back to the lossy SmartCrusher row-sampler (kept rows + CCR original).',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const content = typeof input.content === 'string' ? input.content : '';
    if (content.length === 0) {
      return {
        isError: true,
        text: 'compress_context requires a non-empty "content" string.',
        error: { code: 'invalid-input', message: 'content is required' },
      };
    }
    const opts: ICompressOptions = {};
    if (ctx.ccrStore) opts.store = ctx.ccrStore;
    if (typeof input.query === 'string') opts.query = input.query;
    if (typeof input.maxItems === 'number' && input.maxItems > 0) {
      opts.maxItems = Math.floor(input.maxItems);
    }
    if (typeof input.maxTokens === 'number' && input.maxTokens > 0) {
      opts.maxTokens = Math.floor(input.maxTokens);
    }
    if (typeof input.contentType === 'string' && CONTENT_TYPES.has(input.contentType)) {
      opts.contentType = input.contentType as EContentType;
    }

    const result = compressContent(content, opts);
    const pct = Math.round(result.savings.ratio * 100);
    return {
      data: {
        contentType: result.contentType,
        strategy: result.strategy,
        lossy: result.lossy,
        tokensBefore: result.savings.before,
        tokensAfter: result.savings.after,
        tokensSaved: result.savings.saved,
        savedRatio: result.savings.ratio,
        ccrKey: result.ccrKey ?? null,
        note: result.note,
        compressed: result.compressed,
        ...(result.ccrKey
          ? { retrieveWith: `retrieve_original { "key": "${result.ccrKey}" }` }
          : {}),
      },
      text: `${result.strategy}: ${result.savings.before} → ${result.savings.after} tokens (−${pct}%)${
        result.ccrKey ? ` · original cached as ${result.ccrKey}` : ''
      }`,
    };
  },
};
