import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AdoptionCategory,
  AdoptionKind,
  buildOnboardingAdoptionPlan,
  type IAdoptionItem,
  type IAdoptionPlan,
} from './onboarding-adoption.ts';
import { buildOnboardingPlan, type IOnboardingPlan } from './onboarding.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const ONBOARD_ADOPTION_DIFF_SCHEMA = 'sharkcraft.onboard-adoption-diff/v1';

export type OnboardAdoptionDiffFormat = 'text' | 'markdown' | 'html' | 'json';

export enum OnboardDiffBlockKind {
  NewBlock = 'new-block',
  AlreadyExists = 'already-exists',
  Conflict = 'conflict',
  ManualReview = 'manual-review',
}

export interface IOnboardDiffLine {
  marker: '+' | '-' | ' ' | '~';
  text: string;
}

export interface IOnboardDiffBlock {
  kind: OnboardDiffBlockKind;
  /** Target file relative to the project root. */
  targetFile: string;
  /** Whether the target file exists on disk. */
  targetExists: boolean;
  /** Adoption kind (rule / path / template / boundary / verification / pipeline). */
  adoptionKind: AdoptionKind;
  title: string;
  /** Short notes for the human reviewer. */
  notes?: readonly string[];
  /** Line-level preview lines. */
  lines: readonly IOnboardDiffLine[];
}

