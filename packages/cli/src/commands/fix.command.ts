/**
 * `shrk fix` (preview-only fix system).
 *
 * Surfaces structured fix suggestions for the most common high-friction
 * findings (action hints / stale knowledge / template drift). Default is
 * preview-only — nothing is written.
 *
 * `--write-preview` writes preview files under `.sharkcraft/fixes/` ONLY
 * (no source mutation). Stubbed action-hint bodies are clearly marked
 * `needs-human-fill`; doctor continues to warn until they are filled.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  buildFixPreview,
  FixKind,
  inspectSharkcraft,
  listFixKinds,
  recordProvenance,
  renderFixPreviewMarkdown,
} from '@shrkcrft/inspector';
import type { IKnowledgeReference } from '@shrkcrft/knowledge';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import {
  applyActionHintStub,
  type IActionHintStubResult,
} from '../asset-preview/apply-action-hint-stub.ts';
import { applyKnowledgeStaleFix } from '../asset-preview/apply-knowledge-stale-fix.ts';
import { applyTemplateDriftFix } from '../asset-preview/apply-template-drift-fix.ts';
import { applyMissingBarrelFix } from '../asset-preview/apply-missing-barrel.ts';
import { detectAuthoringSource } from '../authoring/authoring-kit.ts';

function parseKinds(args: ParsedArgs): FixKind[] | undefined {
  const kinds: FixKind[] = [];
  if (flagBool(args, 'all')) {
    return Object.values(FixKind);
  }
  if (flagBool(args, 'action-hints')) kinds.push(FixKind.ActionHints);
  if (flagBool(args, 'knowledge-stale')) kinds.push(FixKind.KnowledgeStale);
  if (flagBool(args, 'template-drift')) kinds.push(FixKind.TemplateDrift);
  if (flagBool(args, 'boundary')) kinds.push(FixKind.Boundary);
  if (flagBool(args, 'convention')) kinds.push(FixKind.Convention);
  if (flagBool(args, 'self-config')) kinds.push(FixKind.SelfConfig);
  if (flagBool(args, 'pack-conflicts')) kinds.push(FixKind.PackConflict);
  if (flagBool(args, 'stale-pack-signature')) kinds.push(FixKind.StalePackSignature);
  if (flagBool(args, 'missing-command-hint')) kinds.push(FixKind.MissingCommandHint);
  if (flagBool(args, 'missing-convention-reference')) kinds.push(FixKind.MissingConventionReference);
  if (flagBool(args, 'missing-template-reference')) kinds.push(FixKind.MissingTemplateReference);
  if (flagBool(args, 'broken-playbook-reference')) kinds.push(FixKind.BrokenPlaybookReference);
  if (flagBool(args, 'broken-agent-test-reference')) kinds.push(FixKind.BrokenAgentTestReference);
  if (flagBool(args, 'broken-routing-hint-reference')) kinds.push(FixKind.BrokenRoutingHintReference);
  if (flagBool(args, 'broken-helper-reference')) kinds.push(FixKind.BrokenHelperReference);
  const list = flagList(args, 'kinds');
  for (const k of list) {
    const matched = Object.values(FixKind).find((v) => v === k);
    if (matched) kinds.push(matched);
  }
  return kinds.length > 0 ? Array.from(new Set(kinds)) : undefined;
}

async function runFixPreview(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const kinds = parseKinds(args);
  // Use the async extended builder so the new kinds resolve.
  const { buildFixPreviewExtended } = await import('@shrkcrft/inspector');
  const report = await buildFixPreviewExtended(inspection, kinds ? { kinds } : {});
  const targetFilter = flagString(args, 'target');
  let visibleReport = report;
  if (targetFilter) {
    const filtered = report.suggestions.filter((s) => s.targetId === targetFilter);
    visibleReport = { ...report, suggestions: filtered };
  }
  // --apply is supported for --action-hints, --knowledge-stale, and --template-drift.
  const wantApply = flagBool(args, 'apply');
  if (wantApply) {
    if (flagBool(args, 'action-hints')) {
      return runActionHintApply(cwd, inspection, visibleReport, args);
    }
    if (flagBool(args, 'knowledge-stale')) {
      return runKnowledgeStaleApply(cwd, inspection, visibleReport, args);
    }
    if (flagBool(args, 'template-drift')) {
      return runTemplateDriftApply(cwd, inspection, visibleReport, args);
    }
    process.stderr.write(
      'Refused: --apply is currently supported for --action-hints, --knowledge-stale, and --template-drift only.\n' +
        'Run preview-only for other kinds (`shrk fix --<kind> --write-preview`).\n',
    );
    return 2;
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(visibleReport) + '\n');
  } else {
    process.stdout.write(renderFixPreviewMarkdown(visibleReport));
  }
  if (flagBool(args, 'write-preview')) {
    const dir = nodePath.join(cwd, '.sharkcraft/fixes');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const aggregatePath = nodePath.join(dir, 'fix-preview.md');
    writeFileSync(aggregatePath, renderFixPreviewMarkdown(visibleReport), 'utf8');
    process.stdout.write(`\nWrote ${aggregatePath}\n`);
    for (const s of visibleReport.suggestions) {
      if (!s.previewFileName) continue;
      const file = nodePath.join(dir, s.previewFileName);
      const body = renderFixPreviewMarkdown({ ...visibleReport, suggestions: [s] });
      writeFileSync(file, body, 'utf8');
    }
    process.stdout.write(
      `Wrote ${visibleReport.suggestions.length} per-suggestion previews under ${dir}/\n`,
    );
  }
  return visibleReport.suggestions.length > 0 ? 1 : 0;
}

/**
 * Apply action-hint stubs in place. Preview-first under the hood:
 * we compute every patch via `applyActionHintStub` first, refuse on any
 * divergence (existing actionHints field) unless `--allow-divergent`, and
 * only then write. Provenance is recorded per applied stub.
 */
