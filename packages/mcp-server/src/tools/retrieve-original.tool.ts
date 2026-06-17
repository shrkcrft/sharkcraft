import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * The retrieve half of Compress-Cache-Retrieve. Given a `<<ccr:KEY>>` key
 * emitted by `compress_context`, return the full uncompressed original. Reads
 * from the server's in-memory store only — never the filesystem — so it stays
 * read-only.
 */
export const retrieveOriginalTool: IToolDefinition = {
  name: 'retrieve_original',
  description:
    'Retrieve the full, uncompressed original that `compress_context` cached, by its `<<ccr:KEY>>` key. The reverse of compression — use it when a compressed blob elided a detail you now need. Cache lives for the MCP server session. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The CCR key from a `<<ccr:KEY>>` marker.' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key.length === 0) {
      return {
        isError: true,
        text: 'retrieve_original requires a "key".',
        error: { code: 'invalid-input', message: 'key is required' },
      };
    }
    if (!ctx.ccrStore) {
      return {
        isError: true,
        text: 'No CCR store is wired on this server.',
        error: { code: 'unavailable', message: 'ccr store not available' },
      };
    }
    const entry = ctx.ccrStore.get(key);
    if (!entry) {
      return {
        isError: true,
        text: `No cached original for key "${key}". It may have been evicted (cache is bounded) or never existed in this session.`,
        error: { code: 'cache-miss', message: `unknown ccr key ${key}` },
      };
    }
    return {
      data: { key: entry.key, bytes: entry.bytes, content: entry.content },
      text: entry.content,
    };
  },
};
