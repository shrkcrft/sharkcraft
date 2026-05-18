/**
 * Merge preview for the adoption patch. Read-only. Produces text/markdown/html/
 * json renderings showing exactly what the user would need to merge manually.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AdoptionCategory,
  type IAdoptionItem,
  type IAdoptionPlan,
} from './onboarding-adoption.ts';
import {
  computeAdoptionFreshness,
  readAdoptionState,
  type IAdoptionState,
  type IComputeFreshnessResult,
} from './adoption-state.ts';
import {
  previewThreeWayBatch,
  ThreeWayVerdict,
  type IThreeWayPreviewBatchResult,
} from './adoption-three-way.ts';

export type AdoptionMergePreviewFormat = 'text' | 'markdown' | 'html' | 'json';

export interface IAdoptionMergePreview {
  schema: 'sharkcraft.adoption-merge-preview/v1';
  projectRoot: string;
  state: IAdoptionState | null;
  freshness: IComputeFreshnessResult;
  threeWay: IThreeWayPreviewBatchResult;
  safeAppend: readonly IAdoptionItem[];
  manualReview: readonly IAdoptionItem[];
  lowConfidence: readonly IAdoptionItem[];
  alreadyCovered: readonly IAdoptionItem[];
  conflicts: readonly IAdoptionItem[];
  recommendedCommands: readonly string[];
}

export interface IBuildMergePreviewInput {
  projectRoot: string;
  plan: IAdoptionPlan;
}

export function buildAdoptionMergePreview(
  input: IBuildMergePreviewInput,
): IAdoptionMergePreview {
  const state = readAdoptionState(input.projectRoot);
  const freshness = computeAdoptionFreshness(input.projectRoot, state);
  const threeWay = state
    ? previewThreeWayBatch(input.projectRoot, state.targetFiles, {
        draftsChanged: freshness.changedDrafts.length > 0,
      })
    : { perTarget: [], summary: emptySummary() };

  const recommended = recommendCommands(freshness, threeWay, state);

  return {
    schema: 'sharkcraft.adoption-merge-preview/v1',
    projectRoot: input.projectRoot,
    state,
    freshness,
    threeWay,
    safeAppend: input.plan.byCategory[AdoptionCategory.SafeToAdopt],
    manualReview: input.plan.byCategory[AdoptionCategory.ManualReview],
    lowConfidence: input.plan.byCategory[AdoptionCategory.LowConfidence],
    alreadyCovered: input.plan.byCategory[AdoptionCategory.AlreadyCovered],
    conflicts: input.plan.byCategory[AdoptionCategory.Conflict],
    recommendedCommands: recommended,
  };
}

function emptySummary(): Record<ThreeWayVerdict, number> {
  return {
    [ThreeWayVerdict.Safe]: 0,
    [ThreeWayVerdict.ProbablySafe]: 0,
    [ThreeWayVerdict.StaleTarget]: 0,
    [ThreeWayVerdict.StaleDraft]: 0,
    [ThreeWayVerdict.ManualReview]: 0,
    [ThreeWayVerdict.CreateFileSafe]: 0,
    [ThreeWayVerdict.Conflict]: 0,
  };
}

function recommendCommands(
  freshness: IComputeFreshnessResult,
  threeWay: IThreeWayPreviewBatchResult,
  state: IAdoptionState | null,
): string[] {
  if (!state) {
    return [
      'shrk onboard --write-drafts',
      'shrk onboard adopt --write-patch --diff-format unified',
    ];
  }
  if (
    freshness.status !== 'fresh' ||
    threeWay.summary[ThreeWayVerdict.StaleTarget] > 0 ||
    threeWay.summary[ThreeWayVerdict.StaleDraft] > 0
  ) {
    return [
      'shrk onboard adopt regenerate',
      'shrk onboard adopt status',
    ];
  }
  return [
    'shrk onboard adopt review',
    'shrk onboard adopt check',
    `git apply ${nodePath.posix.join('sharkcraft', 'onboarding', 'adoption', 'adopt.patch')}`,
  ];
}

// ─── Renderers ────────────────────────────────────────────────────────────────

export function renderAdoptionMergePreviewText(p: IAdoptionMergePreview): string {
  const out: string[] = [];
  out.push('=== Onboarding adoption — merge preview ===');
  if (!p.state) {
    out.push('No adoption-state.json on disk.');
    out.push('Run: shrk onboard adopt --write-patch');
    return out.join('\n') + '\n';
  }
  out.push(`  patch         ${p.state.patchPath}`);
  out.push(`  format        ${p.state.diffFormat}`);
  out.push(`  freshness     ${p.freshness.status}`);
  if (p.freshness.staleReasons.length > 0) {
    out.push('  stale reasons:');
    for (const r of p.freshness.staleReasons) out.push(`    - ${r}`);
  }
  out.push('');
  out.push('Three-way verdicts:');
  for (const tw of p.threeWay.perTarget) {
    out.push(`  ${tw.verdict.padEnd(18)} ${tw.relativePath}`);
    for (const r of tw.reasons) out.push(`      ${r}`);
  }
  out.push('');
  out.push(`Safe append blocks    ${p.safeAppend.length}`);
  out.push(`Manual review items   ${p.manualReview.length}`);
  out.push(`Low-confidence items  ${p.lowConfidence.length}`);
  out.push(`Already covered       ${p.alreadyCovered.length}`);
  out.push(`Conflicts             ${p.conflicts.length}`);
  out.push('');
  out.push('Recommended commands:');
  for (const c of p.recommendedCommands) out.push(`  $ ${c}`);
  return out.join('\n') + '\n';
}

export function renderAdoptionMergePreviewMarkdown(p: IAdoptionMergePreview): string {
  const out: string[] = [];
  out.push('# SharkCraft onboarding — merge preview');
  out.push('');
  if (!p.state) {
    out.push('_No adoption state on disk._');
    out.push('');
    out.push('```');
    out.push('shrk onboard --write-drafts');
    out.push('shrk onboard adopt --write-patch');
    out.push('```');
    return out.join('\n') + '\n';
  }
  out.push(`- **Patch**: \`${p.state.patchPath}\``);
  out.push(`- **Format**: \`${p.state.diffFormat}\``);
  out.push(`- **Freshness**: \`${p.freshness.status}\``);
  if (p.freshness.staleReasons.length > 0) {
    out.push('  - Stale reasons:');
    for (const r of p.freshness.staleReasons) out.push(`    - ${r}`);
  }
  out.push('');
  out.push('## Three-way verdicts per target');
  out.push('');
  out.push('| Target | Verdict | Notes |');
  out.push('|---|---|---|');
  for (const tw of p.threeWay.perTarget) {
    const notes = tw.reasons.join('; ').replace(/\|/g, '\\|');
    out.push(`| \`${tw.relativePath}\` | \`${tw.verdict}\` | ${notes} |`);
  }
  out.push('');
  out.push('## Items by category');
  out.push('');
  renderCategoryMd(out, 'Safe to append', p.safeAppend);
  renderCategoryMd(out, 'Manual review', p.manualReview);
  renderCategoryMd(out, 'Low-confidence', p.lowConfidence);
  renderCategoryMd(out, 'Already covered', p.alreadyCovered);
  renderCategoryMd(out, 'Conflicts', p.conflicts);
  out.push('');
  out.push('## Recommended commands');
  out.push('');
  out.push('```');
  for (const c of p.recommendedCommands) out.push(c);
  out.push('```');
  return out.join('\n') + '\n';
}

function renderCategoryMd(out: string[], title: string, items: readonly IAdoptionItem[]): void {
  if (items.length === 0) return;
  out.push(`### ${title} (${items.length})`);
  for (const it of items) {
    out.push(`- **${it.kind}** \`${it.id}\` — ${it.title}`);
    out.push(`  - reason: ${it.reason}`);
  }
  out.push('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HTML_BASE_CSS = `
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}
h1,h2,h3{margin-top:1.4rem;color:#bae67e}
table{border-collapse:collapse;width:100%;margin:.8rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #2a3138}
th{background:#1c2329;color:#9aa5b0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:600;text-transform:uppercase}
.b-safe{background:#28432e;color:#bae67e}.b-probably{background:#3a3a2e;color:#ffd580}.b-stale{background:#4a2e2e;color:#ff7f7f}
.b-manual{background:#2e3a4a;color:#7fd0ff}.b-create{background:#28433f;color:#7fe6cf}.b-conflict{background:#5a1f1f;color:#ff9f9f}
pre{background:#1c2329;padding:.8rem;border-radius:.4rem;overflow-x:auto}
code{background:#1c2329;padding:.05rem .3rem;border-radius:.2rem}
.note{padding:.6rem .8rem;background:#1c2329;border-left:3px solid #bae67e;border-radius:.2rem;margin:.6rem 0}
@media (prefers-color-scheme: light){body{background:#fafaf7;color:#1f2329}h1,h2,h3{color:#266a2e}th{background:#eee;color:#222}pre,code{background:#eee}.note{background:#eee;border-left-color:#266a2e}}
`;

const VERDICT_CSS: Record<ThreeWayVerdict, string> = {
  [ThreeWayVerdict.Safe]: 'b-safe',
  [ThreeWayVerdict.ProbablySafe]: 'b-probably',
  [ThreeWayVerdict.StaleTarget]: 'b-stale',
  [ThreeWayVerdict.StaleDraft]: 'b-stale',
  [ThreeWayVerdict.ManualReview]: 'b-manual',
  [ThreeWayVerdict.CreateFileSafe]: 'b-create',
  [ThreeWayVerdict.Conflict]: 'b-conflict',
};

export function renderAdoptionMergePreviewHtml(p: IAdoptionMergePreview): string {
  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8"><title>SharkCraft adoption — merge preview</title>');
  out.push(`<style>${HTML_BASE_CSS}</style></head><body>`);
  out.push('<h1>SharkCraft onboarding — merge preview</h1>');
  if (!p.state) {
    out.push('<p class="note">No adoption state on disk.</p>');
    out.push('<pre><code>shrk onboard --write-drafts\nshrk onboard adopt --write-patch</code></pre>');
    out.push('</body></html>');
    return out.join('\n') + '\n';
  }
  out.push('<h2>Patch metadata</h2>');
  out.push('<table>');
  out.push(`<tr><th>Patch</th><td><code>${escapeHtml(p.state.patchPath)}</code></td></tr>`);
  out.push(`<tr><th>Format</th><td><code>${escapeHtml(p.state.diffFormat)}</code></td></tr>`);
  out.push(`<tr><th>Freshness</th><td><span class="badge ${p.freshness.status === 'fresh' ? 'b-safe' : 'b-stale'}">${escapeHtml(p.freshness.status)}</span></td></tr>`);
  out.push('</table>');
  if (p.freshness.staleReasons.length > 0) {
    out.push('<p class="note"><strong>Stale reasons:</strong></p><ul>');
    for (const r of p.freshness.staleReasons) out.push(`<li>${escapeHtml(r)}</li>`);
    out.push('</ul>');
  }
  out.push('<h2>Three-way verdicts per target</h2>');
  out.push('<table><thead><tr><th>Target</th><th>Verdict</th><th>Notes</th></tr></thead><tbody>');
  for (const tw of p.threeWay.perTarget) {
    const cls = VERDICT_CSS[tw.verdict];
    out.push(
      `<tr><td><code>${escapeHtml(tw.relativePath)}</code></td>` +
        `<td><span class="badge ${cls}">${escapeHtml(tw.verdict)}</span></td>` +
        `<td>${tw.reasons.map(escapeHtml).join('<br>')}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
  renderCategoryHtml(out, 'Safe to append', p.safeAppend);
  renderCategoryHtml(out, 'Manual review', p.manualReview);
  renderCategoryHtml(out, 'Low-confidence', p.lowConfidence);
  renderCategoryHtml(out, 'Already covered', p.alreadyCovered);
  renderCategoryHtml(out, 'Conflicts', p.conflicts);
  out.push('<h2>Recommended commands</h2>');
  out.push('<pre>');
  for (const c of p.recommendedCommands) out.push(escapeHtml(c));
  out.push('</pre>');
  out.push('</body></html>');
  return out.join('\n') + '\n';
}

function renderCategoryHtml(out: string[], title: string, items: readonly IAdoptionItem[]): void {
  if (items.length === 0) return;
  out.push(`<h2>${escapeHtml(title)} (${items.length})</h2>`);
  out.push('<table><thead><tr><th>Kind</th><th>Id</th><th>Title</th><th>Reason</th></tr></thead><tbody>');
  for (const it of items) {
    out.push(
      `<tr><td><code>${escapeHtml(it.kind)}</code></td>` +
        `<td><code>${escapeHtml(it.id)}</code></td>` +
        `<td>${escapeHtml(it.title)}</td>` +
        `<td>${escapeHtml(it.reason)}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
}

/** Reusable: read the unified patch body if it exists. */
export function loadAdoptPatchBody(projectRoot: string): string | null {
  const p = nodePath.join(projectRoot, 'sharkcraft', 'onboarding', 'adoption', 'adopt.patch');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}