async function runActionHintApply(
  cwd: string,
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  report: { suggestions: ReadonlyArray<{ kind: FixKind; targetId: string }> },
  args: ParsedArgs,
): Promise<number> {
  const allowDivergent = flagBool(args, 'allow-divergent');
  const wantJson = flagBool(args, 'json');
  const actionHintSuggestions = report.suggestions.filter((s) => s.kind === FixKind.ActionHints);
  if (actionHintSuggestions.length === 0) {
    if (wantJson) {
      process.stdout.write(asJson({ applied: [], refused: [], message: 'no action-hint suggestions' }) + '\n');
    } else {
      process.stdout.write('No action-hint findings — nothing to apply.\n');
    }
    return 0;
  }
  // Resolve each suggestion to its owning source file via the inspection.
  const entryById = new Map(inspection.knowledgeEntries.map((e) => [e.id, e]));
  interface IPlannedFix {
    targetId: string;
    sourceFile: string;
    result: IActionHintStubResult;
  }
  const planned: IPlannedFix[] = [];
  const refused: { targetId: string; reason: string }[] = [];
  for (const s of actionHintSuggestions) {
    const entry = entryById.get(s.targetId);
    if (!entry) {
      refused.push({ targetId: s.targetId, reason: 'entry not found in inspection' });
      continue;
    }
    const origin = entry.source?.origin;
    if (!origin) {
      refused.push({ targetId: s.targetId, reason: 'entry has no source origin (likely pack-contributed)' });
      continue;
    }
    // Refuse pack-contributed sources by default. node_modules/ is the
    // canonical marker; we also refuse `dist/` files under packs.
    const relFromCwd = nodePath.relative(cwd, origin);
    const isPackSource =
      relFromCwd.startsWith('node_modules' + nodePath.sep) ||
      /\bdist\b/.test(relFromCwd);
    if (isPackSource) {
      refused.push({
        targetId: s.targetId,
        reason: `entry is pack-contributed (${relFromCwd}) — edit the pack source and re-sign instead`,
      });
      continue;
    }
    const stub = applyActionHintStub({
      cwd,
      targetPath: relFromCwd,
      entryId: s.targetId,
      write: false, // preview-first
      allowDivergent,
    });
    if (!stub.ok) {
      refused.push({ targetId: s.targetId, reason: stub.refusal ?? 'unknown' });
      continue;
    }
    planned.push({ targetId: s.targetId, sourceFile: relFromCwd, result: stub });
  }
  // If anything was refused and --allow-divergent isn't on, surface and exit
  // non-zero before touching disk.
  if (refused.length > 0 && !allowDivergent) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          mode: 'refused',
          planned: planned.map((p) => ({ targetId: p.targetId, sourceFile: p.sourceFile })),
          refused,
        }) + '\n',
      );
    } else {
      process.stdout.write(header('Fix --action-hints --apply (refused)'));
      process.stdout.write(`  planned:  ${planned.length}\n`);
      process.stdout.write(`  refused:  ${refused.length}\n\n`);
      for (const r of refused) {
        process.stdout.write(`  • ${r.targetId}: ${r.reason}\n`);
      }
      process.stdout.write(
        '\nNo files written. Pass --allow-divergent to apply the planned subset anyway.\n',
      );
    }
    return 1;
  }
  // Group planned fixes by source file so we apply per-file in one pass.
  // The splicer is idempotent and pure-function — we re-run it with
  // `write: true` and let the writer persist each fix one at a time.
  const applied: { targetId: string; sourceFile: string; insertedAtLine?: number }[] = [];
  for (const p of planned) {
    const stub = applyActionHintStub({
      cwd,
      targetPath: p.sourceFile,
      entryId: p.targetId,
      write: true,
      allowDivergent,
    });
    if (!stub.ok) {
      refused.push({ targetId: p.targetId, reason: stub.refusal ?? 'second-pass failed' });
      continue;
    }
    applied.push({
      targetId: p.targetId,
      sourceFile: p.sourceFile,
      ...(stub.insertedAtLine !== undefined ? { insertedAtLine: stub.insertedAtLine } : {}),
    });
    // Record provenance for each applied stub.
    try {
      const src = detectAuthoringSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Update,
          assetKind: AssetKind.Knowledge,
          assetId: p.targetId,
          targetFile: p.sourceFile,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          reason: 'fix --action-hints --apply',
          extra: { fixKind: FixKind.ActionHints, stubbed: true },
        },
      });
    } catch {
      // best-effort
    }
  }
  if (wantJson) {
    process.stdout.write(asJson({ mode: 'applied', applied, refused }) + '\n');
    return refused.length > 0 ? 1 : 0;
  }
  process.stdout.write(header('Fix --action-hints --apply'));
  process.stdout.write(`  applied:  ${applied.length}\n`);
  process.stdout.write(`  refused:  ${refused.length}\n\n`);
  for (const a of applied) {
    process.stdout.write(`  • ${a.targetId} → ${a.sourceFile}${a.insertedAtLine ? `:${a.insertedAtLine}` : ''}\n`);
  }
  if (refused.length > 0) {
    process.stdout.write('\nRefused:\n');
    for (const r of refused) process.stdout.write(`  • ${r.targetId}: ${r.reason}\n`);
  }
  process.stdout.write(
    '\nStubs use TODO placeholders. Doctor will continue to warn (action-hint-quality) until they are filled.\n',
  );
  process.stdout.write('Re-run `shrk doctor` to confirm the missing-action-hints warnings dropped.\n');
  return refused.length > 0 ? 1 : 0;
}

