/**
 * Adoption report renderers — text / markdown / html / json.
 *
 * Built from the adoption plan + (optionally) adoption state. Self-contained
 * HTML output (no external assets, no JS, dark-mode aware). Never writes
 * outside the adoption directory.
 */
import {
  AdoptionCategory,
  type IAdoptionItem,
  type IAdoptionPlan,
} from './onboarding-adoption.ts';
import {
  computeAdoptionFreshness,
  type IAdoptionState,
  type IComputeFreshnessResult,
} from './adoption-state.ts';
import {
  previewThreeWayBatch,
  ThreeWayVerdict,
  type IThreeWayPreviewBatchResult,
} from './adoption-three-way.ts';

export type AdoptionReportFormat = 'text' | 'markdown' | 'html' | 'json';

export interface IAdoptionReport {
  schema: 'sharkcraft.adoption-report/v1';
  projectRoot: string;
  generatedAt: string;
  state: IAdoptionState | null;
  freshness: IComputeFreshnessResult;
  threeWay: IThreeWayPreviewBatchResult;
  plan: IAdoptionPlan;
  recommendedCommands: readonly string[];
  safetyNotes: readonly string[];
}

export interface IBuildAdoptionReportInput {
  projectRoot: string;
  plan: IAdoptionPlan;
  state: IAdoptionState | null;
}

export function buildAdoptionReport(input: IBuildAdoptionReportInput): IAdoptionReport {
  const freshness = computeAdoptionFreshness(input.projectRoot, input.state);
  const threeWay = input.state
    ? previewThreeWayBatch(input.projectRoot, input.state.targetFiles, {
        draftsChanged: freshness.changedDrafts.length > 0,
      })
    : { perTarget: [], summary: emptyVerdictSummary() };
  return {
    schema: 'sharkcraft.adoption-report/v1',
    projectRoot: input.projectRoot,
    generatedAt: new Date().toISOString(),
    state: input.state,
    freshness,
    threeWay,
    plan: input.plan,
    recommendedCommands: buildRecommended(input.state, freshness),
    safetyNotes: [
      'MCP never writes — adoption outputs are always written by the CLI.',
      'The user must review the patch before applying. `git apply --check` is recommended.',
      'Adoption only appends to existing files. It never overwrites existing entries.',
    ],
  };
}

