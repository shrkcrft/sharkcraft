/**
 * Read-only registry lifecycle report.
 *
 * Carries the engine's verdict and coverage: a capped, over-budget or
 * zero-registration scan reads `not-verified` (never a clean report), and a
 * capped scan carries `nextOffset` — the `offset` input continues it.
 */
import { buildRegistryLifecycleReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const getRegistryLifecycleReportTool: IToolDefinition = {
  name: 'get_registry_lifecycle_report',
  description:
    'Scan the workspace for register*/remove* symmetry. Returns matched pairs, missing removers, ignored sites, the files/registrations coverage and a verdict (pass / fail / not-verified). A capped scan carries nextOffset: pass it as `offset` to continue. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
  },
  handler(input, ctx) {
    const limit = finiteNumber(input.limit);
    const rawOffset = finiteNumber(input.offset);
    const offset = rawOffset !== undefined && rawOffset >= 0 ? rawOffset : undefined;
    // The same skip-dir config the CLI verbs honour (skipDirsAdd extends,
    // skipDirs replaces) — one scope for one question.
    const cfg = ctx.inspection.config?.registryLifecycle;
    // An EXISTING config that failed to load leaves `config` null, so the scan
    // would silently fall back to the default skip set. The engine turns the
    // failure into a coverage shortfall: never a pass over the wrong scope.
    const loadError = ctx.inspection.configLoadError;
    const report = buildRegistryLifecycleReport({
      projectRoot: ctx.cwd,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(cfg?.skipDirs ? { skipDirs: cfg.skipDirs } : {}),
      ...(cfg?.skipDirsAdd ? { skipDirsAdd: cfg.skipDirsAdd } : {}),
      ...(loadError ? { configLoadError: { file: loadError.file, message: loadError.message } } : {}),
    });
    const verdict = `Verdict: ${report.verdict}${report.verdictReason ? ` — ${report.verdictReason}` : ''}.`;
    const next =
      report.nextOffset !== undefined
        ? nextHint(`shrk check registry-lifecycle --offset ${report.nextOffset}`)
        : nextHint('shrk check registry-lifecycle');
    return {
      text: `${verdict} ${next}`,
      data: report,
    };
  },
};
