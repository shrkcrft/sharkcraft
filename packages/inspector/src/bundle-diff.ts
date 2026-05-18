import { readFeatureBundle, type IFeatureBundle, type IFeatureBundlePlan } from './feature-bundle.ts';

export const BUNDLE_DIFF_SCHEMA = 'sharkcraft.bundle-diff/v1';

export type BundleDiffFormat = 'text' | 'markdown' | 'html' | 'json';

export interface IBundleDiffPlanChange {
  name: string;
  change: 'status' | 'targets' | 'template' | 'variables' | 'review' | 'missing-variables';
  from: unknown;
  to: unknown;
}

export interface IBundleDiffRename {
  from: string;
  to: string;
  confidence: number;
  reasons: readonly string[];
}

export interface IBundleDiffReport {
  schema: typeof BUNDLE_DIFF_SCHEMA;
  generatedAt: string;
  aId: string;
  bId: string;
  metadataChanges: {
    task: { from: string; to: string } | null;
    status: { from: string; to: string } | null;
    riskLevel: { from: string; to: string } | null;
    nextAction: { from: string | null; to: string | null } | null;
  };
  addedPlans: readonly string[];
  removedPlans: readonly string[];
  changedPlans: readonly IBundleDiffPlanChange[];
  /** Probable renamed plans (taken out of addedPlans/removedPlans). */
  renamedPlans: readonly IBundleDiffRename[];
  /** Medium-confidence rename candidates (left in add/remove). */
  possibleRenames: readonly IBundleDiffRename[];
  dependencies: {
    added: readonly { from: string; to: string; reason: string }[];
    removed: readonly { from: string; to: string; reason: string }[];
  };
  planGroups: {
    added: readonly string[];
    removed: readonly string[];
    changed: readonly { id: string; addedPlans: string[]; removedPlans: string[] }[];
  };
  validations: {
    added: readonly { startedAt: string; passed: boolean }[];
    removed: readonly { startedAt: string; passed: boolean }[];
  };
  affectedFiles: {
    added: readonly string[];
    removed: readonly string[];
  };
  warnings: readonly string[];
  summary: {
    totalChanges: number;
    addedPlans: number;
    removedPlans: number;
    changedPlans: number;
    renamedPlans: number;
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plansByName(b: IFeatureBundle): Map<string, IFeatureBundlePlan> {
  return new Map(b.plans.map((p) => [p.name, p] as const));
}

function dependencyKey(d: { from: string; to: string }): string {
  return `${d.from}→${d.to}`;
}

function arrayDiff<T>(a: readonly T[], b: readonly T[]): { added: T[]; removed: T[] } {
  const ax = new Set(a);
  const bx = new Set(b);
  const added: T[] = [];
  const removed: T[] = [];
  for (const item of b) if (!ax.has(item)) added.push(item);
  for (const item of a) if (!bx.has(item)) removed.push(item);
  return { added, removed };
}

function comparePlan(a: IFeatureBundlePlan, b: IFeatureBundlePlan): IBundleDiffPlanChange[] {
  const out: IBundleDiffPlanChange[] = [];
  if (a.status !== b.status) {
    out.push({ name: a.name, change: 'status', from: a.status, to: b.status });
  }
  if (a.templateId !== b.templateId) {
    out.push({ name: a.name, change: 'template', from: a.templateId, to: b.templateId });
  }
  const aT = a.expectedTargets ?? [];
  const bT = b.expectedTargets ?? [];
  const targetDiff = arrayDiff(aT, bT);
  if (targetDiff.added.length > 0 || targetDiff.removed.length > 0) {
    out.push({
      name: a.name,
      change: 'targets',
      from: { added: [], removed: targetDiff.removed },
      to: { added: targetDiff.added, removed: [] },
    });
  }
  const aVars = JSON.stringify(a.variables ?? {});
  const bVars = JSON.stringify(b.variables ?? {});
  if (aVars !== bVars) {
    out.push({ name: a.name, change: 'variables', from: a.variables, to: b.variables });
  }
  const aMissing = (a.missingVariables ?? []).slice().sort().join(',');
  const bMissing = (b.missingVariables ?? []).slice().sort().join(',');
  if (aMissing !== bMissing) {
    out.push({
      name: a.name,
      change: 'missing-variables',
      from: a.missingVariables,
      to: b.missingVariables,
    });
  }
  if ((a.reviewReportFile ?? '') !== (b.reviewReportFile ?? '')) {
    out.push({
      name: a.name,
      change: 'review',
      from: a.reviewReportFile ?? null,
      to: b.reviewReportFile ?? null,
    });
  }
  return out;
}

/**
 * Similarity scorer for plan rename detection. Each signal is worth a
 * fixed weight; the total is normalised to [0, 1]. The thresholds are tuned
 * to favour precision over recall — a near-perfect template-id+target match
 * is required for the automatic rename path.
 */
function scorePlanSimilarity(a: IFeatureBundlePlan, b: IFeatureBundlePlan): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (a.templateId === b.templateId) {
    score += 0.4;
    reasons.push(`templateId matches (${a.templateId})`);
  }
  const aT = new Set(a.expectedTargets ?? []);
  const bT = new Set(b.expectedTargets ?? []);
  const intersection = [...aT].filter((t) => bT.has(t));
  const union = new Set([...aT, ...bT]);
  if (union.size > 0) {
    const jaccard = intersection.length / union.size;
    score += 0.3 * jaccard;
    if (jaccard >= 0.5) reasons.push(`expected-targets overlap (${intersection.length}/${union.size})`);
  }
  const aVars = JSON.stringify(a.variables ?? {});
  const bVars = JSON.stringify(b.variables ?? {});
  if (aVars === bVars && aVars !== '{}') {
    score += 0.2;
    reasons.push('variables identical');
  }
  if ((a.reviewReportFile ?? '') !== '' && a.reviewReportFile === b.reviewReportFile) {
    score += 0.1;
    reasons.push('review report file matches');
  }
  return { score: Math.min(1, score), reasons };
}

const RENAME_AUTO_THRESHOLD = 0.7;
const RENAME_POSSIBLE_THRESHOLD = 0.45;

interface IRenameDetectionResult {
  renames: IBundleDiffRename[];
  possible: IBundleDiffRename[];
  consumedAdded: Set<string>;
  consumedRemoved: Set<string>;
}

function detectRenames(
  added: readonly string[],
  removed: readonly string[],
  aPlans: Map<string, IFeatureBundlePlan>,
  bPlans: Map<string, IFeatureBundlePlan>,
): IRenameDetectionResult {
  const renames: IBundleDiffRename[] = [];
  const possible: IBundleDiffRename[] = [];
  const consumedAdded = new Set<string>();
  const consumedRemoved = new Set<string>();
  // Build candidate pairs ranked by score; greedy assignment.
  type IPair = { from: string; to: string; score: number; reasons: string[] };
  const pairs: IPair[] = [];
  for (const fromName of removed) {
    const fromPlan = aPlans.get(fromName);
    if (!fromPlan) continue;
    for (const toName of added) {
      const toPlan = bPlans.get(toName);
      if (!toPlan) continue;
      const { score, reasons } = scorePlanSimilarity(fromPlan, toPlan);
      if (score >= RENAME_POSSIBLE_THRESHOLD) {
        pairs.push({ from: fromName, to: toName, score, reasons });
      }
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  for (const p of pairs) {
    if (consumedAdded.has(p.to) || consumedRemoved.has(p.from)) continue;
    const entry: IBundleDiffRename = {
      from: p.from,
      to: p.to,
      confidence: Math.round(p.score * 100) / 100,
      reasons: p.reasons,
    };
    if (p.score >= RENAME_AUTO_THRESHOLD) {
      renames.push(entry);
      consumedAdded.add(p.to);
      consumedRemoved.add(p.from);
    } else {
      possible.push(entry);
    }
  }
  return { renames, possible, consumedAdded, consumedRemoved };
}

export function buildBundleDiff(a: IFeatureBundle, b: IFeatureBundle): IBundleDiffReport {
  const warnings: string[] = [];
  if (a.id === b.id) {
    warnings.push('Comparing a bundle against itself — no metadata changes expected.');
  }
  const aPlans = plansByName(a);
  const bPlans = plansByName(b);
  const addedPlansRaw: string[] = [];
  const removedPlansRaw: string[] = [];
  const changedPlans: IBundleDiffPlanChange[] = [];
  for (const name of bPlans.keys()) if (!aPlans.has(name)) addedPlansRaw.push(name);
  for (const name of aPlans.keys()) if (!bPlans.has(name)) removedPlansRaw.push(name);
  for (const [name, plan] of aPlans) {
    const bp = bPlans.get(name);
    if (!bp) continue;
    for (const change of comparePlan(plan, bp)) changedPlans.push(change);
  }
  // Rename detection — pair plans by template/target/variable similarity
  // before reporting add/remove.
  const rename = detectRenames(addedPlansRaw, removedPlansRaw, aPlans, bPlans);
  const addedPlans = addedPlansRaw.filter((n) => !rename.consumedAdded.has(n));
  const removedPlans = removedPlansRaw.filter((n) => !rename.consumedRemoved.has(n));
  // For renamed plans, run a normal field comparison so the changed-plan list
  // captures any drift inside the rename.
  for (const r of rename.renames) {
    const aPlan = aPlans.get(r.from);
    const bPlan = bPlans.get(r.to);
    if (!aPlan || !bPlan) continue;
    for (const change of comparePlan(aPlan, bPlan)) {
      // Report under the new name so downstream renderers can group correctly.
      changedPlans.push({ ...change, name: r.to });
    }
  }
  const aDepKeys = new Set(a.dependencies.map(dependencyKey));
  const bDepKeys = new Set(b.dependencies.map(dependencyKey));
  const dependencies = {
    added: b.dependencies.filter((d) => !aDepKeys.has(dependencyKey(d))),
    removed: a.dependencies.filter((d) => !bDepKeys.has(dependencyKey(d))),
  };
  // Plan groups
  const aGroups = new Map(a.planGroups.map((g) => [g.id, g.planNames]));
  const bGroups = new Map(b.planGroups.map((g) => [g.id, g.planNames]));
  const groupsAdded: string[] = [];
  const groupsRemoved: string[] = [];
  const groupsChanged: { id: string; addedPlans: string[]; removedPlans: string[] }[] = [];
  for (const id of bGroups.keys()) if (!aGroups.has(id)) groupsAdded.push(id);
  for (const id of aGroups.keys()) if (!bGroups.has(id)) groupsRemoved.push(id);
  for (const [id, plans] of aGroups) {
    const next = bGroups.get(id);
    if (!next) continue;
    const diff = arrayDiff(plans, next);
    if (diff.added.length > 0 || diff.removed.length > 0) {
      groupsChanged.push({ id, addedPlans: diff.added, removedPlans: diff.removed });
    }
  }
  // Validations: compare by startedAt.
  const aValKeys = new Set(a.validations.map((v) => v.startedAt));
  const bValKeys = new Set(b.validations.map((v) => v.startedAt));
  const validations = {
    added: b.validations
      .filter((v) => !aValKeys.has(v.startedAt))
      .map((v) => ({ startedAt: v.startedAt, passed: v.passed })),
    removed: a.validations
      .filter((v) => !bValKeys.has(v.startedAt))
      .map((v) => ({ startedAt: v.startedAt, passed: v.passed })),
  };
  const filesDiff = arrayDiff(a.affectedFiles, b.affectedFiles);
  const meta = {
    task: a.task !== b.task ? { from: a.task, to: b.task } : null,
    status: a.status !== b.status ? { from: a.status, to: b.status } : null,
    riskLevel: a.riskLevel !== b.riskLevel ? { from: a.riskLevel, to: b.riskLevel } : null,
    nextAction:
      (a.nextAction ?? null) !== (b.nextAction ?? null)
        ? { from: a.nextAction ?? null, to: b.nextAction ?? null }
        : null,
  };
  const summary = {
    totalChanges:
      (meta.task ? 1 : 0) +
      (meta.status ? 1 : 0) +
      (meta.riskLevel ? 1 : 0) +
      (meta.nextAction ? 1 : 0) +
      addedPlans.length +
      removedPlans.length +
      changedPlans.length +
      rename.renames.length +
      dependencies.added.length +
      dependencies.removed.length +
      groupsAdded.length +
      groupsRemoved.length +
      groupsChanged.length +
      validations.added.length +
      validations.removed.length +
      filesDiff.added.length +
      filesDiff.removed.length,
    addedPlans: addedPlans.length,
    removedPlans: removedPlans.length,
    changedPlans: changedPlans.length,
    renamedPlans: rename.renames.length,
  };
  return {
    schema: BUNDLE_DIFF_SCHEMA,
    generatedAt: new Date().toISOString(),
    aId: a.id,
    bId: b.id,
    metadataChanges: meta,
    addedPlans,
    removedPlans,
    changedPlans,
    renamedPlans: rename.renames,
    possibleRenames: rename.possible,
    dependencies,
    planGroups: { added: groupsAdded, removed: groupsRemoved, changed: groupsChanged },
    validations,
    affectedFiles: { added: filesDiff.added, removed: filesDiff.removed },
    warnings,
    summary,
  };
}

export function buildBundleDiffFromIds(
  cwd: string,
  aId: string,
  bId: string,
): IBundleDiffReport | { error: string } {
  const a = readFeatureBundle(cwd, aId);
  if (!a) return { error: `No bundle "${aId}"` };
  const b = readFeatureBundle(cwd, bId);
  if (!b) return { error: `No bundle "${bId}"` };
  return buildBundleDiff(a, b);
}

export function renderBundleDiffText(diff: IBundleDiffReport): string {
  const lines: string[] = [];
  lines.push(`Bundle diff ${diff.aId} → ${diff.bId} (generated ${diff.generatedAt})`);
  lines.push(`Total changes: ${diff.summary.totalChanges}`);
  if (diff.metadataChanges.task)
    lines.push(`  task: "${diff.metadataChanges.task.from}" → "${diff.metadataChanges.task.to}"`);
  if (diff.metadataChanges.status)
    lines.push(`  status: ${diff.metadataChanges.status.from} → ${diff.metadataChanges.status.to}`);
  if (diff.metadataChanges.riskLevel)
    lines.push(`  risk: ${diff.metadataChanges.riskLevel.from} → ${diff.metadataChanges.riskLevel.to}`);
  if (diff.addedPlans.length > 0) {
    lines.push('\nAdded plans:');
    for (const p of diff.addedPlans) lines.push(`  + ${p}`);
  }
  if (diff.removedPlans.length > 0) {
    lines.push('\nRemoved plans:');
    for (const p of diff.removedPlans) lines.push(`  - ${p}`);
  }
  if (diff.changedPlans.length > 0) {
    lines.push('\nChanged plans:');
    for (const c of diff.changedPlans) {
      lines.push(`  ~ ${c.name} [${c.change}]`);
    }
  }
  if (diff.renamedPlans.length > 0) {
    lines.push('\nRenamed plans:');
    for (const r of diff.renamedPlans) {
      lines.push(`  → ${r.from} → ${r.to}  (conf=${r.confidence}; ${r.reasons.join('; ')})`);
    }
  }
  if (diff.possibleRenames.length > 0) {
    lines.push('\nPossible renames (lower confidence — review):');
    for (const r of diff.possibleRenames) {
      lines.push(`  ? ${r.from} ⇢ ${r.to}  (conf=${r.confidence})`);
    }
  }
  if (diff.dependencies.added.length > 0 || diff.dependencies.removed.length > 0) {
    lines.push('\nDependencies:');
    for (const d of diff.dependencies.added) lines.push(`  + ${d.from} → ${d.to} (${d.reason})`);
    for (const d of diff.dependencies.removed) lines.push(`  - ${d.from} → ${d.to} (${d.reason})`);
  }
  if (diff.planGroups.added.length || diff.planGroups.removed.length || diff.planGroups.changed.length) {
    lines.push('\nPlan groups:');
    for (const id of diff.planGroups.added) lines.push(`  + ${id}`);
    for (const id of diff.planGroups.removed) lines.push(`  - ${id}`);
    for (const g of diff.planGroups.changed) {
      lines.push(`  ~ ${g.id}: +[${g.addedPlans.join(',')}] -[${g.removedPlans.join(',')}]`);
    }
  }
  if (diff.validations.added.length > 0 || diff.validations.removed.length > 0) {
    lines.push('\nValidations:');
    for (const v of diff.validations.added)
      lines.push(`  + ${v.startedAt} ${v.passed ? 'passed' : 'failed'}`);
    for (const v of diff.validations.removed)
      lines.push(`  - ${v.startedAt} ${v.passed ? 'passed' : 'failed'}`);
  }
  if (diff.affectedFiles.added.length > 0 || diff.affectedFiles.removed.length > 0) {
    lines.push('\nAffected files:');
    for (const f of diff.affectedFiles.added) lines.push(`  + ${f}`);
    for (const f of diff.affectedFiles.removed) lines.push(`  - ${f}`);
  }
  if (diff.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const w of diff.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n') + '\n';
}

export function renderBundleDiffMarkdown(diff: IBundleDiffReport): string {
  const lines: string[] = [];
  lines.push(`# Bundle diff \`${diff.aId}\` → \`${diff.bId}\``);
  lines.push('');
  lines.push(`Generated: ${diff.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total changes: ${diff.summary.totalChanges}`);
  lines.push(`- Added plans: ${diff.summary.addedPlans}`);
  lines.push(`- Removed plans: ${diff.summary.removedPlans}`);
  lines.push(`- Changed plans: ${diff.summary.changedPlans}`);
  lines.push('');
  if (diff.metadataChanges.task) {
    lines.push(`### Task\n\n\`${diff.metadataChanges.task.from}\` → \`${diff.metadataChanges.task.to}\`\n`);
  }
  if (diff.metadataChanges.status) {
    lines.push(`### Status\n\n${diff.metadataChanges.status.from} → ${diff.metadataChanges.status.to}\n`);
  }
  if (diff.addedPlans.length > 0) {
    lines.push('## Added plans');
    lines.push('');
    for (const p of diff.addedPlans) lines.push(`- \`${p}\``);
    lines.push('');
  }
  if (diff.removedPlans.length > 0) {
    lines.push('## Removed plans');
    lines.push('');
    for (const p of diff.removedPlans) lines.push(`- \`${p}\``);
    lines.push('');
  }
  if (diff.changedPlans.length > 0) {
    lines.push('## Changed plans');
    lines.push('');
    for (const c of diff.changedPlans) {
      lines.push(`- \`${c.name}\` _[${c.change}]_`);
    }
    lines.push('');
  }
  if (diff.renamedPlans.length > 0) {
    lines.push('## Renamed plans');
    lines.push('');
    for (const r of diff.renamedPlans) {
      lines.push(`- \`${r.from}\` → \`${r.to}\` _(confidence=${r.confidence}; ${r.reasons.join('; ')})_`);
    }
    lines.push('');
  }
  if (diff.possibleRenames.length > 0) {
    lines.push('## Possible renames');
    lines.push('');
    for (const r of diff.possibleRenames) {
      lines.push(`- ? \`${r.from}\` ⇢ \`${r.to}\` _(confidence=${r.confidence})_`);
    }
    lines.push('');
  }
  if (diff.dependencies.added.length > 0 || diff.dependencies.removed.length > 0) {
    lines.push('## Dependencies');
    lines.push('');
    for (const d of diff.dependencies.added) lines.push(`- + \`${d.from}\` → \`${d.to}\` (${d.reason})`);
    for (const d of diff.dependencies.removed) lines.push(`- − \`${d.from}\` → \`${d.to}\` (${d.reason})`);
    lines.push('');
  }
  if (diff.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of diff.warnings) lines.push(`- ${w}`);
  }
  return lines.join('\n') + '\n';
}

export function renderBundleDiffHtml(diff: IBundleDiffReport): string {
  const out: string[] = [];
  out.push('<!doctype html><html><head><meta charset="utf-8"><title>Bundle diff</title>');
  out.push('<style>');
  out.push('body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}');
  out.push('h1{font-size:24px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}');
  out.push('.muted{color:#586069}.tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;background:#eef2f6}');
  out.push('.add{color:#22863a}.del{color:#b31d28}');
  out.push('table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}th{background:#f6f8fa}');
  out.push('@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}th{background:#161b22}.muted{color:#8b949e}.tag{background:#21262d}}');
  out.push('</style></head><body>');
  out.push(`<h1>Bundle diff <code>${esc(diff.aId)}</code> → <code>${esc(diff.bId)}</code></h1>`);
  out.push(`<p class="muted">Generated ${esc(diff.generatedAt)}</p>`);
  out.push(
    `<p>Summary: total=${diff.summary.totalChanges} · +plans=${diff.summary.addedPlans} · −plans=${diff.summary.removedPlans} · ~plans=${diff.summary.changedPlans}</p>`,
  );
  if (diff.metadataChanges.task || diff.metadataChanges.status || diff.metadataChanges.riskLevel) {
    out.push('<h2>Metadata</h2><ul>');
    if (diff.metadataChanges.task)
      out.push(`<li>task: <code>${esc(diff.metadataChanges.task.from)}</code> → <code>${esc(diff.metadataChanges.task.to)}</code></li>`);
    if (diff.metadataChanges.status)
      out.push(`<li>status: ${esc(diff.metadataChanges.status.from)} → ${esc(diff.metadataChanges.status.to)}</li>`);
    if (diff.metadataChanges.riskLevel)
      out.push(`<li>risk: ${esc(diff.metadataChanges.riskLevel.from)} → ${esc(diff.metadataChanges.riskLevel.to)}</li>`);
    out.push('</ul>');
  }
  if (diff.addedPlans.length > 0) {
    out.push('<h2>Added plans</h2><ul>');
    for (const p of diff.addedPlans) out.push(`<li class="add">+ <code>${esc(p)}</code></li>`);
    out.push('</ul>');
  }
  if (diff.removedPlans.length > 0) {
    out.push('<h2>Removed plans</h2><ul>');
    for (const p of diff.removedPlans) out.push(`<li class="del">− <code>${esc(p)}</code></li>`);
    out.push('</ul>');
  }
  if (diff.changedPlans.length > 0) {
    out.push('<h2>Changed plans</h2>');
    out.push('<table><thead><tr><th>Plan</th><th>Change</th></tr></thead><tbody>');
    for (const c of diff.changedPlans) {
      out.push(`<tr><td><code>${esc(c.name)}</code></td><td><span class="tag">${esc(c.change)}</span></td></tr>`);
    }
    out.push('</tbody></table>');
  }
  if (diff.renamedPlans.length > 0) {
    out.push('<h2>Renamed plans</h2>');
    out.push('<table><thead><tr><th>From</th><th>To</th><th>Confidence</th><th>Reasons</th></tr></thead><tbody>');
    for (const r of diff.renamedPlans) {
      out.push(
        `<tr><td><code>${esc(r.from)}</code></td><td><code>${esc(r.to)}</code></td><td>${r.confidence}</td><td>${esc(r.reasons.join('; '))}</td></tr>`,
      );
    }
    out.push('</tbody></table>');
  }
  if (diff.possibleRenames.length > 0) {
    out.push('<h2>Possible renames</h2><ul>');
    for (const r of diff.possibleRenames) {
      out.push(`<li>? <code>${esc(r.from)}</code> ⇢ <code>${esc(r.to)}</code> <span class="muted">(confidence ${r.confidence})</span></li>`);
    }
    out.push('</ul>');
  }
  if (diff.dependencies.added.length > 0 || diff.dependencies.removed.length > 0) {
    out.push('<h2>Dependencies</h2><ul>');
    for (const d of diff.dependencies.added)
      out.push(`<li class="add">+ <code>${esc(d.from)}</code> → <code>${esc(d.to)}</code> <span class="muted">(${esc(d.reason)})</span></li>`);
    for (const d of diff.dependencies.removed)
      out.push(`<li class="del">− <code>${esc(d.from)}</code> → <code>${esc(d.to)}</code> <span class="muted">(${esc(d.reason)})</span></li>`);
    out.push('</ul>');
  }
  if (diff.affectedFiles.added.length > 0 || diff.affectedFiles.removed.length > 0) {
    out.push('<h2>Affected files</h2><ul>');
    for (const f of diff.affectedFiles.added) out.push(`<li class="add">+ <code>${esc(f)}</code></li>`);
    for (const f of diff.affectedFiles.removed) out.push(`<li class="del">− <code>${esc(f)}</code></li>`);
    out.push('</ul>');
  }
  if (diff.warnings.length > 0) {
    out.push('<h2>Warnings</h2><ul>');
    for (const w of diff.warnings) out.push(`<li>${esc(w)}</li>`);
    out.push('</ul>');
  }
  out.push('</body></html>');
  return out.join('\n') + '\n';
}

export function renderBundleDiff(diff: IBundleDiffReport, format: BundleDiffFormat): string {
  if (format === 'markdown') return renderBundleDiffMarkdown(diff);
  if (format === 'html') return renderBundleDiffHtml(diff);
  if (format === 'json') return JSON.stringify(diff, null, 2) + '\n';
  return renderBundleDiffText(diff);
}