function emptyVerdictSummary(): Record<ThreeWayVerdict, number> {
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

function buildRecommended(
  state: IAdoptionState | null,
  freshness: IComputeFreshnessResult,
): string[] {
  if (!state) {
    return [
      'shrk onboard --write-drafts',
      'shrk onboard adopt --write-patch --diff-format unified',
      'shrk onboard adopt report --format html --output /tmp/adoption.html',
    ];
  }
  if (freshness.status !== 'fresh') {
    return ['shrk onboard adopt regenerate', 'shrk onboard adopt status'];
  }
  return [
    'shrk onboard adopt check',
    'shrk onboard adopt merge-preview --format markdown',
    `git apply ${state.patchPath}`,
  ];
}

// ─── Renderers ────────────────────────────────────────────────────────────────

export function renderAdoptionReportText(r: IAdoptionReport): string {
  const out: string[] = [];
  out.push('=== Onboarding adoption — report ===');
  out.push(`  generated     ${r.generatedAt}`);
  if (r.state) {
    out.push(`  patch         ${r.state.patchPath}`);
    out.push(`  format        ${r.state.diffFormat}`);
    out.push(`  freshness     ${r.freshness.status}`);
  } else {
    out.push('  state         (none on disk)');
  }
  out.push('');
  out.push('## Categories');
  for (const cat of Object.values(AdoptionCategory)) {
    const items = r.plan.byCategory[cat];
    out.push(`  ${cat.padEnd(18)} ${items.length}`);
  }
  out.push('');
  if (r.state && r.threeWay.perTarget.length > 0) {
    out.push('## Three-way verdicts');
    for (const tw of r.threeWay.perTarget) {
      out.push(`  ${tw.verdict.padEnd(18)} ${tw.relativePath}`);
    }
    out.push('');
  }
  out.push('## Recommended commands');
  for (const c of r.recommendedCommands) out.push(`  $ ${c}`);
  out.push('');
  out.push('## Safety');
  for (const s of r.safetyNotes) out.push(`  - ${s}`);
  return out.join('\n') + '\n';
}

export function renderAdoptionReportMarkdown(r: IAdoptionReport): string {
  const out: string[] = [];
  out.push('# SharkCraft onboarding adoption — report');
  out.push('');
  out.push(`Generated: \`${r.generatedAt}\``);
  if (r.state) {
    out.push(`- Patch: \`${r.state.patchPath}\``);
    out.push(`- Format: \`${r.state.diffFormat}\``);
    out.push(`- Freshness: \`${r.freshness.status}\``);
  } else {
    out.push('- State: _(no adoption state on disk)_');
  }
  out.push('');
  out.push('## Executive summary');
  out.push('');
  out.push('| Category | Count |');
  out.push('|---|---|');
  for (const cat of Object.values(AdoptionCategory)) {
    out.push(`| \`${cat}\` | ${r.plan.byCategory[cat].length} |`);
  }
  out.push('');
  if (r.state && r.threeWay.perTarget.length > 0) {
    out.push('## Three-way verdicts');
    out.push('');
    out.push('| Target | Verdict | Notes |');
    out.push('|---|---|---|');
    for (const tw of r.threeWay.perTarget) {
      out.push(`| \`${tw.relativePath}\` | \`${tw.verdict}\` | ${tw.reasons.join('; ')} |`);
    }
    out.push('');
  }
  renderItemSectionMd(out, 'Safe to adopt', r.plan.byCategory[AdoptionCategory.SafeToAdopt]);
  renderItemSectionMd(out, 'Manual review', r.plan.byCategory[AdoptionCategory.ManualReview]);
  renderItemSectionMd(out, 'Conflicts', r.plan.byCategory[AdoptionCategory.Conflict]);
  renderItemSectionMd(out, 'Skipped / low-confidence', [
    ...r.plan.byCategory[AdoptionCategory.LowConfidence],
    ...r.plan.byCategory[AdoptionCategory.Skipped],
  ]);
  out.push('## Recommended commands');
  out.push('');
  out.push('```');
  for (const c of r.recommendedCommands) out.push(c);
  out.push('```');
  out.push('');
  out.push('## Safety');
  for (const s of r.safetyNotes) out.push(`- ${s}`);
  out.push('');
  return out.join('\n') + '\n';
}

function renderItemSectionMd(out: string[], title: string, items: readonly IAdoptionItem[]): void {
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

const HTML_CSS = `
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e1cf;padding:2rem;line-height:1.55}
h1,h2,h3{margin-top:1.4rem;color:#bae67e}
table{border-collapse:collapse;width:100%;margin:.8rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #2a3138}
th{background:#1c2329;color:#9aa5b0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:600;text-transform:uppercase}
.b-safe{background:#28432e;color:#bae67e}.b-stale{background:#4a2e2e;color:#ff7f7f}
.b-manual{background:#2e3a4a;color:#7fd0ff}.b-probably{background:#3a3a2e;color:#ffd580}
.b-create{background:#28433f;color:#7fe6cf}.b-conflict{background:#5a1f1f;color:#ff9f9f}
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

export function renderAdoptionReportHtml(r: IAdoptionReport): string {
  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8"><title>SharkCraft adoption report</title>');
  out.push(`<style>${HTML_CSS}</style></head><body>`);
  out.push('<h1>SharkCraft onboarding adoption — report</h1>');
  out.push('<p class="note"><strong>MCP never writes.</strong> The user must review the patch before applying.</p>');
  out.push('<h2>Status</h2>');
  out.push('<table>');
  out.push(`<tr><th>Generated</th><td><code>${escapeHtml(r.generatedAt)}</code></td></tr>`);
  if (r.state) {
    out.push(`<tr><th>Patch</th><td><code>${escapeHtml(r.state.patchPath)}</code></td></tr>`);
    out.push(`<tr><th>Format</th><td><code>${escapeHtml(r.state.diffFormat)}</code></td></tr>`);
    out.push(
      `<tr><th>Freshness</th><td><span class="badge ${r.freshness.status === 'fresh' ? 'b-safe' : 'b-stale'}">${escapeHtml(r.freshness.status)}</span></td></tr>`,
    );
  } else {
    out.push('<tr><th>State</th><td><em>no adoption state on disk</em></td></tr>');
  }
  out.push('</table>');

  out.push('<h2>Categories</h2>');
  out.push('<table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>');
  for (const cat of Object.values(AdoptionCategory)) {
    out.push(`<tr><td><code>${escapeHtml(cat)}</code></td><td>${r.plan.byCategory[cat].length}</td></tr>`);
  }
  out.push('</tbody></table>');

  if (r.state && r.threeWay.perTarget.length > 0) {
    out.push('<h2>Three-way verdicts</h2>');
    out.push('<table><thead><tr><th>Target</th><th>Verdict</th><th>Notes</th></tr></thead><tbody>');
    for (const tw of r.threeWay.perTarget) {
      const cls = VERDICT_CSS[tw.verdict];
      out.push(
        `<tr><td><code>${escapeHtml(tw.relativePath)}</code></td>` +
          `<td><span class="badge ${cls}">${escapeHtml(tw.verdict)}</span></td>` +
          `<td>${tw.reasons.map(escapeHtml).join('<br>')}</td></tr>`,
      );
    }
    out.push('</tbody></table>');
  }
  renderItemSectionHtml(out, 'Safe to adopt', r.plan.byCategory[AdoptionCategory.SafeToAdopt]);
  renderItemSectionHtml(out, 'Manual review', r.plan.byCategory[AdoptionCategory.ManualReview]);
  renderItemSectionHtml(out, 'Conflicts', r.plan.byCategory[AdoptionCategory.Conflict]);
  renderItemSectionHtml(
    out,
    'Skipped / low-confidence',
    [...r.plan.byCategory[AdoptionCategory.LowConfidence], ...r.plan.byCategory[AdoptionCategory.Skipped]],
  );
  out.push('<h2>Recommended commands</h2><pre>');
  for (const c of r.recommendedCommands) out.push(escapeHtml(c));
  out.push('</pre>');
  out.push('<h2>Safety</h2><ul>');
  for (const s of r.safetyNotes) out.push(`<li>${escapeHtml(s)}</li>`);
  out.push('</ul></body></html>');
  return out.join('\n') + '\n';
}

function renderItemSectionHtml(out: string[], title: string, items: readonly IAdoptionItem[]): void {
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

export function renderAdoptionReportJson(r: IAdoptionReport): string {
  return JSON.stringify(r, null, 2) + '\n';
}
