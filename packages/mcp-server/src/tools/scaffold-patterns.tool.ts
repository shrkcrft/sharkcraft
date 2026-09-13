import { settleVerdict } from '@shrkcrft/core';
import {
  assetDoctorProposedExit,
  buildScaffoldPatternDoctorReport,
  contributionFileLabel,
  loadScaffoldPatternsFromInspection,
  settledUnitStates,
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
    'Validate every scaffold pattern (templates exist, strategies recognized, confidence valid) and count the files each matchPaths glob matches — `coverage` / `deadUnits` name every glob or pattern matching nothing; a glob marked { pattern, expectEmpty: true } is intended-empty (`accepted`) until a file matches it (went-live, `units.wentLive`). Carries the patterns the loader REFUSED (`rejected`, each an error) and the settled `verdict` / `exitCode` / `accepted` — the same report and exit `shrk scaffolds doctor` settles (without its flags). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    // THE scaffold-pattern doctor `shrk scaffolds doctor` reads (round 13): it
    // used to drop loader-refused patterns and return no verdict.
    const report = await buildScaffoldPatternDoctorReport(ctx.inspection);
    const units = report.measured.liveness.flatMap((s) => s.units);
    const settled = settleVerdict(
      assetDoctorProposedExit(
        { errors: report.errors, warnings: report.warnings, units },
        { strict: false, failOnDeadUnits: false },
      ),
      report.coverage,
    );
    return {
      data: {
        patterns: report.patterns.length,
        errors: report.errors,
        warnings: report.warnings,
        dead: report.measured.deadUnits.length,
        issues: report.issues,
        rejected: report.rejected.map((r) => ({ ...r, file: contributionFileLabel(ctx.inspection.projectRoot, r.file) })),
        loadWarnings: report.loadWarnings,
        patternCoverage: report.patternCoverage,
        coverage: report.coverage,
        deadUnits: report.measured.deadUnits,
        units: settledUnitStates(report.measured.liveness),
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
        accepted: settled.accepted,
        nextCommand: 'shrk scaffolds doctor',
      },
    };
  },
};
