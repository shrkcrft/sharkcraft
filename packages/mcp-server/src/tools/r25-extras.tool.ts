/**
 * Polyglot language MCP tools. All read-only.
 *
 * Adds: language profiles + commands + dependency graph + test impact +
 * language report, memory diff/drift, contract template list/get.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildLanguageCommandReport,
  computePolyglotTestImpact,
  detectLanguageProfiles,
  diffMemoryIndex,
  getContractTemplate,
  latestMemorySnapshot,
  listAllContractTemplates,
  loadMemorySnapshot,
  loadRepositoryMemory,
  scanPolyglotDependencies,
  type IRepositoryMemoryIndex,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function resolveAgainst(path: string, root: string): string {
  return nodePath.isAbsolute(path) ? path : nodePath.resolve(root, path);
}

export const getLanguageProfilesTool: IToolDefinition = {
  name: 'get_language_profiles',
  description:
    'Detect language profiles (TS/JS/Java/C#/Python/Go/Rust) and return source/test roots, build tools, and likely commands. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: detectLanguageProfiles(ctx.inspection.projectRoot) };
  },
};

export const getLanguageCommandsTool: IToolDefinition = {
  name: 'get_language_commands',
  description:
    'Return per-language install/test/typecheck/lint/build commands derived from the detected language profiles. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: buildLanguageCommandReport(ctx.inspection.projectRoot) };
  },
};

export const getPolyglotDependencyGraphTool: IToolDefinition = {
  name: 'get_polyglot_dependency_graph',
  description:
    'Scan Java / C# / Python / Go / Rust imports and return the polyglot dependency graph. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', description: 'all | java | csharp | python | go | rust' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const langRaw = typeof input['language'] === 'string' ? (input['language'] as string).toLowerCase() : 'all';
    const languages = langRaw === 'all'
      ? undefined
      : [langRaw as Parameters<typeof scanPolyglotDependencies>[1] extends { languages?: infer L } ? L extends readonly (infer X)[] ? X : never : never];
    return {
      data: scanPolyglotDependencies(
        ctx.inspection.projectRoot,
        languages ? ({ languages } as Parameters<typeof scanPolyglotDependencies>[1]) : {},
      ),
    };
  },
};

export const getPolyglotTestImpactTool: IToolDefinition = {
  name: 'get_polyglot_test_impact',
  description: 'Predict per-language test files impacted by a set of changed source files. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['files'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const files = Array.isArray(input['files'])
      ? (input['files'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (files.length === 0) {
      return { isError: true, error: { code: 'invalid-input', message: 'files[] is required.' } };
    }
    return { data: computePolyglotTestImpact(ctx.inspection.projectRoot, files) };
  },
};

export const getLanguageReportTool: IToolDefinition = {
  name: 'get_language_report',
  description:
    'One-shot polyglot summary: language profiles + commands + dependency graph + missing-tests hints. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const profiles = detectLanguageProfiles(ctx.inspection.projectRoot);
    return {
      data: {
        profiles,
        commands: buildLanguageCommandReport(ctx.inspection.projectRoot, profiles),
        dependencies: scanPolyglotDependencies(ctx.inspection.projectRoot),
      },
    };
  },
};

export const getMemoryDiffTool: IToolDefinition = {
  name: 'get_memory_diff',
  description: 'Compare two memory snapshots (or one snapshot + the current index). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      oldPath: { type: 'string' },
      newPath: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const root = ctx.inspection.projectRoot;
    const oldPath = typeof input['oldPath'] === 'string' ? (input['oldPath'] as string) : '';
    if (!oldPath) {
      return { isError: true, error: { code: 'invalid-input', message: 'oldPath is required.' } };
    }
    const absOld = resolveAgainst(oldPath, root);
    if (!existsSync(absOld)) {
      return { isError: true, error: { code: 'not-found', message: `Snapshot not found: ${absOld}` } };
    }
    let before: IRepositoryMemoryIndex;
    try {
      before = JSON.parse(readFileSync(absOld, 'utf8')) as IRepositoryMemoryIndex;
    } catch (e) {
      return { isError: true, error: { code: 'invalid-input', message: `Failed to parse snapshot: ${(e as Error).message}` } };
    }
    const newPath = typeof input['newPath'] === 'string' ? (input['newPath'] as string) : '';
    let after: IRepositoryMemoryIndex | null;
    if (newPath) {
      const absNew = resolveAgainst(newPath, root);
      if (!existsSync(absNew)) {
        return { isError: true, error: { code: 'not-found', message: `Snapshot not found: ${absNew}` } };
      }
      after = JSON.parse(readFileSync(absNew, 'utf8')) as IRepositoryMemoryIndex;
    } else {
      after = loadRepositoryMemory(root);
      if (!after) {
        return { isError: true, error: { code: 'not-found', message: 'No current memory index — run `shrk memory build` first.' } };
      }
    }
    return { data: diffMemoryIndex(before, after) };
  },
};

export const getMemoryDriftTool: IToolDefinition = {
  name: 'get_memory_drift',
  description:
    'Compare the current memory index against the latest snapshot under .sharkcraft/memory/history/. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      previousPath: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const root = ctx.inspection.projectRoot;
    const current = loadRepositoryMemory(root);
    if (!current) {
      return { isError: true, error: { code: 'not-found', message: 'No current memory index. Run `shrk memory build` first.' } };
    }
    let previous: IRepositoryMemoryIndex | null;
    const prevPath = typeof input['previousPath'] === 'string' ? (input['previousPath'] as string) : '';
    if (prevPath) {
      previous = loadMemorySnapshot(resolveAgainst(prevPath, root));
    } else {
      previous = latestMemorySnapshot(root);
    }
    return { data: diffMemoryIndex(previous, current) };
  },
};

export const listContractTemplatesTool: IToolDefinition = {
  name: 'list_contract_templates',
  description: 'List contract templates (built-ins + pack-contributed). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: await listAllContractTemplates(ctx.inspection) };
  },
};

export const getContractTemplateTool: IToolDefinition = {
  name: 'get_contract_template',
  description: 'Get a single contract template by id (built-in + pack-contributed). Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = typeof input['id'] === 'string' ? (input['id'] as string) : '';
    if (!id) {
      return { isError: true, error: { code: 'invalid-input', message: 'id is required.' } };
    }
    const tpl =
      getContractTemplate(id) ?? (await listAllContractTemplates(ctx.inspection)).find((t) => t.id === id) ?? null;
    if (!tpl) {
      return { isError: true, error: { code: 'not-found', message: `Unknown template id: ${id}` } };
    }
    return { data: tpl };
  },
};
