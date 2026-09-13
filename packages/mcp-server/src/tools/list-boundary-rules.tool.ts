import { boundaryForbiddenMatch, boundaryRuleSeverity } from '@shrkcrft/boundaries';
import {
  collectKindRejections,
  ContributionKind,
  contributionFileLabel,
  formatEntryRejection,
  type IContributionEntryRejection,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

/**
 * THE rejection channel's note for boundary rules (round 12 review, R12-X5),
 * worded as `shrk boundaries list` words it: one `⚠ N entr(y|ies) rejected
 * from <file>: '<id>' (default[i]) — <reasons>` line per file. `undefined`
 * when nothing was rejected.
 */
function boundaryRejectionNote(
  rejections: readonly IContributionEntryRejection[],
  projectRoot: string,
): string | undefined {
  if (rejections.length === 0) return undefined;
  const byFile = new Map<string, IContributionEntryRejection[]>();
  for (const r of rejections) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  return [...byFile]
    .map(
      ([file, list]) =>
        `⚠ ${list.length} ${list.length === 1 ? 'entry' : 'entries'} rejected from ${contributionFileLabel(projectRoot, file)}: ${list
          .map((r) => formatEntryRejection(r))
          .join('; ')} — not listed (see \`shrk boundaries list\`)`,
    )
    .join('\n');
}

/**
 * Round 12 (R12-5.5): every row carries the EFFECTIVE semantics, from the one
 * authority the evaluator and `boundaries explain` read — `severity` through
 * `boundaryRuleSeverity` (this tool used to re-implement the unset default
 * inline) and `forbiddenMatch` through `boundaryForbiddenMatch`, so an agent can
 * tell that a bare `@scope/pkg` also forbids `@scope/pkg/sub`. Output-only: the
 * input schema is unchanged.
 */
export const listBoundaryRulesTool: IToolDefinition = {
  name: 'list_boundary_rules',
  description:
    'List every configured boundary rule (local + pack-contributed). Returns id, title, the effective severity (unset = error) and forbiddenMatch (package = each bare pattern also covers its subpaths | exact = entrypoint only), from/forbidden/allowed patterns, source. A rule its loader REJECTED is not a row: it is named, with every reason, in the text note (`⚠ N entries rejected from <file>: …`) — the rows array stays parseable, as `shrk boundaries list --json` keeps its stdout. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const rows = ctx.inspection.boundaryRegistry.list().map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      severity: boundaryRuleSeverity(r),
      forbiddenMatch: boundaryForbiddenMatch(r),
      from: r.from,
      forbiddenImports: r.forbiddenImports ?? [],
      allowedImports: r.allowedImports ?? [],
      // Round 13: the pattern lists keep their string[] wire shape; the
      // expectEmpty markers ride beside them (additive).
      expectEmptyUnits: r.expectEmptyUnits ?? [],
      tags: r.tags ?? [],
      source: ctx.inspection.boundarySources.get(r.id) ?? null,
    }));
    // A rejected rule is not in the registry, so it would vanish from the
    // agent's view while the CLI prints its ⚠ note — the same channel here.
    const note = boundaryRejectionNote(
      await collectKindRejections(ctx.inspection, [ContributionKind.Boundary]),
      ctx.inspection.projectRoot,
    );
    return { data: formatRows(rows, input), ...(note !== undefined ? { text: note } : {}) };
  },
};
