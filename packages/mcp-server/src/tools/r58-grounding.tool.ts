/**
 * Two read-only MCP tools for the additive grounding surface.
 *
 *   - `get_grounding(task)` — what shrk knows that's relevant to <task>.
 *   - `check_external_plan(path | content, extractorId?)` — validate an
 *     external plan file against the live workspace.
 *
 * Both are read-only. The CLI is the only write path (matching the
 * safety contract). No write tools for spec/plan mutation.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  getExtractorById,
  pickExtractor,
  type ExtractorFieldMap,
} from '@shrkcrft/generator';
import {
  buildGrounding,
  loadNxProjects,
  mapFilesToProjects,
  validateExtractedPlan,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getGroundingTool: IToolDefinition = {
  name: 'get_grounding',
  description:
    'Task-relevant rules / knowledge / paths / templates / trusted verification command IDs as JSON. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
      maxTokens: { type: 'integer', minimum: 100 },
    },
    required: ['task'],
    additionalProperties: false,
  },
  cliCommand: 'grounding',
  handler(input, ctx) {
    const task = String(input.task);
    const limit = typeof input.limit === 'number' ? input.limit : 5;
    const maxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : 2500;
    const report = buildGrounding(task, ctx.inspection, { limit, maxTokens });
    return { data: report };
  },
};

export const checkExternalPlanTool: IToolDefinition = {
  name: 'check_external_plan',
  description:
    'Validate an external plan/spec file against the live workspace. Supports an inline `content` string or a `path` (resolved relative to cwd). Read-only — the input file is never modified.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative or absolute path to the plan file.' },
      content: { type: 'string', description: 'Inline plan content; takes precedence over `path`.' },
      extractorId: {
        type: 'string',
        description: 'sharkcraft.spec/v1 | markdown-frontmatter-loose. If absent, auto-pick.',
      },
      fieldMap: {
        type: 'object',
        description: 'Optional external-key → canonical-key remapping for markdown-frontmatter-loose.',
        additionalProperties: { type: 'string' },
      },
    },
    additionalProperties: false,
  },
  cliCommand: 'plan check',
  handler(input, ctx) {
    const inlineContent = typeof input.content === 'string' ? input.content : undefined;
    const inputPath = typeof input.path === 'string' ? input.path : undefined;
    if (inlineContent === undefined && inputPath === undefined) {
      return {
        isError: true,
        error: { code: 'missing-input', message: 'Provide either `path` or `content`.' },
      };
    }
    let raw: string;
    let sourceLabel: string;
    if (inlineContent !== undefined) {
      raw = inlineContent;
      sourceLabel = '<inline>';
    } else {
      const abs = nodePath.isAbsolute(inputPath!) ? inputPath! : nodePath.resolve(ctx.cwd, inputPath!);
      if (!existsSync(abs)) {
        return {
          isError: true,
          error: { code: 'not-found', message: `Plan file not found: ${inputPath}` },
        };
      }
      raw = readFileSync(abs, 'utf8');
      sourceLabel = nodePath.relative(ctx.cwd, abs) || abs;
    }

    const extractorId = typeof input.extractorId === 'string' ? input.extractorId : undefined;
    const extractor = extractorId ? getExtractorById(extractorId) : pickExtractor(sourceLabel);
    if (!extractor) {
      return {
        isError: true,
        error: {
          code: 'no-extractor',
          message: `No extractor for "${sourceLabel}". Pass extractorId: sharkcraft.spec/v1 | markdown-frontmatter-loose.`,
        },
      };
    }

    const fieldMap = (input.fieldMap as ExtractorFieldMap | undefined) ?? undefined;
    const extracted = extractor.extract(raw, {
      source: sourceLabel,
      ...(fieldMap ? { fieldMap } : {}),
    });
    if (!extracted.ok) {
      return {
        isError: true,
        error: {
          code: 'extractor-refused',
          message: extracted.error.message,
          details: { extractorId: extractor.id },
        },
      };
    }

    const validation = validateExtractedPlan(extracted.value, ctx.inspection);
    const verdict: 'pass' | 'warn' | 'fail' = validation.errors.length > 0
      ? 'fail'
      : validation.warnings.length > 0
        ? 'warn'
        : 'pass';

    const graph = loadNxProjects(ctx.cwd);
    const affectedFiles = extracted.value.affectedFiles ?? [];
    const nxBlock = graph
      ? affectedFiles.length === 0
        ? { enabled: true, note: 'no affectedFiles declared — skipping project mapping' }
        : { enabled: true, affectedProjects: mapFilesToProjects(affectedFiles, graph) }
      : undefined;

    return {
      data: {
        schema: 'sharkcraft.plan-check/v1',
        source: sourceLabel,
        extractorId: extractor.id,
        verdict,
        errors: validation.errors,
        warnings: validation.warnings,
        ...(nxBlock ? { nx: nxBlock } : {}),
      },
    };
  },
};
