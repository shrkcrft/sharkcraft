import type { IImpactAnalysis } from './impact-analysis.ts';

export interface IImpactRenderOptions {
  /** When true, include the ASCII / `<details>` dependency tree. */
  tree?: boolean;
  /** Max nodes per branch / depth of the tree. */
  treeDepth?: number;
  treeWidth?: number;
}

function riskBadgeTag(risk: string): 'ok' | 'warn' | 'fail' {
  switch (risk) {
    case 'low':
      return 'ok';
    case 'medium':
    case 'high':
      return 'warn';
    case 'critical':
      return 'fail';
    default:
      return 'warn';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bullet(items: readonly string[], prefix = '  - '): string {
  if (items.length === 0) return '_(none)_';
  return items.map((i) => `${prefix}${i}`).join('\n');
}

interface ITreeNode {
  file: string;
  children: ITreeNode[];
}

/** Build a small dependency tree rooted at every normalized target. */
export function buildImpactTree(
  impact: IImpactAnalysis,
  opts: { depth?: number; width?: number } = {},
): ITreeNode[] {
  const depth = Math.max(1, opts.depth ?? 3);
  const width = Math.max(1, opts.width ?? 5);
  // Reconstruct importer→[importers] map from the dependencyPathExamples.
  // Each example chain is `from → via... → to`; the importer relationship is
  // each consecutive pair in reverse order (the `to` is imported by `from`).
  const importers = new Map<string, Set<string>>();
  for (const p of impact.dependencyPathExamples) {
    const chain = [p.from, ...p.via, p.to];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const importer = chain[i]!;
      const target = chain[i + 1]!;
      const set = importers.get(target) ?? new Set<string>();
      set.add(importer);
      importers.set(target, set);
    }
  }
  // Also seed the root targets with their direct dependents.
  for (const target of impact.normalizedTargets) {
    const set = importers.get(target) ?? new Set<string>();
    for (const dep of impact.directDependents) {
      // Heuristic: every direct dependent is a candidate importer of every
      // target (the real graph is captured in dependencyPathExamples).
      // We only add direct dependents if they don't already appear as
      // importers via the example chain to avoid noise.
      if (!set.has(dep)) set.add(dep);
    }
    importers.set(target, set);
  }
  const visited = new Set<string>();
  const build = (file: string, d: number): ITreeNode => {
    if (visited.has(file) || d >= depth) {
      return { file, children: [] };
    }
    visited.add(file);
    const direct = [...(importers.get(file) ?? [])].slice(0, width);
    return {
      file,
      children: direct.map((c) => build(c, d + 1)),
    };
  };
  return impact.normalizedTargets.map((t) => build(t, 0));
}

function renderTreeText(nodes: readonly ITreeNode[]): string {
  const lines: string[] = [];
  const walk = (node: ITreeNode, prefix: string, isLast: boolean): void => {
    const connector = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
    lines.push(prefix + connector + node.file);
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    for (let i = 0; i < node.children.length; i += 1) {
      walk(node.children[i]!, childPrefix, i === node.children.length - 1);
    }
  };
  for (const root of nodes) walk(root, '', true);
  return lines.join('\n');
}

function renderTreeHtml(nodes: readonly ITreeNode[]): string {
  const walk = (node: ITreeNode): string => {
    if (node.children.length === 0) {
      return `<li><code>${escapeHtml(node.file)}</code></li>`;
    }
    return [
      '<li>',
      `<details open><summary><code>${escapeHtml(node.file)}</code></summary>`,
      '<ul>',
      ...node.children.map(walk),
      '</ul></details>',
      '</li>',
    ].join('');
  };
  return `<ul class="impact-tree">${nodes.map(walk).join('')}</ul>`;
}

export function renderImpactText(
  impact: IImpactAnalysis,
  opts: IImpactRenderOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`=== Impact (${impact.inputKind}) ===`);
  if (impact.task) lines.push(`Task: ${impact.task}`);
  if (impact.specifier) lines.push(`Specifier: ${impact.specifier}`);
  lines.push(`Risk: ${impact.risk}`);
  if (impact.riskReasons.length > 0) {
    lines.push('Reasons:');
    for (const r of impact.riskReasons.slice(0, 6)) lines.push(`  - ${r.code}: ${r.message}`);
  }
  lines.push(`Targets (${impact.normalizedTargets.length}):`);
  for (const f of impact.normalizedTargets.slice(0, 12)) lines.push(`  • ${f}`);
  lines.push(`Direct dependents (${impact.directDependents.length}):`);
  for (const f of impact.directDependents.slice(0, 12)) lines.push(`  ← ${f}`);
  lines.push(`Transitive dependents (${impact.transitiveDependents.length}):`);
  for (const f of impact.transitiveDependents.slice(0, 12)) lines.push(`  ⤵ ${f}`);
  if (opts.tree !== false) {
    const tree = buildImpactTree(impact, {
      ...(opts.treeDepth ? { depth: opts.treeDepth } : {}),
      ...(opts.treeWidth ? { width: opts.treeWidth } : {}),
    });
    lines.push('');
    lines.push('Dependency tree:');
    lines.push(renderTreeText(tree));
    if (impact.transitiveDependents.length > (opts.treeWidth ?? 5) * impact.normalizedTargets.length) {
      lines.push(`... rerun with --limit for the full list`);
    }
  }
  if (impact.affectedPackages.length > 0) {
    lines.push(`Packages: ${impact.affectedPackages.map((p) => p.name).join(', ')}`);
  }
  if (impact.potentialBoundaryRisks.length > 0) {
    lines.push('Boundary risks:');
    for (const b of impact.potentialBoundaryRisks.slice(0, 6))
      lines.push(`  ! ${b.ruleId}: ${b.reason}`);
  }
  if (impact.affectedPolicies.length > 0) {
    lines.push('Policy concerns:');
    for (const p of impact.affectedPolicies) lines.push(`  [${p.severity}] ${p.policyId}`);
  }
  if (impact.affectedOwnership?.requiredReviewFiles.length) {
    lines.push(
      `Required review: ${impact.affectedOwnership.requiredReviewFiles.length} file(s)`,
    );
  }
  lines.push('Suggested tests:');
  for (const c of impact.suggestedTestCommands.slice(0, 4)) lines.push(`  $ ${c}`);
  lines.push('Suggested verification:');
  for (const c of impact.suggestedValidationCommands.slice(0, 4)) lines.push(`  $ ${c}`);
  if (impact.suggestedReviewCommands.length > 0) {
    lines.push('Suggested review:');
    for (const c of impact.suggestedReviewCommands.slice(0, 3)) lines.push(`  $ ${c}`);
  }
  if (impact.truncations.length > 0) {
    lines.push('Truncated:');
    for (const t of impact.truncations) lines.push(`  ${t.list}: ${t.shown}/${t.total}`);
  }
  if (impact.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const d of impact.diagnostics) lines.push(`  ! ${d}`);
  }
  lines.push('');
  lines.push(impact.explanation);
  return lines.join('\n') + '\n';
}

