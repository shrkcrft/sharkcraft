import { ProjectShape } from '@shrkcrft/workspace';

/**
 * Default `surface.hidden[]` seeding by project shape.
 *
 * Conservative cut: each list is small and explicitly justified. The
 * shape detector seeds these only when the user runs `shrk init
 * --write` (preview-first). Existing repos are not touched.
 *
 * Rationale:
 *   - `single-app` repos don't need monorepo-only commands by
 *     default. They stay callable; just hidden from --help.
 *   - `library` repos hide app/runtime-only commands.
 *   - `monorepo` and `app-with-libs` keep the full default surface.
 */
export const SHAPE_HIDDEN_DEFAULTS: Readonly<Record<ProjectShape, readonly string[]>> = Object.freeze({
  [ProjectShape.SingleApp]: Object.freeze([
    'bundle',
    'bundle apply-assist',
    'bundle create',
    'bundle diff',
    'bundle list',
    'bundle plan',
    'bundle replay',
    'bundle show',
    'bundle validate',
    'reposet',
    'pack',
    'packs new',
    'packs sign',
    'packs verify',
    'packs release-check',
    'packs compat',
  ]),
  [ProjectShape.Library]: Object.freeze([
    'dev',
    'dev start',
    'dev status',
    'dev report',
  ]),
  [ProjectShape.AppWithLibs]: Object.freeze([]),
  [ProjectShape.Monorepo]: Object.freeze([]),
  [ProjectShape.Unknown]: Object.freeze([]),
});

export function defaultHiddenForShape(shape: ProjectShape): readonly string[] {
  return SHAPE_HIDDEN_DEFAULTS[shape] ?? [];
}

export function renderShapeLine(detection: {
  shape: ProjectShape;
  evidence: readonly string[];
}): string {
  const ev = detection.evidence.length > 0 ? ` (${detection.evidence[0]})` : '';
  return `Project shape: ${detection.shape}${ev}`;
}