export const fixCommand: ICommandHandler = {
  name: 'fix',
  description:
    'Fix preview system. Preview-only by default. `--write-preview` writes drafts to .sharkcraft/fixes/. `--action-hints --apply` splices stubbed actionHints. `--knowledge-stale --apply [--drop-stale] [--drop-missing]` removes the offending reference in place. `--rename-strategy=wide` surfaces multi-candidate rename suggestions that strict mode silently drops.',
  usage:
    'shrk fix [list|doctor|preview] [--action-hints|--knowledge-stale|--template-drift] [--kinds <a,b>] [--target <id>] [--write-preview] [--apply [--allow-divergent] [--drop-stale] [--drop-missing] [--rename-strategy strict|wide]] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'list') {
      return runFixList(args);
    }
    if (sub === 'doctor') {
      return runFixDoctor(args);
    }
    if (sub === 'preview') {
      const sliced: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return runFixPreview(sliced);
    }
    if (sub === undefined && (flagBool(args, 'action-hints') || flagBool(args, 'knowledge-stale') || flagBool(args, 'template-drift') || flagBool(args, 'list') || flagBool(args, 'doctor'))) {
      // Allow `shrk fix --action-hints` shorthand.
      return runFixPreview(args);
    }
    return runFixPreview(args);
  },
};