export interface IOnboardAdoptionDiff {
  schema: typeof ONBOARD_ADOPTION_DIFF_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  blocks: readonly IOnboardDiffBlock[];
  summary: {
    newBlocks: number;
    alreadyExists: number;
    conflicts: number;
    manualReview: number;
  };
  warnings: readonly string[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function targetFor(kind: AdoptionKind): string {
  switch (kind) {
    case AdoptionKind.Rule:
      return 'sharkcraft/rules.ts';
    case AdoptionKind.Path:
      return 'sharkcraft/paths.ts';
    case AdoptionKind.Verification:
      return 'sharkcraft/sharkcraft.config.ts';
    case AdoptionKind.Template:
      return 'sharkcraft/templates.ts';
    case AdoptionKind.Boundary:
      return 'sharkcraft/boundaries.ts';
    case AdoptionKind.Pipeline:
      return 'sharkcraft/pipelines.ts';
  }
}

function renderItemPreview(item: IAdoptionItem): string[] {
  switch (item.kind) {
    case AdoptionKind.Rule:
      return [`// rule ${item.id} — ${item.title}`];
    case AdoptionKind.Path:
      return [`// path ${item.id} — ${item.title}`];
    case AdoptionKind.Verification:
      return [`{ id: '${item.id}', label: '${item.title}', command: '<edit>', trusted: true },`];
    case AdoptionKind.Template:
      return [`// template ${item.id} — ${item.title}`];
    case AdoptionKind.Boundary:
      return [`// boundary ${item.id} — ${item.title}`];
    case AdoptionKind.Pipeline:
      return [`// pipeline ${item.id} — ${item.title}`];
  }
}

function buildBlocks(
  inspection: ISharkcraftInspection,
  plan: IAdoptionPlan,
): IOnboardDiffBlock[] {
  const blocks: IOnboardDiffBlock[] = [];
  const cwd = inspection.projectRoot;
  for (const cat of Object.values(AdoptionCategory)) {
    const items = plan.byCategory[cat];
    if (items.length === 0) continue;
    for (const item of items) {
      const target = targetFor(item.kind);
      const targetExists = existsSync(nodePath.resolve(cwd, target));
      if (cat === AdoptionCategory.AlreadyCovered) {
        blocks.push({
          kind: OnboardDiffBlockKind.AlreadyExists,
          targetFile: target,
          targetExists,
          adoptionKind: item.kind,
          title: `${item.id} already covered in ${target}`,
          notes: [item.reason],
          lines: [],
        });
        continue;
      }
      if (cat === AdoptionCategory.Conflict) {
        blocks.push({
          kind: OnboardDiffBlockKind.Conflict,
          targetFile: target,
          targetExists,
          adoptionKind: item.kind,
          title: `${item.id} CONFLICT (${item.kind})`,
          notes: [item.reason],
          lines: [
            { marker: '~', text: 'manual review required — existing entry differs' },
          ],
        });
        continue;
      }
      if (cat === AdoptionCategory.ManualReview) {
        blocks.push({
          kind: OnboardDiffBlockKind.ManualReview,
          targetFile: target,
          targetExists,
          adoptionKind: item.kind,
          title: `${item.id} — manual review`,
          notes: [item.reason],
          lines: renderItemPreview(item).map((text) => ({ marker: '~', text })),
        });
        continue;
      }
      if (cat === AdoptionCategory.SafeToAdopt) {
        blocks.push({
          kind: OnboardDiffBlockKind.NewBlock,
          targetFile: target,
          targetExists,
          adoptionKind: item.kind,
          title: `Append to ${target}: ${item.id}`,
          notes: [item.reason],
          lines: renderItemPreview(item).map((text) => ({ marker: '+', text })),
        });
        continue;
      }
      // LowConfidence / Skipped → render with informational marker only.
      if (cat === AdoptionCategory.LowConfidence || cat === AdoptionCategory.Skipped) {
        blocks.push({
          kind: OnboardDiffBlockKind.ManualReview,
          targetFile: target,
          targetExists,
          adoptionKind: item.kind,
          title: `${item.id} (${cat})`,
          notes: [item.reason],
          lines: [],
        });
        continue;
      }
    }
  }
  return blocks;
}

export interface IBuildOnboardAdoptionDiffOptions {
  /** Confidence threshold mirrored from the underlying adoption build. */
  confidence?: 'high' | 'medium' | 'low';
  include?: readonly AdoptionKind[];
  exclude?: readonly AdoptionKind[];
}

export function buildOnboardAdoptionDiff(
  inspection: ISharkcraftInspection,
  options: IBuildOnboardAdoptionDiffOptions = {},
): IOnboardAdoptionDiff {
  const plan: IOnboardingPlan = buildOnboardingPlan(inspection, {});
  const adoption = buildOnboardingAdoptionPlan({
    inspection,
    plan,
    ...(options.confidence ? { confidence: options.confidence } : {}),
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });
  const blocks = buildBlocks(inspection, adoption);
  const summary = {
    newBlocks: blocks.filter((b) => b.kind === OnboardDiffBlockKind.NewBlock).length,
    alreadyExists: blocks.filter((b) => b.kind === OnboardDiffBlockKind.AlreadyExists).length,
    conflicts: blocks.filter((b) => b.kind === OnboardDiffBlockKind.Conflict).length,
    manualReview: blocks.filter((b) => b.kind === OnboardDiffBlockKind.ManualReview).length,
  };
  const warnings: string[] = [];
  for (const k of Object.values(AdoptionKind)) {
    const target = targetFor(k);
    const full = nodePath.resolve(inspection.projectRoot, target);
    if (!existsSync(full)) {
      warnings.push(`Target file ${target} does not exist — patch would create it.`);
    } else {
      // Quick sanity: load and confirm it's a TS file we recognize. Don't fail
      // hard — onboarding has its own draft loader for the actual semantics.
      try {
        readFileSync(full, 'utf8');
      } catch {
        warnings.push(`Cannot read ${target}.`);
      }
    }
  }
  return {
    schema: ONBOARD_ADOPTION_DIFF_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    blocks,
    summary,
    warnings: [...new Set(warnings)],
  };
}

export function renderOnboardAdoptionDiffText(diff: IOnboardAdoptionDiff): string {
  const lines: string[] = [];
  lines.push(`Onboard adoption diff — generated ${diff.generatedAt}`);
  lines.push(
    `Summary: +blocks=${diff.summary.newBlocks}  ~review=${diff.summary.manualReview}  conflicts=${diff.summary.conflicts}  covered=${diff.summary.alreadyExists}`,
  );
  for (const b of diff.blocks) {
    lines.push('');
    lines.push(`-- ${b.title} [${b.kind} → ${b.targetFile}${b.targetExists ? '' : ' (new)'}]`);
    for (const n of b.notes ?? []) lines.push(`   note: ${n}`);
    for (const ln of b.lines) lines.push(`${ln.marker} ${ln.text}`);
  }
  if (diff.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of diff.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n') + '\n';
}

export function renderOnboardAdoptionDiffMarkdown(diff: IOnboardAdoptionDiff): string {
  const lines: string[] = [];
  lines.push('# Onboard adoption diff');
  lines.push('');
  lines.push(`Generated: ${diff.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Append blocks: ${diff.summary.newBlocks}`);
  lines.push(`- Manual review: ${diff.summary.manualReview}`);
  lines.push(`- Conflicts: ${diff.summary.conflicts}`);
  lines.push(`- Already exists: ${diff.summary.alreadyExists}`);
  lines.push('');
  for (const b of diff.blocks) {
    lines.push(`## ${b.title} _[${b.kind}]_`);
    lines.push('');
    lines.push(`Target: \`${b.targetFile}\`${b.targetExists ? '' : ' _(new file)_'}`);
    if (b.notes && b.notes.length > 0) {
      for (const n of b.notes) lines.push(`- ${n}`);
      lines.push('');
    }
    if (b.lines.length > 0) {
      lines.push('```diff');
      for (const ln of b.lines) lines.push(`${ln.marker} ${ln.text}`);
      lines.push('```');
      lines.push('');
    }
  }
  if (diff.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of diff.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('## Next steps');
  lines.push('');
  lines.push('SharkCraft never modifies your live `sharkcraft/*.ts` files automatically.');
  lines.push('Run `shrk onboard adopt --write-patch` and review the patch before applying.');
  return lines.join('\n') + '\n';
}

export function renderOnboardAdoptionDiffHtml(diff: IOnboardAdoptionDiff): string {
  const out: string[] = [];
  out.push('<!doctype html><html><head><meta charset="utf-8"><title>Onboard adoption diff</title>');
  out.push('<style>');
  out.push('body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}');
  out.push('h1{font-size:24px;margin-bottom:8px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}');
  out.push('.diff{background:#f7f7f9;border:1px solid #d0d0d6;border-radius:6px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre;overflow-x:auto}');
  out.push('.add{color:#22863a;background:#eaffea;display:block}.del{color:#b31d28;background:#ffeef0;display:block}.ctx{color:#586069;display:block}.cnf{color:#b08800;background:#fff8d6;display:block}');
  out.push('.muted{color:#586069}.tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;background:#eef2f6}');
  out.push('@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}.diff{background:#161b22;border-color:#30363d}.add{background:#0c3a1c}.del{background:#3d1a1e}.cnf{background:#3a2f0c}.muted{color:#8b949e}.tag{background:#21262d}}');
  out.push('</style></head><body>');
  out.push('<h1>Onboard adoption diff</h1>');
  out.push(`<p class="muted">Generated ${esc(diff.generatedAt)}</p>`);
  out.push(
    `<p>Summary: +blocks=${diff.summary.newBlocks} · ~review=${diff.summary.manualReview} · conflicts=${diff.summary.conflicts} · covered=${diff.summary.alreadyExists}</p>`,
  );
  for (const b of diff.blocks) {
    out.push(`<h2>${esc(b.title)} <span class="tag">${esc(b.kind)}</span></h2>`);
    out.push(`<p class="muted">Target: <code>${esc(b.targetFile)}</code>${b.targetExists ? '' : ' <em>(new file)</em>'}</p>`);
    if (b.notes && b.notes.length > 0) {
      out.push('<ul>');
      for (const n of b.notes) out.push(`<li>${esc(n)}</li>`);
      out.push('</ul>');
    }
    if (b.lines.length > 0) {
      out.push('<div class="diff">');
      for (const ln of b.lines) {
        const cls = ln.marker === '+' ? 'add' : ln.marker === '-' ? 'del' : ln.marker === '~' ? 'cnf' : 'ctx';
        out.push(`<span class="${cls}">${esc(ln.marker + ' ' + ln.text)}</span>`);
      }
      out.push('</div>');
    }
  }
  if (diff.warnings.length > 0) {
    out.push('<h2>Warnings</h2><ul>');
    for (const w of diff.warnings) out.push(`<li>${esc(w)}</li>`);
    out.push('</ul>');
  }
  out.push('<p class="muted">SharkCraft never modifies your live <code>sharkcraft/*.ts</code> files. Run <code>shrk onboard adopt --write-patch</code> to render a patch under <code>sharkcraft/onboarding/adoption/</code>.</p>');
  out.push('</body></html>');
  return out.join('\n') + '\n';
}

export function renderOnboardAdoptionDiff(
  diff: IOnboardAdoptionDiff,
  format: OnboardAdoptionDiffFormat,
): string {
  if (format === 'markdown') return renderOnboardAdoptionDiffMarkdown(diff);
  if (format === 'html') return renderOnboardAdoptionDiffHtml(diff);
  if (format === 'json') return JSON.stringify(diff, null, 2) + '\n';
  return renderOnboardAdoptionDiffText(diff);
}
