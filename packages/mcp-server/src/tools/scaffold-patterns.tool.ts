import {
  loadScaffoldPatternsFromInspection,
  doctorScaffoldPatterns,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listScaffoldPatternsTool: IToolDefinition = {
  name: 'list_scaffold_patterns',
  description:
    'List every scaffold pattern contributed by an installed pack. Read-only. Inputs: none.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const r = await loadScaffoldPatternsFromInspection(ctx.inspection);
    return {
      data: {
        patterns: r.patterns.map((p) => ({
          id: p.pattern.id,
          title: p.pattern.title,
          templateId: p.pattern.templateId,
          matchPaths: p.pattern.matchPaths,
          appliesWhen: p.pattern.appliesWhen,
          confidence: p.pattern.confidence,
          source: p.source,
        })),
        warnings: r.warnings,
      },
    };
  },
};

export const getScaffoldPatternTool: IToolDefinition = {
  name: 'get_scaffold_pattern',
  description: 'Get one scaffold pattern by id (full content). Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const r = await loadScaffoldPatternsFromInspection(ctx.inspection);
    const match = r.patterns.find((p) => p.pattern.id === id);
    if (!match) return { isError: true, data: { error: `unknown scaffold pattern: ${id}` } };
    return { data: match };
  },
};

export const getScaffoldPatternDoctorTool: IToolDefinition = {
  name: 'get_scaffold_pattern_doctor',
  description:
    'Validate every loaded scaffold pattern (templates exist, strategies recognized, confidence valid). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const r = await loadScaffoldPatternsFromInspection(ctx.inspection);
    const issues = doctorScaffoldPatterns(r.patterns, ctx.inspection);
    return {
      data: {
        patterns: r.patterns.length,
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
        issues,
        nextCommand: 'shrk scaffolds doctor',
      },
    };
  },
};
