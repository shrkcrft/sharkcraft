import {
  buildReviewPacketV2,
  type IBuildReviewPacketV2Options,
  type IReviewPacketV2,
} from './review-packet-v2.ts';
import { evaluatePolicy, type IPolicyReport } from './policy-engine.ts';
import { readFeatureBundle, type IFeatureBundle } from './feature-bundle.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REVIEW_PACKET_V3_SCHEMA = 'sharkcraft.review-packet-v3/v1';

export interface IBuildReviewPacketV3Options extends IBuildReviewPacketV2Options {
  bundleId?: string;
}

export interface IReviewPacketV3 {
  schema: typeof REVIEW_PACKET_V3_SCHEMA;
  v2: IReviewPacketV2;
  policy: IPolicyReport;
  bundle?: IFeatureBundle | null;
}

export async function buildReviewPacketV3(
  inspection: ISharkcraftInspection,
  options: IBuildReviewPacketV3Options = {},
): Promise<IReviewPacketV3> {
  const v2Options: IBuildReviewPacketV2Options = {};
  if (options.since !== undefined) v2Options.since = options.since;
  if (options.staged !== undefined) v2Options.staged = options.staged;
  if (options.files !== undefined) v2Options.files = options.files;
  if (options.ownershipFiles !== undefined) v2Options.ownershipFiles = options.ownershipFiles;
  if (options.qualityBaselineFile !== undefined) v2Options.qualityBaselineFile = options.qualityBaselineFile;
  const v2 = await buildReviewPacketV2(inspection, v2Options);

  const policyInput: { bundleId?: string } = {};
  if (options.bundleId) policyInput.bundleId = options.bundleId;
  const policy = await evaluatePolicy(inspection, policyInput);

  let bundle: IFeatureBundle | null = null;
  if (options.bundleId) {
    bundle = readFeatureBundle(inspection.projectRoot, options.bundleId);
  }

  const out: IReviewPacketV3 = {
    schema: REVIEW_PACKET_V3_SCHEMA,
    v2,
    policy,
  };
  if (bundle !== null) out.bundle = bundle;
  return out;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface IRenderReviewCommentV3Options {
  format?: 'markdown' | 'html';
  maxFiles?: number;
  maxItems?: number;
}

export function renderReviewCommentV3(
  packet: IReviewPacketV3,
  options: IRenderReviewCommentV3Options = {},
): string {
  if (options.format === 'html') return renderReviewCommentV3Html(packet, options);
  return renderReviewCommentV3Markdown(packet, options);
}

function renderReviewCommentV3Markdown(
  packet: IReviewPacketV3,
  options: IRenderReviewCommentV3Options,
): string {
  const maxItems = options.maxItems ?? 10;
  const maxFiles = options.maxFiles ?? 25;
  const v2 = packet.v2;
  const lines: string[] = [];
  lines.push('# SharkCraft review (v3)');
  lines.push('');
  lines.push(`**Risk score:** ${v2.riskScore}/100 — impact ${v2.impact.risk}`);
  lines.push(`${v2.base.changedFiles.length} file(s), ${v2.impact.affectedAreas.length} area(s).`);
  lines.push('');
  if (packet.bundle) {
    lines.push(`## Bundle: \`${packet.bundle.id}\``);
    lines.push(`**Task:** ${packet.bundle.task}`);
    lines.push(`**Status:** ${packet.bundle.status}`);
    lines.push(`Plans: ${packet.bundle.plans.length}; dependencies: ${packet.bundle.dependencies.length}`);
    lines.push('');
  }
  lines.push('## Ownership hints');
  if (v2.suggestedReviewers.length === 0) {
    lines.push('_No ownership rules matched._');
  } else {
    for (const r of v2.suggestedReviewers.slice(0, maxItems)) lines.push(`- ${r}`);
  }
  lines.push('');
  lines.push('## Test impact');
  lines.push(
    `- Likely tests: ${v2.testImpact.likelyTestFiles.length}`,
  );
  lines.push(`- Missing tests: ${v2.testImpact.missingTestFiles.length}`);
  if (v2.testImpact.missingTestFiles.length > 0) {
    for (const m of v2.testImpact.missingTestFiles.slice(0, maxItems)) lines.push(`  - ${m}`);
  }
  if ('minimalCommands' in v2.testImpact && v2.testImpact.minimalCommands.length > 0) {
    lines.push('Minimal commands:');
    for (const c of v2.testImpact.minimalCommands) lines.push(`- \`${c}\``);
  }
  lines.push('');
  lines.push('## Policy');
  lines.push(
    `Registered: ${packet.policy.registrations.length}; findings: ${packet.policy.checks.length}; passed=${packet.policy.summary.passed}`,
  );
  for (const c of packet.policy.checks.slice(0, maxItems)) {
    lines.push(`- [${c.severity}] \`${c.id}\` — ${c.message}`);
  }
  lines.push('');
  if (v2.qualityComparison) {
    lines.push('## Quality regression');
    lines.push(
      `Regressions: ${v2.qualityComparison.regressions.length}, improvements: ${v2.qualityComparison.improvements.length}`,
    );
    for (const r of v2.qualityComparison.regressions.slice(0, maxItems)) {
      lines.push(`- ${r.metric}: ${r.baseline} → ${r.current} (Δ${r.delta})`);
    }
    lines.push('');
  }
  lines.push('## Changed files');
  for (const f of v2.base.changedFiles.slice(0, maxFiles)) lines.push(`- ${f}`);
  lines.push('');
  lines.push(`## Suggested commands`);
  for (const c of v2.testImpact.testCommands.slice(0, maxItems)) lines.push(`- \`${c}\``);
  for (const c of v2.impact.suggestedValidationCommands.slice(0, maxItems)) lines.push(`- \`${c}\``);
  lines.push('');
  lines.push('## AI reviewer instructions');
  lines.push(v2.base.reviewerInstructions);
  return lines.join('\n') + '\n';
}

function renderReviewCommentV3Html(
  packet: IReviewPacketV3,
  options: IRenderReviewCommentV3Options,
): string {
  const v2 = packet.v2;
  const maxFiles = options.maxFiles ?? 25;
  const maxItems = options.maxItems ?? 10;
  const parts: string[] = [];
  parts.push('<!doctype html><html><head><meta charset="utf-8">');
  parts.push('<title>SharkCraft review v3</title>');
  parts.push(
    '<style>body{font:14px/1.4 -apple-system,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;color:#1f2328}',
  );
  parts.push('h1{font-size:20px;border-bottom:1px solid #d0d7de;padding-bottom:8px}h2{font-size:16px;margin-top:24px}');
  parts.push('table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}th{background:#f6f8fa}');
  parts.push('.tag{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}');
  parts.push('.tag.low{background:#dafbe1;color:#1a7f37}.tag.medium{background:#fff8c5;color:#9a6700}.tag.high{background:#ffebe9;color:#cf222e}.tag.critical{background:#cf222e;color:#fff}');
  parts.push('code,pre{background:#f6f8fa;padding:1px 4px;border-radius:4px;font-size:12px}</style></head><body>');

  parts.push('<h1>SharkCraft review (v3)</h1>');
  parts.push(`<p><strong>Risk score:</strong> ${v2.riskScore}/100 — <span class="tag ${esc(v2.impact.risk)}">${esc(v2.impact.risk)}</span></p>`);
  parts.push(`<p>${v2.base.changedFiles.length} file(s), ${v2.impact.affectedAreas.length} area(s)</p>`);

  if (packet.bundle) {
    parts.push(`<h2>Bundle</h2>`);
    parts.push(`<p><strong>${esc(packet.bundle.id)}</strong> — ${esc(packet.bundle.task)}</p>`);
    parts.push(`<p>Status: ${esc(packet.bundle.status)} · Plans: ${packet.bundle.plans.length} · Dependencies: ${packet.bundle.dependencies.length}</p>`);
  }

  parts.push('<h2>Ownership</h2>');
  if (v2.suggestedReviewers.length === 0) parts.push('<p><em>No ownership rules matched.</em></p>');
  else {
    parts.push('<ul>');
    for (const r of v2.suggestedReviewers.slice(0, maxItems)) parts.push(`<li>${esc(r)}</li>`);
    parts.push('</ul>');
  }

  parts.push('<h2>Test impact</h2>');
  parts.push(`<p>Likely tests: ${v2.testImpact.likelyTestFiles.length}; Missing tests: ${v2.testImpact.missingTestFiles.length}</p>`);
  if (v2.testImpact.missingTestFiles.length > 0) {
    parts.push('<ul>');
    for (const m of v2.testImpact.missingTestFiles.slice(0, maxItems)) parts.push(`<li>${esc(m)}</li>`);
    parts.push('</ul>');
  }
  const minimal = 'minimalCommands' in v2.testImpact ? v2.testImpact.minimalCommands : [];
  if (minimal.length > 0) {
    parts.push('<p>Minimal commands:</p><ul>');
    for (const c of minimal) parts.push(`<li><code>${esc(c)}</code></li>`);
    parts.push('</ul>');
  }

  parts.push('<h2>Policy</h2>');
  parts.push(
    `<p>Registered: ${packet.policy.registrations.length}; findings: ${packet.policy.checks.length}; passed=${packet.policy.summary.passed}</p>`,
  );
  if (packet.policy.checks.length > 0) {
    parts.push('<ul>');
    for (const c of packet.policy.checks.slice(0, maxItems)) {
      parts.push(`<li>[${esc(c.severity)}] <code>${esc(c.id)}</code> — ${esc(c.message)}</li>`);
    }
    parts.push('</ul>');
  }

  if (v2.qualityComparison) {
    parts.push('<h2>Quality regression</h2>');
    parts.push(`<p>Regressions: ${v2.qualityComparison.regressions.length}, improvements: ${v2.qualityComparison.improvements.length}</p>`);
  }

  parts.push('<h2>Changed files</h2><ul>');
  for (const f of v2.base.changedFiles.slice(0, maxFiles)) parts.push(`<li>${esc(f)}</li>`);
  parts.push('</ul>');

  parts.push('<h2>AI reviewer instructions</h2>');
  parts.push(`<pre>${esc(v2.base.reviewerInstructions)}</pre>`);

  parts.push('<p><em>Generated by SharkCraft review packet v3.</em></p>');
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}