export function renderImpactMarkdown(
  impact: IImpactAnalysis,
  opts: IImpactRenderOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`# Impact report`);
  lines.push('');
  lines.push(`**Risk:** \`${impact.risk}\` · **Input:** \`${impact.inputKind}\``);
  if (impact.task) lines.push(`**Task:** ${impact.task}`);
  if (impact.specifier) lines.push(`**Specifier:** \`${impact.specifier}\``);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(impact.explanation);
  lines.push('');
  lines.push(`## Targets (${impact.normalizedTargets.length})`);
  lines.push('');
  lines.push(bullet(impact.normalizedTargets.slice(0, 20).map((f) => `\`${f}\``)));
  lines.push('');
  lines.push(`## Risk reasons`);
  lines.push('');
  if (impact.riskReasons.length === 0) lines.push('_None._');
  for (const r of impact.riskReasons) lines.push(`- **${r.code}** — ${r.message}`);
  lines.push('');
  lines.push(`## Direct dependents (${impact.directDependents.length})`);
  lines.push('');
  lines.push(bullet(impact.directDependents.slice(0, 50).map((f) => `\`${f}\``)));
  lines.push('');
  lines.push(`## Transitive dependents (${impact.transitiveDependents.length})`);
  lines.push('');
  lines.push(bullet(impact.transitiveDependents.slice(0, 50).map((f) => `\`${f}\``)));
  if (impact.dependencyPathExamples.length > 0) {
    lines.push('');
    lines.push('### Example dependency paths');
    lines.push('');
    for (const p of impact.dependencyPathExamples.slice(0, 5)) {
      const chain = [p.from, ...p.via, p.to].map((x) => `\`${x}\``).join(' → ');
      lines.push(`- ${chain}`);
    }
  }
  if (opts.tree !== false) {
    const tree = buildImpactTree(impact, {
      ...(opts.treeDepth ? { depth: opts.treeDepth } : {}),
      ...(opts.treeWidth ? { width: opts.treeWidth } : {}),
    });
    lines.push('');
    lines.push('## Dependency tree');
    lines.push('');
    lines.push('```');
    lines.push(renderTreeText(tree));
    lines.push('```');
  }
  if (impact.affectedPackages.length > 0) {
    lines.push('');
    lines.push(`## Affected packages`);
    lines.push('');
    for (const p of impact.affectedPackages) lines.push(`- \`${p.name}\` (${p.fileCount})`);
  }
  if (impact.affectedOwnership && impact.affectedOwnership.owners.length > 0) {
    lines.push('');
    lines.push(`## Ownership`);
    lines.push('');
    lines.push(`Owners: ${impact.affectedOwnership.owners.join(', ') || '_none_'}`);
    if (impact.affectedOwnership.requiredReviewFiles.length > 0) {
      lines.push(
        `Requires review on: ${impact.affectedOwnership.requiredReviewFiles
          .slice(0, 20)
          .map((f) => '`' + f + '`')
          .join(', ')}`,
      );
    }
  }
  if (impact.potentialBoundaryRisks.length > 0) {
    lines.push('');
    lines.push(`## Boundary risks`);
    lines.push('');
    for (const b of impact.potentialBoundaryRisks)
      lines.push(`- [${b.severity}] \`${b.ruleId}\` — ${b.reason}`);
  }
  if (impact.affectedPolicies.length > 0) {
    lines.push('');
    lines.push(`## Policy concerns`);
    lines.push('');
    for (const p of impact.affectedPolicies)
      lines.push(`- [${p.severity}] **${p.policyId}** — ${p.reason}`);
  }
  lines.push('');
  lines.push(`## Suggested tests`);
  lines.push('');
  for (const c of impact.suggestedTestCommands) lines.push(`- \`${c}\``);
  lines.push('');
  lines.push(`## Suggested verification`);
  lines.push('');
  for (const c of impact.suggestedValidationCommands) lines.push(`- \`${c}\``);
  if (impact.suggestedReviewCommands.length > 0) {
    lines.push('');
    lines.push(`## Suggested review`);
    lines.push('');
    for (const c of impact.suggestedReviewCommands) lines.push(`- \`${c}\``);
  }
  if (impact.truncations.length > 0) {
    lines.push('');
    lines.push(`## Truncations`);
    lines.push('');
    for (const t of impact.truncations) lines.push(`- ${t.list}: ${t.shown}/${t.total}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderImpactHtml(
  impact: IImpactAnalysis,
  opts: IImpactRenderOptions = {},
): string {
  const badge = riskBadgeTag(impact.risk);
  const parts: string[] = [];
  parts.push('<!doctype html><html><head><meta charset="utf-8">');
  parts.push(`<title>SharkCraft impact — ${escapeHtml(impact.task || impact.inputKind)}</title>`);
  parts.push('<style>');
  parts.push(
    'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;color:#1f2328;background:#fff}',
  );
  parts.push('h1{font-size:22px;border-bottom:1px solid #d0d7de;padding-bottom:8px}');
  parts.push('h2{font-size:16px;margin-top:24px}');
  parts.push('table{border-collapse:collapse;width:100%;margin:8px 0}');
  parts.push('th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}');
  parts.push('th{background:#f6f8fa}');
  parts.push('code,pre{background:#f6f8fa;padding:1px 4px;border-radius:4px;font-size:12px}');
  parts.push('.tag{display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:700}');
  parts.push('.tag.ok{background:#dafbe1;color:#1a7f37}');
  parts.push('.tag.warn{background:#fff8c5;color:#9a6700}');
  parts.push('.tag.fail{background:#ffebe9;color:#cf222e}');
  parts.push('.impact-tree{list-style:none;padding-left:0}');
  parts.push('.impact-tree ul{list-style:none;padding-left:18px;border-left:1px solid #d0d7de;margin:4px 0}');
  parts.push('details>summary{cursor:pointer}');
  parts.push('@media (prefers-color-scheme: dark){body{background:#0f1419;color:#e6e1cf}th{background:#1c2329}code,pre{background:#1c2329}.tag.ok{background:#1f4d2a;color:#bae67e}.tag.warn{background:#5a4a00;color:#ffd866}.tag.fail{background:#5a1f1f;color:#ff8a80}}');
  parts.push('</style></head><body>');
  parts.push(`<h1>Impact report <span class="tag ${badge}">${escapeHtml(impact.risk.toUpperCase())}</span></h1>`);
  parts.push('<table>');
  parts.push(`<tr><th>Input</th><td><code>${escapeHtml(impact.inputKind)}</code></td></tr>`);
  if (impact.task)
    parts.push(`<tr><th>Task</th><td>${escapeHtml(impact.task)}</td></tr>`);
  if (impact.specifier)
    parts.push(`<tr><th>Specifier</th><td><code>${escapeHtml(impact.specifier)}</code></td></tr>`);
  parts.push(`<tr><th>Targets</th><td>${impact.normalizedTargets.length}</td></tr>`);
  parts.push(`<tr><th>Direct</th><td>${impact.directDependents.length}</td></tr>`);
  parts.push(`<tr><th>Transitive</th><td>${impact.transitiveDependents.length}</td></tr>`);
  parts.push(`<tr><th>Boundary risks</th><td>${impact.potentialBoundaryRisks.length}</td></tr>`);
  parts.push(`<tr><th>Policy concerns</th><td>${impact.affectedPolicies.length}</td></tr>`);
  parts.push('</table>');
  parts.push(`<p>${escapeHtml(impact.explanation)}</p>`);
  parts.push('<h2>Targets</h2><ul>');
  for (const f of impact.normalizedTargets)
    parts.push(`<li><code>${escapeHtml(f)}</code></li>`);
  parts.push('</ul>');
  if (impact.riskReasons.length > 0) {
    parts.push('<h2>Risk reasons</h2><ul>');
    for (const r of impact.riskReasons)
      parts.push(`<li><strong>${escapeHtml(r.code)}</strong> — ${escapeHtml(r.message)}</li>`);
    parts.push('</ul>');
  }
  parts.push(`<h2>Direct dependents (${impact.directDependents.length})</h2>`);
  if (impact.directDependents.length === 0) parts.push('<p><em>(none)</em></p>');
  else {
    parts.push('<ul>');
    for (const f of impact.directDependents.slice(0, 100))
      parts.push(`<li><code>${escapeHtml(f)}</code></li>`);
    parts.push('</ul>');
  }
  parts.push(`<h2>Transitive dependents (${impact.transitiveDependents.length})</h2>`);
  if (impact.transitiveDependents.length === 0) parts.push('<p><em>(none)</em></p>');
  else {
    parts.push('<ul>');
    for (const f of impact.transitiveDependents.slice(0, 100))
      parts.push(`<li><code>${escapeHtml(f)}</code></li>`);
    parts.push('</ul>');
  }
  if (opts.tree !== false) {
    const tree = buildImpactTree(impact, {
      ...(opts.treeDepth ? { depth: opts.treeDepth } : {}),
      ...(opts.treeWidth ? { width: opts.treeWidth } : {}),
    });
    parts.push('<h2>Dependency tree</h2>');
    parts.push(renderTreeHtml(tree));
  }
  if (impact.affectedPackages.length > 0) {
    parts.push('<h2>Affected packages</h2><ul>');
    for (const p of impact.affectedPackages)
      parts.push(`<li><code>${escapeHtml(p.name)}</code> (${p.fileCount})</li>`);
    parts.push('</ul>');
  }
  if (impact.affectedOwnership?.owners.length) {
    parts.push('<h2>Ownership</h2>');
    parts.push(
      `<p>Owners: ${impact.affectedOwnership.owners.map((o) => escapeHtml(o)).join(', ')}</p>`,
    );
    if (impact.affectedOwnership.requiredReviewFiles.length > 0) {
      parts.push('<p>Required review files:</p><ul>');
      for (const f of impact.affectedOwnership.requiredReviewFiles)
        parts.push(`<li><code>${escapeHtml(f)}</code></li>`);
      parts.push('</ul>');
    }
  }
  if (impact.potentialBoundaryRisks.length > 0) {
    parts.push('<h2>Boundary risks</h2><ul>');
    for (const b of impact.potentialBoundaryRisks)
      parts.push(
        `<li><span class="tag warn">${escapeHtml(b.severity.toUpperCase())}</span> <code>${escapeHtml(b.ruleId)}</code> — ${escapeHtml(b.reason)}</li>`,
      );
    parts.push('</ul>');
  }
  if (impact.affectedPolicies.length > 0) {
    parts.push('<h2>Policy concerns</h2><ul>');
    for (const p of impact.affectedPolicies)
      parts.push(
        `<li><span class="tag warn">${escapeHtml(p.severity.toUpperCase())}</span> <strong>${escapeHtml(p.policyId)}</strong> — ${escapeHtml(p.reason)}</li>`,
      );
    parts.push('</ul>');
  }
  parts.push('<h2>Suggested commands</h2>');
  parts.push('<table><thead><tr><th>Kind</th><th>Command</th></tr></thead><tbody>');
  for (const c of impact.suggestedTestCommands)
    parts.push(`<tr><td>test</td><td><code>${escapeHtml(c)}</code></td></tr>`);
  for (const c of impact.suggestedValidationCommands)
    parts.push(`<tr><td>verify</td><td><code>${escapeHtml(c)}</code></td></tr>`);
  for (const c of impact.suggestedReviewCommands)
    parts.push(`<tr><td>review</td><td><code>${escapeHtml(c)}</code></td></tr>`);
  parts.push('</tbody></table>');
  if (impact.truncations.length > 0) {
    parts.push('<h2>Truncations</h2><ul>');
    for (const t of impact.truncations)
      parts.push(`<li><code>${escapeHtml(t.list)}</code>: ${t.shown}/${t.total}</li>`);
    parts.push('</ul>');
  }
  if (impact.diagnostics.length > 0) {
    parts.push('<h2>Diagnostics</h2><ul>');
    for (const d of impact.diagnostics) parts.push(`<li>${escapeHtml(d)}</li>`);
    parts.push('</ul>');
  }
  parts.push('<p><em>Generated by SharkCraft impact-analysis v2.</em></p>');
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}
