import { SHARKCRAFT_VERSION } from '@shrkcrft/shared';
import { loadSurfaceContext } from './load-surface-context.ts';
import { buildSurfaceSummary } from './surface-summary.ts';

/**
 * The curated landing rendered when a user runs bare `shrk`
 * (no args). Falls back to four hardcoded suggestions when the
 * inspector / recommender fails (fresh repo without a config).
 */
export async function renderNoArgsLanding(cwd: string): Promise<string> {
  const lines: string[] = [];
  lines.push(`shrk v${SHARKCRAFT_VERSION} — deterministic context for AI coding agents.`);
  lines.push('');

  let totals = '';
  try {
    const { context } = await loadSurfaceContext({ cwd });
    const summary = buildSurfaceSummary(context);
    totals = `Surface: ${summary.totals.core} core + ${summary.totals.extended} extended (${summary.tiers.extended.filter((c) => c.hidden).length} hidden, ${summary.tiers.experimental.filter((c) => c.enabled).length} experimental enabled).`;
  } catch {
    totals = 'Surface: (run `shrk doctor` to load the workspace).';
  }
  lines.push(totals);
  lines.push('');

  lines.push('Most useful next:');
  lines.push('  shrk doctor                 health check');
  lines.push('  shrk task "<what>"          full packet for a task');
  lines.push('  shrk recommend "<what>"     what should I do?');
  lines.push('  shrk surface list           what is available in this repo');
  lines.push('');
  lines.push('See:');
  lines.push('  shrk --help                 every visible command');
  lines.push('  shrk surface explain <cmd>  why a command is/is not visible');
  lines.push('  shrk --about                what shrk is and is not');
  lines.push('');

  return lines.join('\n');
}
