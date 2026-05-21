/**
 * Read-only MCP tool: get_file_advice.
 *
 * For a given file path, returns the rules, path conventions, boundary
 * rules, and knowledge entries that apply to it. The agent equivalent
 * of `shrk why <file>` — same engine (`buildWhyReport`), shaped for
 * MCP consumption.
 *
 * Why this exists alongside `inspect_workspace` and the various
 * `list_*` tools: agents tend to over-explore when given browsable
 * catalogs. Asking "give me everything for this file" in one call
 * keeps the prompt window tight and the answer focused — the agent
 * doesn't have to discover which rule matches the file's path glob,
 * which boundary rule constrains its imports, or which knowledge
 * entry is the right one to read first.
 *
 * Use after a `shrk diff-check` flags a violation, or before editing
 * an unfamiliar file. Read-only.
 */

import { buildWhyReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getFileAdviceTool: IToolDefinition = {
  name: 'get_file_advice',
  description:
    'For a given file path, return the rules, path conventions, boundary rules, and knowledge entries that apply to it. Single-call replacement for browsing the registry to figure out what constrains one file. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        description:
          'Path to the file (absolute, or relative to the project root). The file does not need to exist — path-string matching still works.',
      },
      limit: {
        type: 'number',
        description: 'Cap rules and knowledge entries returned (default 10).',
      },
    },
  },
  async handler(input, ctx) {
    const file = typeof input.file === 'string' ? input.file : '';
    if (!file) {
      return {
        text: 'Error: `file` argument is required.',
        data: { error: 'missing-argument', argument: 'file' },
      };
    }
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 10;
    const report = buildWhyReport({
      inspection: ctx.inspection,
      projectRoot: ctx.cwd,
      target: file,
      limit,
    });
    const summary = buildSummary(report);
    return {
      text: summary,
      data: report,
    };
  },
};

function buildSummary(report: ReturnType<typeof buildWhyReport>): string {
  const lines: string[] = [];
  lines.push(`File: ${report.target.relativePath} (${report.target.kind})`);
  if (report.inferredPackage) lines.push(`Package: ${report.inferredPackage}`);
  if (report.inferredLayer) lines.push(`Layer: ${report.inferredLayer}`);
  const counts = {
    rules: report.rules.length,
    boundaries: report.boundaries.length,
    paths: report.pathConventions.length,
    knowledge: report.knowledge.length,
  };
  lines.push(
    `Matches: ${counts.rules} rule${counts.rules === 1 ? '' : 's'}, ` +
      `${counts.boundaries} boundary rule${counts.boundaries === 1 ? '' : 's'}, ` +
      `${counts.paths} path convention${counts.paths === 1 ? '' : 's'}, ` +
      `${counts.knowledge} knowledge entr${counts.knowledge === 1 ? 'y' : 'ies'}.`,
  );
  if (
    counts.rules === 0 &&
    counts.boundaries === 0 &&
    counts.paths === 0 &&
    counts.knowledge === 0
  ) {
    lines.push(
      'No registry entries matched. The file may be outside the conventions, or the workspace may not have rules / paths defined yet.',
    );
  } else {
    lines.push('See `data` for the full per-category list.');
  }
  return lines.join('\n');
}
