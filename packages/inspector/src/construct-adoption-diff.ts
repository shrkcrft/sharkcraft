import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildConstructAdoptionPlan,
  ConstructAdoptionCategory,
  type IConstructAdoptionEntry,
  type IConstructAdoptionPlan,
} from './construct-adoption.ts';
import { listConstructs, type IConstruct } from './construct-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const CONSTRUCT_ADOPTION_DIFF_SCHEMA = 'sharkcraft.construct-adoption-diff/v1';

export type ConstructAdoptionDiffFormat = 'text' | 'markdown' | 'html' | 'json';

export enum ConstructDiffBlockKind {
  NewConstruct = 'new-construct',
  NewFacet = 'new-facet',
  FieldAdded = 'field-added',
  FieldConflict = 'field-conflict',
  AlreadyCovered = 'already-covered',
  Conflict = 'conflict',
}

export interface IConstructDiffLine {
  /** `'+'` add, `'-'` remove, `' '` context, `'~'` conflict marker. */
  marker: '+' | '-' | ' ' | '~';
  text: string;
}

export interface IConstructDiffBlock {
  kind: ConstructDiffBlockKind;
  /** Construct id this block belongs to. */
  constructId: string;
  /** Optional facet sub-id (when kind is NewFacet). */
  facetKind?: string;
  /** A short title for human readers. */
  title: string;
  /** Optional notes / reasons. */
  notes?: readonly string[];
  /** Line-level preview. Empty when the block is purely informational. */
  lines: readonly IConstructDiffLine[];
}