/**
 * Apply knowledge-stale fixes in place.
 *
 * Resolves each `FixKind.KnowledgeStale` suggestion to a target file
 * (the entry's source origin) and removes the offending reference from
 * the entry's `references[]` array.
 *
 * Modes (opt-in flags):
 *   --drop-stale   — apply to `outcome=stale` references
 *   --drop-missing — apply to `outcome=missing` references
 *
 * Without either flag, the apply refuses (preview-only contract).
 * Pack sources are refused by default (same as the action-hint apply).
 */
async function runKnowledgeStaleApply(
  cwd: string,
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  _report: { suggestions: ReadonlyArray<{ kind: FixKind; targetId: string }> },
  args: ParsedArgs,
): Promise<number> {
  const wantJson = flagBool(args, 'json');
  const dropStale = flagBool(args, 'drop-stale');
  const dropMissing = flagBool(args, 'drop-missing');
  // `--rename-strategy=wide` extends rename detection beyond the
  // strict unique-candidate case. Default stays `strict`.
  const renameStrategyFlag = flagString(args, 'rename-strategy');
  const useWide = renameStrategyFlag === 'wide';
  if (renameStrategyFlag && renameStrategyFlag !== 'strict' && renameStrategyFlag !== 'wide') {
    process.stderr.write(
      `Unknown --rename-strategy "${renameStrategyFlag}". Use strict | wide.\n`,
    );
    return 2;
  }
  // Rebuild the stale report directly so we have full IKnowledgeReferenceCheck
  // shape (the FixKind suggestions are stringy and lose the kind/path/symbol/id).
  const { buildKnowledgeStaleReport, ReferenceCheckOutcome, RenameStrategy } = await import('@shrkcrft/inspector');
  const stale = buildKnowledgeStaleReport(inspection, {
    renameStrategy: useWide ? RenameStrategy.Wide : RenameStrategy.Strict,
  });
  // A rename payload is always actionable; --drop-stale / --drop-missing
  // are only required when the engine has no structured replacement.
  const hasAnyRename = stale.referenceChecks.some(
    (c) =>
      (c.outcome === ReferenceCheckOutcome.Stale || c.outcome === ReferenceCheckOutcome.Missing) &&
      c.replaceWith !== undefined,
  );
  if (!dropStale && !dropMissing && !hasAnyRename) {
    process.stderr.write(
      'Refused: no rename signals in stale-check and no --drop-stale / --drop-missing flag.\n' +
        'Pass one of:\n' +
        '  --drop-stale     drop references with outcome=stale\n' +
        '  --drop-missing   drop references with outcome=missing\n' +
        'Renames are applied automatically when the engine identifies the new location.\n',
    );
    return 2;
  }
  const entryById = new Map(inspection.knowledgeEntries.map((e) => [e.id, e]));
  interface IPlannedFix {
    targetId: string;
    sourceFile: string;
    outcome: 'stale' | 'missing';
    reference: IKnowledgeReference;
    /** When present, this is a rename; otherwise drop. */
    renameTo?: { path?: string; id?: string; symbol?: string };
  }
  const planned: IPlannedFix[] = [];
  const refused: { targetId: string; reason: string }[] = [];
  for (const c of stale.referenceChecks) {
    if (c.outcome !== ReferenceCheckOutcome.Stale && c.outcome !== ReferenceCheckOutcome.Missing) {
      continue;
    }
    // A rename signal is only actionable when `replaceWith.path`
    // (or .id/.symbol) is populated. Wide mode can emit `candidates[]`
    // without a chosen target — those are ambiguous and surfaced for the
    // user, not auto-applied.
    const hasAutoRenameTarget =
      c.replaceWith !== undefined &&
      (c.replaceWith.path !== undefined ||
        c.replaceWith.id !== undefined ||
        c.replaceWith.symbol !== undefined);
    const hasAmbiguousCandidates =
      c.replaceWith !== undefined &&
      !hasAutoRenameTarget &&
      (c.replaceWith.candidates?.length ?? 0) > 0;
    if (hasAmbiguousCandidates) {
      refused.push({
        targetId: c.entryId,
        reason: `ambiguous rename (${c.replaceWith!.candidates!.length} candidates); pass --rename-strategy=strict + manual edit, or rerun with --drop-stale/--drop-missing.`,
      });
      continue;
    }
    if (!hasAutoRenameTarget) {
      if (c.outcome === ReferenceCheckOutcome.Stale && !dropStale) continue;
      if (c.outcome === ReferenceCheckOutcome.Missing && !dropMissing) continue;
    }
    const entry = entryById.get(c.entryId);
    if (!entry) {
      refused.push({ targetId: c.entryId, reason: 'entry not found in inspection' });
      continue;
    }
    const origin = entry.source?.origin;
    if (!origin) {
      refused.push({
        targetId: c.entryId,
        reason: 'entry has no source origin (likely pack-contributed)',
      });
      continue;
    }
    const relFromCwd = nodePath.relative(cwd, origin);
    const isPackSource =
      relFromCwd.startsWith('node_modules' + nodePath.sep) || /\bdist\b/.test(relFromCwd);
    if (isPackSource) {
      refused.push({
        targetId: c.entryId,
        reason: `entry is pack-contributed (${relFromCwd}) — edit the pack source and re-sign instead`,
      });
      continue;
    }
    planned.push({
      targetId: c.entryId,
      sourceFile: relFromCwd,
      outcome: c.outcome === ReferenceCheckOutcome.Stale ? 'stale' : 'missing',
      reference: c.reference,
      ...(c.replaceWith
        ? {
            renameTo: {
              ...(c.replaceWith.path !== undefined ? { path: c.replaceWith.path } : {}),
              ...(c.replaceWith.id !== undefined ? { id: c.replaceWith.id } : {}),
              ...(c.replaceWith.symbol !== undefined ? { symbol: c.replaceWith.symbol } : {}),
            },
          }
        : {}),
    });
  }
  // Preview-first: run with write=false for every planned fix (rename or drop).
  for (const p of planned) {
    const dry = applyKnowledgeStaleFix({
      cwd,
      targetPath: p.sourceFile,
      entryId: p.targetId,
      reference: p.reference,
      write: false,
      ...(p.renameTo ? { renameTo: p.renameTo } : {}),
    });
    if (!dry.ok) {
      refused.push({ targetId: p.targetId, reason: dry.refusal ?? 'preview failed' });
    }
  }
  const allowDivergent = flagBool(args, 'allow-divergent');
  if (refused.length > 0 && !allowDivergent) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          mode: 'refused',
          planned: planned.map((p) => ({ targetId: p.targetId, sourceFile: p.sourceFile, outcome: p.outcome })),
          refused,
        }) + '\n',
      );
    } else {
      process.stdout.write(header('Fix --knowledge-stale --apply (refused)'));
      process.stdout.write(`  planned:  ${planned.length}\n`);
      process.stdout.write(`  refused:  ${refused.length}\n\n`);
      for (const r of refused) process.stdout.write(`  • ${r.targetId}: ${r.reason}\n`);
      process.stdout.write(
        '\nNo files written. Pass --allow-divergent to apply the planned subset anyway.\n',
      );
    }
    return 1;
  }
  // Second pass: write. Re-build the planned list to only the entries
  // that survived preview (when --allow-divergent, refused entries are
  // dropped here).
  const survivors = planned.filter(
    (p) => !refused.some((r) => r.targetId === p.targetId),
  );
  const applied: {
    targetId: string;
    sourceFile: string;
    outcome: 'stale' | 'missing';
    mode: 'rename' | 'drop';
    removed: number;
    renamedTo?: { path?: string; id?: string; symbol?: string };
  }[] = [];
  for (const p of survivors) {
    const result = applyKnowledgeStaleFix({
      cwd,
      targetPath: p.sourceFile,
      entryId: p.targetId,
      reference: p.reference,
      write: true,
      ...(p.renameTo ? { renameTo: p.renameTo } : {}),
    });
    if (!result.ok) {
      refused.push({ targetId: p.targetId, reason: result.refusal ?? 'second-pass failed' });
      continue;
    }
    applied.push({
      targetId: p.targetId,
      sourceFile: p.sourceFile,
      outcome: p.outcome,
      mode: result.mode,
      removed: result.removedCount,
      ...(p.renameTo ? { renamedTo: p.renameTo } : {}),
    });
    try {
      const src = detectAuthoringSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Update,
          assetKind: AssetKind.Knowledge,
          assetId: p.targetId,
          targetFile: p.sourceFile,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          reason: `fix --knowledge-stale --apply (${result.mode}-${p.outcome})`,
          extra: {
            fixKind: FixKind.KnowledgeStale,
            applied: result.mode,
            outcome: p.outcome,
            ...(p.renameTo ? { renamedTo: p.renameTo } : {}),
          },
        },
      });
    } catch {
      // best-effort
    }
  }
  if (wantJson) {
    process.stdout.write(asJson({ mode: 'applied', applied, refused }) + '\n');
    return refused.length > 0 ? 1 : 0;
  }
  process.stdout.write(header('Fix --knowledge-stale --apply'));
  const renameCount = applied.filter((a) => a.mode === 'rename').length;
  const dropCount = applied.filter((a) => a.mode === 'drop').length;
  process.stdout.write(`  applied:  ${applied.length} (${renameCount} renamed, ${dropCount} dropped)\n`);
  process.stdout.write(`  refused:  ${refused.length}\n\n`);
  for (const a of applied) {
    if (a.mode === 'rename') {
      const to = a.renamedTo ?? {};
      const target = to.path ?? to.id ?? to.symbol ?? '?';
      process.stdout.write(`  • ${a.targetId} → ${a.sourceFile} (rename → ${target})\n`);
    } else {
      process.stdout.write(`  • ${a.targetId} → ${a.sourceFile} (drop ${a.outcome}, removed=${a.removed})\n`);
    }
  }
  if (refused.length > 0) {
    process.stdout.write('\nRefused:\n');
    for (const r of refused) process.stdout.write(`  • ${r.targetId}: ${r.reason}\n`);
  }
  process.stdout.write(
    '\nRe-run `shrk doctor` / `shrk knowledge stale-check --ci` to confirm the stale count dropped.\n',
  );
  return refused.length > 0 ? 1 : 0;
}

