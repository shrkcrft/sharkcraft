import {
  boundaryForbiddenMatch,
  boundaryIntendedEmptyLine,
  boundaryPatternOverlaps,
  boundaryRuleFailsOnEmpty,
  boundaryRuleSeverity,
} from '@shrkcrft/boundaries';
import {
  collectKindRejections,
  ContributionKind,
  contributionFileLabel,
  formatEntryRejection,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Round 12 (R12-5.5): the rule as written PLUS its effective semantics — the
 * fields `shrk boundaries explain --json` prints, from the same authorities.
 * It used to return the raw rule, so the consumer's shape (no severity, no
 * forbiddenMatch) read like an entrypoint-only fence of unknown severity.
 * Output-only: the input schema is unchanged.
 */
export const getBoundaryRuleTool: IToolDefinition = {
  name: 'get_boundary_rule',
  description:
    'Get one boundary rule by id with full details, plus its effective semantics: severity (unset = error), forbiddenMatch (package = each bare pattern also covers its subpaths | exact = entrypoint only), failOnEmpty, the patterns that can never change its verdict (redundantForbidden, shadowedAllowed), and its expectEmpty markers (expectEmptyUnits + one "expectEmpty marker: <list> <unit> — <reason>" DECLARATION line each in expectEmptyMarkers — never a state: whether a marked unit is intended-empty or went live is what check_boundaries settles; the pattern lists stay plain strings).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const rule = ctx.inspection.boundaryRegistry.get(id);
    if (!rule) {
      // A rule its loader REJECTED is not "not found": it was declared and
      // refused, so the answer carries every reason — THE rejection channel,
      // as `shrk boundaries list` names it (round 12 review, R12-X5).
      const rejected = (await collectKindRejections(ctx.inspection, [ContributionKind.Boundary])).filter(
        (r) => r.entryId === id,
      );
      if (rejected.length > 0) {
        const where = rejected.map((r) => `${contributionFileLabel(ctx.inspection.projectRoot, r.file)}: ${formatEntryRejection(r)}`);
        return {
          isError: true,
          text: `Boundary rule "${id}" was declared but REJECTED by its loader — it is not enforced. ${where.join('; ')}`,
          error: {
            code: 'rejected',
            message: `boundary rule "${id}" failed validation — NOT evaluated`,
            details: {
              rejections: rejected.map((r) => ({
                file: contributionFileLabel(ctx.inspection.projectRoot, r.file),
                index: r.index,
                exportName: r.exportName ?? null,
                reasons: r.reasons,
                packageName: r.packageName ?? null,
              })),
            },
          },
        };
      }
      return { isError: true, text: `No boundary rule with id "${id}".` };
    }
    const overlaps = boundaryPatternOverlaps(rule);
    return {
      data: {
        ...rule,
        severity: boundaryRuleSeverity(rule),
        forbiddenMatch: boundaryForbiddenMatch(rule),
        failOnEmpty: boundaryRuleFailsOnEmpty(rule),
        redundantForbidden: overlaps.redundantForbidden.map((o) => ({ pattern: o.pattern, coveredBy: o.by })),
        shadowedAllowed: overlaps.shadowedAllowed.map((o) => ({ pattern: o.pattern, shadowedBy: o.by })),
        // Round 13: the rule's expectEmpty markers — the lists above stay plain
        // strings (the wire shape is unchanged); each marker is one ledger row
        // and one 'intended empty: …' line, as `shrk boundaries explain` prints.
        expectEmptyUnits: rule.expectEmptyUnits ?? [],
        // A DECLARATION, never a state: whether the unit is intended-empty or
        // went live is a run-time fact only `check_boundaries` settles (round
        // 13 review — this line said "intended empty" over a marker that went live).
        expectEmptyMarkers: (rule.expectEmptyUnits ?? []).map(
          (m) => `expectEmpty marker: ${boundaryIntendedEmptyLine(m)} (state: see check_boundaries)`,
        ),
        source: ctx.inspection.boundarySources.get(id) ?? null,
      },
    };
  },
};
