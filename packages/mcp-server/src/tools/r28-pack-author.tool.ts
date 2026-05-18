/**
 * Read-only pack-author tools.
 *
 *  get_pack_dev_status — pack dev status (source/symlink/node_modules, signature staleness).
 *
 *  No watch-over-MCP (would imply long-running tool state) — use the CLI for that.
 */
import { buildPackDevStatus, runPackTests } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { isAbsolute, resolve } from 'node:path';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getPackDevStatusTool: IToolDefinition = {
  name: 'get_pack_dev_status',
  description:
    'Inspect a pack under development: how the consumer sees it, signed-manifest staleness, contribution counts. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['packPath'],
    properties: {
      packPath: { type: 'string' },
      consumerPath: { type: 'string' },
    },
  },
  handler(input, ctx) {
    const packPath = String(input.packPath ?? '');
    const consumerPath = typeof input.consumerPath === 'string' ? input.consumerPath : undefined;
    const abs = isAbsolute(packPath) ? packPath : resolve(ctx.cwd, packPath);
    const consumerAbs = consumerPath
      ? (isAbsolute(consumerPath) ? consumerPath : resolve(ctx.cwd, consumerPath))
      : undefined;
    const status = buildPackDevStatus({
      packPath: abs,
      ...(consumerAbs ? { consumerPath: consumerAbs } : {}),
    });
    return {
      text: nextHint(`shrk packs dev-status ${packPath}`),
      data: status,
    };
  },
};

export const previewPackTestsTool: IToolDefinition = {
  name: 'preview_pack_tests',
  description:
    'Run definePackTest cases against a pack and return the report. Read-only — never writes snapshots; use the CLI for that.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['packPath'],
    properties: {
      packPath: { type: 'string' },
      caseId: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const packPath = String(input.packPath ?? '');
    const caseId = typeof input.caseId === 'string' ? input.caseId : undefined;
    const abs = isAbsolute(packPath) ? packPath : resolve(ctx.cwd, packPath);
    const report = await runPackTests({
      packPath: abs,
      ...(caseId ? { caseId } : {}),
    });
    return {
      text: nextHint(`shrk packs test ${packPath} --cases`),
      data: report,
    };
  },
};