/**
 * Apply template-drift fixes in place.
 *
 * Scope: only `related-id-unresolved`. Other codes are template-body
 * issues and stay preview-only.
 */
async function runTemplateDriftApply(
  cwd: string,
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  _report: { suggestions: ReadonlyArray<{ kind: FixKind; targetId: string }> },
  args: ParsedArgs,
): Promise<number> {
  const wantJson = flagBool(args, 'json');
  const { buildTemplateDriftReport } = await import('@shrkcrft/inspector');
  const drift = buildTemplateDriftReport(inspection, {});
  // Pull related-id-unresolved findings and pair each with its source.
  const templateSources = inspection.templateSources;
  // Local templates are loaded from cfg.templateFiles — resolve them
  // against the sharkcraft dir.
  const cfg = inspection.config;
  const sharkDir = (inspection as { sharkcraftDir?: string | null }).sharkcraftDir ?? null;
  const localTemplateFiles: string[] = [];
  if (cfg && sharkDir) {
    for (const f of (cfg.templateFiles ?? []) as readonly string[]) {
      localTemplateFiles.push(nodePath.join(sharkDir, f));
    }
  }
  interface IPlannedDrop {
    templateId: string;
    sourceFile: string;
    droppedRelatedId: string;
  }
  interface IPlannedBarrel {
    templateId: string;
    barrelPath: string;
  }
  const planned: IPlannedDrop[] = [];
  const plannedBarrels: IPlannedBarrel[] = [];
  const refused: { templateId: string; reason: string }[] = [];
  for (const e of drift.entries) {
    for (const issue of e.issues) {
      if (issue.code === 'related-id-unresolved') {
        const src = templateSources.get(e.templateId);
        if (!src || src.type === 'pack') {
          refused.push({
            templateId: e.templateId,
            reason: 'template is pack-contributed — edit the pack source and re-sign instead',
          });
          continue;
        }
        const m = /related id\s+["']([^"']+)["']/i.exec(issue.message);
        if (!m) {
          refused.push({
            templateId: e.templateId,
            reason: `cannot parse unresolved related id from message: ${issue.message}`,
          });
          continue;
        }
        const droppedRelatedId = m[1]!;
        let sourceFile: string | null = null;
        for (const candidate of localTemplateFiles) {
          try {
            const body = (await import('node:fs')).readFileSync(candidate, 'utf8');
            if (new RegExp(`id\\s*:\\s*['"]${e.templateId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(body)) {
              sourceFile = candidate;
              break;
            }
          } catch {
            continue;
          }
        }
        if (!sourceFile) {
          refused.push({
            templateId: e.templateId,
            reason: `could not locate local source file for template ${e.templateId}`,
          });
          continue;
        }
        planned.push({
          templateId: e.templateId,
          sourceFile: nodePath.relative(cwd, sourceFile),
          droppedRelatedId,
        });
        continue;
      }
      // Missing-barrel: parse the offending barrel path from the
      // message ("export op references missing barrel <path>.") and
      // plan an auto-create.
      if (issue.code === 'missing-barrel') {
        // The message is e.g. `export op references missing barrel "libs/.../index.ts".`
        const m = /missing barrel\s+["']([^"']+)["']/i.exec(issue.message);
        if (!m) {
          refused.push({
            templateId: e.templateId,
            reason: `cannot parse missing barrel path from message: ${issue.message}`,
          });
          continue;
        }
        const barrelPath = m[1]!;
        plannedBarrels.push({ templateId: e.templateId, barrelPath });
      }
    }
  }
  if (planned.length === 0 && plannedBarrels.length === 0 && refused.length === 0) {
    if (wantJson) {
      process.stdout.write(asJson({ mode: 'applied', applied: [], appliedBarrels: [], refused: [], note: 'no applicable template-drift fixes' }) + '\n');
    } else {
      process.stdout.write('No applicable template-drift fixes (supports related-id-unresolved + missing-barrel).\n');
    }
    return 0;
  }
  // Preview-first.
  for (const p of planned) {
    const dry = applyTemplateDriftFix({
      cwd,
      targetPath: p.sourceFile,
      templateId: p.templateId,
      droppedRelatedId: p.droppedRelatedId,
      write: false,
    });
    if (!dry.ok) refused.push({ templateId: p.templateId, reason: dry.refusal ?? 'preview failed' });
  }
  for (const b of plannedBarrels) {
    const dry = applyMissingBarrelFix({ cwd, barrelPath: b.barrelPath, write: false });
    if (!dry.ok) {
      refused.push({ templateId: b.templateId, reason: dry.refusal ?? 'barrel preview failed' });
    }
  }
  const allowDivergent = flagBool(args, 'allow-divergent');
  if (refused.length > 0 && !allowDivergent) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          mode: 'refused',
          planned: planned.map((p) => ({ templateId: p.templateId, sourceFile: p.sourceFile, droppedRelatedId: p.droppedRelatedId })),
          plannedBarrels,
          refused,
        }) + '\n',
      );
    } else {
      process.stdout.write(header('Fix --template-drift --apply (refused)'));
      process.stdout.write(`  planned:  ${planned.length} drops, ${plannedBarrels.length} barrels\n`);
      process.stdout.write(`  refused:  ${refused.length}\n\n`);
      for (const r of refused) process.stdout.write(`  • ${r.templateId}: ${r.reason}\n`);
      process.stdout.write(
        '\nNo files written. Pass --allow-divergent to apply the planned subset anyway.\n',
      );
    }
    return 1;
  }
  const survivors = planned.filter((p) => !refused.some((r) => r.templateId === p.templateId));
  const surviveBarrels = plannedBarrels.filter(
    (b) => !refused.some((r) => r.templateId === b.templateId),
  );
  const applied: { templateId: string; sourceFile: string; droppedRelatedId: string; removed: number }[] = [];
  const appliedBarrels: { templateId: string; barrelPath: string }[] = [];
  for (const p of survivors) {
    const result = applyTemplateDriftFix({
      cwd,
      targetPath: p.sourceFile,
      templateId: p.templateId,
      droppedRelatedId: p.droppedRelatedId,
      write: true,
    });
    if (!result.ok) {
      refused.push({ templateId: p.templateId, reason: result.refusal ?? 'second-pass failed' });
      continue;
    }
    applied.push({
      templateId: p.templateId,
      sourceFile: p.sourceFile,
      droppedRelatedId: p.droppedRelatedId,
      removed: result.removedCount,
    });
    try {
      const src = detectAuthoringSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Update,
          assetKind: AssetKind.Template,
          assetId: p.templateId,
          targetFile: p.sourceFile,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          reason: `fix --template-drift --apply (drop-related ${p.droppedRelatedId})`,
          extra: { fixKind: FixKind.TemplateDrift, code: 'related-id-unresolved', dropped: p.droppedRelatedId },
        },
      });
    } catch {
      // best-effort
    }
  }
  for (const b of surviveBarrels) {
    const result = applyMissingBarrelFix({ cwd, barrelPath: b.barrelPath, write: true });
    if (!result.ok) {
      refused.push({ templateId: b.templateId, reason: result.refusal ?? 'barrel write failed' });
      continue;
    }
    appliedBarrels.push({ templateId: b.templateId, barrelPath: b.barrelPath });
    try {
      const src = detectAuthoringSource();
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Update,
          assetKind: AssetKind.Template,
          assetId: b.templateId,
          targetFile: b.barrelPath,
          source: src.source,
          ...(src.author ? { author: src.author } : {}),
          ...(src.sessionId ? { sessionId: src.sessionId } : {}),
          reason: `fix --template-drift --apply (missing-barrel)`,
          extra: { fixKind: FixKind.TemplateDrift, code: 'missing-barrel', created: b.barrelPath },
        },
      });
    } catch {
      // best-effort
    }
  }
  if (wantJson) {
    process.stdout.write(asJson({ mode: 'applied', applied, appliedBarrels, refused }) + '\n');
    return refused.length > 0 ? 1 : 0;
  }
  process.stdout.write(header('Fix --template-drift --apply'));
  process.stdout.write(`  applied:  ${applied.length} drops, ${appliedBarrels.length} barrels\n`);
  process.stdout.write(`  refused:  ${refused.length}\n\n`);
  for (const a of applied) {
    process.stdout.write(`  • ${a.templateId} → ${a.sourceFile} (drop related "${a.droppedRelatedId}", removed=${a.removed})\n`);
  }
  for (const a of appliedBarrels) {
    process.stdout.write(`  • ${a.templateId} → ${a.barrelPath} (created barrel)\n`);
  }
  if (refused.length > 0) {
    process.stdout.write('\nRefused:\n');
    for (const r of refused) process.stdout.write(`  • ${r.templateId}: ${r.reason}\n`);
  }
  process.stdout.write(
    '\nRe-run `shrk templates drift --min-severity warning` to confirm the drift count dropped.\n' +
      'Barrels are created as `export {};` placeholders — populate them with the expected re-exports.\n',
  );
  return refused.length > 0 ? 1 : 0;
}

function runFixList(args: ParsedArgs): number {
  const kinds = listFixKinds();
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(kinds) + '\n');
    return 0;
  }
  process.stdout.write(header('Available fix kinds'));
  for (const k of kinds) {
    process.stdout.write(`  ${k.kind.padEnd(20)} ${k.description}\n`);
  }
  return 0;
}

async function runFixDoctor(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const report = buildFixPreview(inspection);
  const errors = report.suggestions.filter((s) => s.severity === 'error').length;
  const warnings = report.suggestions.filter((s) => s.severity === 'warning').length;
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ schema: 'sharkcraft.fix-doctor/v1', counts: { errors, warnings }, report }) + '\n',
    );
    return errors > 0 ? 1 : 0;
  }
  process.stdout.write(header('Fix doctor'));
  process.stdout.write(`  errors:   ${errors}\n`);
  process.stdout.write(`  warnings: ${warnings}\n`);
  if (report.suggestions.length === 0) {
    process.stdout.write('\nNo outstanding fixes.\n');
    return 0;
  }
  process.stdout.write('\nTop suggestions:\n');
  for (const s of report.suggestions.slice(0, 10)) {
    process.stdout.write(`  [${s.severity}] ${s.kind} ${s.targetId}\n`);
  }
  process.stdout.write('\nNext commands:\n');
  process.stdout.write('  shrk fix preview --action-hints\n');
  process.stdout.write('  shrk fix preview --knowledge-stale\n');
  process.stdout.write('  shrk fix preview --template-drift\n');
  return errors > 0 ? 1 : 0;
}