export interface IConstructAdoptionDiff {
  schema: typeof CONSTRUCT_ADOPTION_DIFF_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  constructsFile: string | null;
  /** Whether the live constructs.ts exists at the moment of generation. */
  constructsFileExists: boolean;
  /** Whole-file preview of the proposed constructs.ts (or unchanged when none). */
  proposedFilePreview: string;
  blocks: readonly IConstructDiffBlock[];
  summary: {
    newConstructs: number;
    newFacets: number;
    fieldsAdded: number;
    fieldConflicts: number;
    alreadyCovered: number;
    conflicts: number;
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

/** Render an inferred construct entry as a TypeScript object literal — only
 *  the fields we know about, never speculative ones. */
function renderConstructLiteral(entry: IConstructAdoptionEntry): string[] {
  const lines: string[] = [];
  lines.push('{');
  lines.push(`  id: '${entry.id}',`);
  lines.push(`  type: '${entry.type}',`);
  lines.push(`  title: '${entry.title.replace(/'/g, "\\'")}',`);
  const files = entry.inferred.files ?? [];
  if (files.length > 0) {
    lines.push(`  files: [${files.map((f) => "'" + f + "'").join(', ')}],`);
  }
  const publicApi = entry.inferred.publicApi ?? [];
  if (publicApi.length > 0) {
    lines.push(`  publicApi: [${publicApi.map((a) => "'" + a + "'").join(', ')}],`);
  }
  const events = entry.inferred.events ?? [];
  if (events.length > 0) {
    lines.push(`  events: [${events.map((e) => "'" + e + "'").join(', ')}],`);
  }
  const tokens = entry.inferred.tokens ?? [];
  if (tokens.length > 0) {
    lines.push(`  tokens: [${tokens.map((t) => "'" + t + "'").join(', ')}],`);
  }
  lines.push('},');
  return lines;
}

function buildBlocks(
  plan: IConstructAdoptionPlan,
  existingById: Map<string, IConstruct>,
): IConstructDiffBlock[] {
  const blocks: IConstructDiffBlock[] = [];
  for (const entry of plan.entries) {
    if (entry.category === ConstructAdoptionCategory.AlreadyCovered) {
      blocks.push({
        kind: ConstructDiffBlockKind.AlreadyCovered,
        constructId: entry.id,
        title: `${entry.id} is already covered`,
        notes: entry.reasons,
        lines: [],
      });
      continue;
    }
    if (entry.category === ConstructAdoptionCategory.Conflict) {
      const existing = existingById.get(entry.id);
      const lines: IConstructDiffLine[] = [];
      if (existing) {
        lines.push({ marker: '-', text: `existing type: ${existing.type}` });
      }
      lines.push({ marker: '+', text: `inferred type: ${entry.type}` });
      lines.push({ marker: '~', text: `id collision — manual review required` });
      blocks.push({
        kind: ConstructDiffBlockKind.Conflict,
        constructId: entry.id,
        title: `${entry.id} CONFLICT`,
        notes: entry.reasons,
        lines,
      });
      continue;
    }
    const existing = existingById.get(entry.id);
    if (!existing) {
      const literal = renderConstructLiteral(entry);
      const lines: IConstructDiffLine[] = literal.map((l) => ({ marker: '+', text: l }));
      blocks.push({
        kind: ConstructDiffBlockKind.NewConstruct,
        constructId: entry.id,
        title: `Add construct ${entry.id} (${entry.type})`,
        notes: entry.reasons,
        lines,
      });
      continue;
    }
    // Existing construct, same type → diff additive fields field-by-field.
    const existingFiles = new Set(existing.files ?? []);
    const newFiles = (entry.inferred.files ?? []).filter((f) => !existingFiles.has(f));
    if (newFiles.length > 0) {
      blocks.push({
        kind: ConstructDiffBlockKind.FieldAdded,
        constructId: entry.id,
        title: `Add files to ${entry.id}`,
        lines: newFiles.map((f) => ({ marker: '+', text: `  '${f}',` })),
      });
    }
    const existingApi = new Set(existing.publicApi ?? []);
    const newApi = (entry.inferred.publicApi ?? []).filter((a) => !existingApi.has(a));
    if (newApi.length > 0) {
      blocks.push({
        kind: ConstructDiffBlockKind.FieldAdded,
        constructId: entry.id,
        title: `Add publicApi entries to ${entry.id}`,
        lines: newApi.map((a) => ({ marker: '+', text: `  '${a}',` })),
      });
    }
    const existingEvents = new Set(existing.events ?? []);
    const newEvents = (entry.inferred.events ?? []).filter((e) => !existingEvents.has(e));
    if (newEvents.length > 0) {
      blocks.push({
        kind: ConstructDiffBlockKind.FieldAdded,
        constructId: entry.id,
        title: `Add events to ${entry.id}`,
        lines: newEvents.map((e) => ({ marker: '+', text: `  '${e}',` })),
      });
    }
    const existingTokens = new Set(existing.tokens ?? []);
    const newTokens = (entry.inferred.tokens ?? []).filter((t) => !existingTokens.has(t));
    if (newTokens.length > 0) {
      blocks.push({
        kind: ConstructDiffBlockKind.FieldAdded,
        constructId: entry.id,
        title: `Add tokens to ${entry.id}`,
        lines: newTokens.map((t) => ({ marker: '+', text: `  '${t}',` })),
      });
    }
    // Title conflict — flag if the inferred title differs from the live one.
    if (existing.title && entry.title && existing.title !== entry.title) {
      blocks.push({
        kind: ConstructDiffBlockKind.FieldConflict,
        constructId: entry.id,
        title: `${entry.id} title differs`,
        lines: [
          { marker: '-', text: `title: '${existing.title}'` },
          { marker: '+', text: `title: '${entry.title}'` },
          { marker: '~', text: 'manual review — pick one' },
        ],
      });
    }
  }
  return blocks;
}

function renderProposedFilePreview(
  existingSource: string | null,
  plan: IConstructAdoptionPlan,
): string {
  // Only render literals for entries that aren't already-covered/conflict so the
  // preview matches what `--write-patch` would suggest copying in.
  const additions = plan.entries.filter(
    (e) =>
      e.category !== ConstructAdoptionCategory.AlreadyCovered &&
      e.category !== ConstructAdoptionCategory.Conflict,
  );
  if (additions.length === 0) {
    return existingSource ?? '';
  }
  const additionBlock = additions
    .map((e) => '  ' + renderConstructLiteral(e).join('\n  '))
    .join('\n');
  if (!existingSource) {
    return [
      '// Self-contained — no @shrkcrft/* imports required.',
      'function defineConstruct<T>(construct: T): T { return construct; }',
      '',
      'export default [',
      additionBlock,
      '];',
      '',
    ].join('\n');
  }
  // Naive: append before the trailing `];` or just at the end.
  const trimmed = existingSource.replace(/\n+$/, '');
  return [trimmed, '// Added by `shrk constructs adopt --write-patch`:', additionBlock, ''].join('\n');
}

export async function buildConstructAdoptionDiff(
  inspection: ISharkcraftInspection,
): Promise<IConstructAdoptionDiff> {
  const plan = await buildConstructAdoptionPlan(inspection);
  const existing = listConstructs(inspection);
  const existingById = new Map<string, IConstruct>();
  for (const c of existing) existingById.set(c.id, c);

  const constructsFile = inspection.sharkcraftDir
    ? nodePath.join(inspection.sharkcraftDir, 'constructs.ts')
    : null;
  const exists = !!constructsFile && existsSync(constructsFile);
  let existingSource: string | null = null;
  if (exists && constructsFile) {
    try {
      existingSource = readFileSync(constructsFile, 'utf8');
    } catch {
      existingSource = null;
    }
  }

  const blocks = buildBlocks(plan, existingById);
  const summary = {
    newConstructs: blocks.filter((b) => b.kind === ConstructDiffBlockKind.NewConstruct).length,
    newFacets: blocks.filter((b) => b.kind === ConstructDiffBlockKind.NewFacet).length,
    fieldsAdded: blocks.filter((b) => b.kind === ConstructDiffBlockKind.FieldAdded).length,
    fieldConflicts: blocks.filter((b) => b.kind === ConstructDiffBlockKind.FieldConflict).length,
    alreadyCovered: blocks.filter((b) => b.kind === ConstructDiffBlockKind.AlreadyCovered).length,
    conflicts: blocks.filter((b) => b.kind === ConstructDiffBlockKind.Conflict).length,
  };
  const warnings = [...plan.warnings];
  if (!exists && constructsFile) {
    warnings.push(`No live constructs.ts yet at ${constructsFile} — diff shows a clean creation.`);
  }
  return {
    schema: CONSTRUCT_ADOPTION_DIFF_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    constructsFile,
    constructsFileExists: exists,
    proposedFilePreview: renderProposedFilePreview(existingSource, plan),
    blocks,
    summary,
    warnings,
  };
}

export function renderConstructAdoptionDiffText(diff: IConstructAdoptionDiff): string {
  const lines: string[] = [];
  lines.push(`Construct adoption diff — generated ${diff.generatedAt}`);
  lines.push(`Live constructs.ts: ${diff.constructsFile ?? '(no sharkcraft dir)'}`);
  lines.push(
    `Summary: +constructs=${diff.summary.newConstructs}  +fields=${diff.summary.fieldsAdded}  ~conflicts=${diff.summary.conflicts}  covered=${diff.summary.alreadyCovered}`,
  );
  for (const b of diff.blocks) {
    lines.push('');
    lines.push(`-- ${b.title} [${b.kind}]`);
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

export function renderConstructAdoptionDiffMarkdown(diff: IConstructAdoptionDiff): string {
  const lines: string[] = [];
  lines.push('# Construct adoption diff');
  lines.push('');
  lines.push(`Generated: ${diff.generatedAt}`);
  lines.push(`Live constructs.ts: \`${diff.constructsFile ?? '(none)'}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- New constructs: ${diff.summary.newConstructs}`);
  lines.push(`- Fields added to existing: ${diff.summary.fieldsAdded}`);
  lines.push(`- Conflicts: ${diff.summary.conflicts}`);
  lines.push(`- Already covered: ${diff.summary.alreadyCovered}`);
  lines.push('');
  for (const b of diff.blocks) {
    lines.push(`## ${b.title} _[${b.kind}]_`);
    lines.push('');
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
  lines.push('SharkCraft never modifies `constructs.ts` automatically.');
  lines.push('Copy entries from the proposed file preview into your `sharkcraft/constructs.ts`.');
  return lines.join('\n') + '\n';
}

export function renderConstructAdoptionDiffHtml(diff: IConstructAdoptionDiff): string {
  const out: string[] = [];
  out.push('<!doctype html><html><head><meta charset="utf-8"><title>Construct adoption diff</title>');
  out.push('<style>');
  out.push('body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}');
  out.push('h1{font-size:24px;margin-bottom:8px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}');
  out.push('.diff{background:#f7f7f9;border:1px solid #d0d0d6;border-radius:6px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre;overflow-x:auto}');
  out.push('.add{color:#22863a;background:#eaffea;display:block}.del{color:#b31d28;background:#ffeef0;display:block}.ctx{color:#586069;display:block}.cnf{color:#b08800;background:#fff8d6;display:block}');
  out.push('.muted{color:#586069}.tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;background:#eef2f6}');
  out.push('@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}.diff{background:#161b22;border-color:#30363d}.add{background:#0c3a1c}.del{background:#3d1a1e}.cnf{background:#3a2f0c}.muted{color:#8b949e}.tag{background:#21262d}}');
  out.push('</style></head><body>');
  out.push('<h1>Construct adoption diff</h1>');
  out.push(`<p class="muted">Generated ${esc(diff.generatedAt)} — Live <code>${esc(diff.constructsFile ?? '(none)')}</code></p>`);
  out.push(
    `<p>Summary: +constructs=${diff.summary.newConstructs} · +fields=${diff.summary.fieldsAdded} · ~conflicts=${diff.summary.conflicts} · covered=${diff.summary.alreadyCovered}</p>`,
  );
  for (const b of diff.blocks) {
    out.push(`<h2>${esc(b.title)} <span class="tag">${esc(b.kind)}</span></h2>`);
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
  out.push('<p class="muted">SharkCraft never modifies <code>constructs.ts</code> automatically. Copy the highlighted entries into your config when you are ready.</p>');
  out.push('</body></html>');
  return out.join('\n') + '\n';
}

export function renderConstructAdoptionDiff(
  diff: IConstructAdoptionDiff,
  format: ConstructAdoptionDiffFormat,
): string {
  if (format === 'markdown') return renderConstructAdoptionDiffMarkdown(diff);
  if (format === 'html') return renderConstructAdoptionDiffHtml(diff);
  if (format === 'json') return JSON.stringify(diff, null, 2) + '\n';
  return renderConstructAdoptionDiffText(diff);
}
