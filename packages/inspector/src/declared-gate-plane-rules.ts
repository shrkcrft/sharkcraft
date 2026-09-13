import { GATE_PLANE_CONFIG_KEY, GATE_PLANE_ORDER } from '@shrkcrft/config';
import { isProjectConfigAbsent, resolveProjectConfig } from './resolve-project-config.ts';

/**
 * How many data-defined gate-plane rules the project declares, per plane —
 * read through `resolveProjectConfig` (THE config reader that sees
 * pack-contributed planes) under THE plane → config-key list beside the config
 * schema (`GATE_PLANE_CONFIG_KEY`), the one the CLI's `collectGateRules` reads.
 *
 * Two "no config was read" answers, kept apart (round 11 review R12-REG-2):
 *   - NO config — the loader found no `sharkcraft/` folder
 *     (`isProjectConfigAbsent`, the answer `finish` reads as "gate not
 *     applicable"): zero rules and no `loadError`; there are no planes to run;
 *   - a config that EXISTS but failed to load: `loadError` is set, since
 *     nothing can be said about what it declares.
 *
 * `buildQualityReport` consumers other than `shrk quality` (MCP, the
 * dashboard, the report site) do not run the planes — some spawn shells — so
 * they report a not-run `gate-planes` row from this count; `shrk quality`
 * runs them.
 */
export async function declaredGatePlaneRules(
  projectRoot: string,
): Promise<{ readonly total: number; readonly byPlane: Readonly<Record<string, number>>; readonly loadError?: string }> {
  const resolved = await resolveProjectConfig(projectRoot);
  if (!resolved.ok) {
    return isProjectConfigAbsent(resolved.error)
      ? { total: 0, byPlane: {} }
      : { total: 0, byPlane: {}, loadError: resolved.error.message };
  }
  const config = resolved.value.config as unknown as Readonly<Record<string, unknown>>;
  const byPlane: Record<string, number> = {};
  let total = 0;
  for (const plane of GATE_PLANE_ORDER) {
    const list = config[GATE_PLANE_CONFIG_KEY[plane]];
    const n = Array.isArray(list) ? list.length : 0;
    if (n > 0) byPlane[plane] = n;
    total += n;
  }
  return { total, byPlane };
}
