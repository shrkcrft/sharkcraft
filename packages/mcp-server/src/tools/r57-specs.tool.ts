/**
 * Read-only MCP tools for spec discovery.
 *
 * NONE of these tools write. Spec mutation (create / implement / verify)
 * is CLI-only by design (the safety contract: MCP is read-only).
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  buildSpecList,
  buildSpecReview,
  type ISpecListReport,
  type ISpecReviewReport,
} from '@shrkcrft/inspector';
import {
  loadSpec,
  specMdPath,
  specVerificationPath,
} from '@shrkcrft/generator';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listSpecsTool: IToolDefinition = {
  name: 'list_specs',
  description:
    'List every spec under .sharkcraft/specs/. Returns id, slug, title, status, timestamps, hasPlan, hasVerification.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
    },
    additionalProperties: false,
  },
  cliCommand: 'spec list',
  handler(input, ctx) {
    const report: ISpecListReport = buildSpecList(ctx.cwd);
    const status = typeof input.status === 'string' ? input.status : undefined;
    const entries = status ? report.entries.filter((e) => e.status === status) : report.entries;
    return { data: { ...report, entries } };
  },
};

export const getSpecTool: IToolDefinition = {
  name: 'get_spec',
  description:
    'Return a spec\'s canonical view (spec.json) with optionally resolved registry pointers (rule titles / template names).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Spec id (directory name under .sharkcraft/specs/).' },
      includeBody: { type: 'boolean' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  cliCommand: 'spec show',
  handler(input, ctx) {
    const id = String(input.id);
    const loaded = loadSpec(ctx.cwd, id);
    if (!loaded.ok) {
      return {
        isError: true,
        error: { code: 'spec-not-found', message: `Spec not found: ${id}` },
      };
    }
    const includeBody = input.includeBody === true;
    return {
      data: includeBody
        ? { ...loaded.value.spec, body: loaded.value.body }
        : loaded.value.spec,
    };
  },
};

export const getSpecReviewTool: IToolDefinition = {
  name: 'get_spec_review',
  description:
    'Run a read-only spec review and return the sharkcraft.spec-review/v1 packet. Does NOT mutate spec.md.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  cliCommand: 'spec review',
  handler(input, ctx) {
    const id = String(input.id);
    const loaded = loadSpec(ctx.cwd, id);
    if (!loaded.ok) {
      return {
        isError: true,
        error: { code: 'spec-not-found', message: `Spec not found: ${id}` },
      };
    }
    const review: ISpecReviewReport = buildSpecReview({
      spec: loaded.value.spec,
      specPath: specMdPath(ctx.cwd, id),
      body: loaded.value.body,
      inspection: ctx.inspection,
    });
    return { data: review };
  },
};

export const getSpecVerificationTool: IToolDefinition = {
  name: 'get_spec_verification',
  description:
    'Return the most recent spec verification report (the cached verification.json) or null if `spec verify` has not yet run.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  cliCommand: 'spec verify',
  handler(input, ctx) {
    const id = String(input.id);
    const p = specVerificationPath(ctx.cwd, id);
    if (!existsSync(p)) return { data: null };
    try {
      return { data: JSON.parse(readFileSync(p, 'utf8')) };
    } catch (e) {
      return {
        isError: true,
        error: {
          code: 'invalid-verification-json',
          message: `Verification report at ${p} is not valid JSON`,
          details: { error: (e as Error).message },
        },
      };
    }
  },
};
