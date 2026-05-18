/**
 * Pack pending state.
 *
 * Cross-section report: what is *not yet finalised* in the pack authoring
 * loop. Combines:
 *   - modified pack asset files (mtime > signature)
 *   - generated preview drafts under .sharkcraft/authoring/
 *   - stale signature state (per-pack)
 *   - missing secret state
 *   - provenance entries not yet sealed (operation=preview without a
 *     follow-up apply or remove)
 *
 * Never signs. Never mutates pack source. Honest when secret is missing.
 *
 * Schema: sharkcraft.pack-pending/v1
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildPackSignatureStatusReport, PackSignatureStatusKind } from './pack-signature-status.ts';
import { readProvenance, AssetProvenanceOperation } from './asset-provenance.ts';

export const PACK_PENDING_SCHEMA = 'sharkcraft.pack-pending/v1';

export interface IPackPendingEntry {
  readonly packageName: string;
  readonly packageRoot: string;
  /** Files modified relative to the current signature, if any. */
  readonly modifiedFiles: ReadonlyArray<{
    readonly filePath: string;
    readonly mtime: string;
  }>;
  /** Pack signature freshness for this pack. */
  readonly signatureStatus: PackSignatureStatusKind;
  /** Whether SHARKCRAFT_PACK_SECRET is available. */
  readonly secretAvailable: boolean;
  /** Recommended next command for this pack. */
  readonly nextCommand?: string;
}

export interface IPendingDraftEntry {
  readonly filePath: string;
  readonly purpose: 'authoring-draft' | 'fix-preview' | 'authoring-manifest' | 'authoring-explainer' | 'other';
  readonly mtime: string;
}

export interface IPendingProvenanceEntry {
  readonly assetKind: string;
  readonly assetId: string;
  readonly generatedAt: string;
  readonly reason?: string;
}

export interface IPackPendingReport {
  readonly schema: typeof PACK_PENDING_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly secretAvailable: boolean;
  /** True when ANY pending state is non-zero. */
  readonly hasPending: boolean;
  readonly packs: readonly IPackPendingEntry[];
  readonly draftFiles: readonly IPendingDraftEntry[];
  readonly pendingProvenance: readonly IPendingProvenanceEntry[];
  readonly nextCommands: readonly string[];
  /** When secret is missing, this contains the agent-friendly explanation. */
  readonly secretMissingHint?: string;
  /** When set, the path to a written signing TODO report. */
  readonly signingTodoReportPath?: string;
}

export interface IBuildPackPendingOptions {
  /** When true, treat every authoring draft as pending. */
  includeAuthoringDrafts?: boolean;
}

function detectDraftPurpose(filename: string): IPendingDraftEntry['purpose'] {
  if (filename.endsWith('.draft.ts')) return 'authoring-draft';
  if (filename.endsWith('.manifest.json')) return 'authoring-manifest';
  if (filename.endsWith('.preview.md') || filename.endsWith('.md')) return 'authoring-explainer';
  if (filename.endsWith('.patch')) return 'fix-preview';
  return 'other';
}

function scanDirectoryShallow(dir: string): IPendingDraftEntry[] {
  if (!existsSync(dir)) return [];
  const out: IPendingDraftEntry[] = [];
  for (const f of readdirSync(dir)) {
    const abs = nodePath.join(dir, f);
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        out.push({
          filePath: abs,
          purpose: detectDraftPurpose(f),
          mtime: new Date(st.mtimeMs).toISOString(),
        });
      }
    } catch {
      // Ignore.
    }
  }
  return out;
}

export function buildPackPendingReport(
  inspection: ISharkcraftInspection,
  options: IBuildPackPendingOptions = {},
): IPackPendingReport {
  const root = inspection.projectRoot;
  const secret = Boolean(process.env['SHARKCRAFT_PACK_SECRET']);
  const sig = buildPackSignatureStatusReport(inspection);
  const packs: IPackPendingEntry[] = sig.packs.map((p) => ({
    packageName: p.packageName,
    packageRoot: p.packageRoot,
    modifiedFiles: p.newerContributionFile
      ? [{ filePath: p.newerContributionFile, mtime: p.newerContributionMtime ?? '' }]
      : [],
    signatureStatus: p.status,
    secretAvailable: p.secretAvailable,
    ...(p.nextCommand ? { nextCommand: p.nextCommand } : {}),
  }));

  const authoringDir = nodePath.join(root, '.sharkcraft', 'authoring');
  const fixesDir = nodePath.join(root, '.sharkcraft', 'fixes');
  const draftFiles: IPendingDraftEntry[] = [
    ...scanDirectoryShallow(authoringDir),
    ...scanDirectoryShallow(fixesDir),
  ];
  // Convert absolute paths to project-relative for the report.
  const draftFilesRel = draftFiles.map((d) => ({
    ...d,
    filePath: nodePath.relative(root, d.filePath),
  }));

  // Pending provenance — operation=preview without a later apply for the
  // same (kind, id).
  const provenance = readProvenance(root);
  const seenApplied = new Set<string>();
  const seenRemoved = new Set<string>();
  for (const e of provenance) {
    const k = `${e.assetKind}::${e.assetId}`;
    if (e.operation === AssetProvenanceOperation.Apply) seenApplied.add(k);
    if (e.operation === AssetProvenanceOperation.Remove) seenRemoved.add(k);
  }
  const pendingProvenance: IPendingProvenanceEntry[] = [];
  const seenPending = new Set<string>();
  for (const e of provenance) {
    if (e.operation !== AssetProvenanceOperation.Preview) continue;
    const k = `${e.assetKind}::${e.assetId}`;
    if (seenApplied.has(k) || seenRemoved.has(k)) continue;
    if (seenPending.has(k)) continue;
    seenPending.add(k);
    pendingProvenance.push({
      assetKind: e.assetKind,
      assetId: e.assetId,
      generatedAt: e.generatedAt,
      ...(e.reason ? { reason: e.reason } : {}),
    });
  }

  const hasPending =
    packs.some((p) => p.signatureStatus !== PackSignatureStatusKind.Present) ||
    draftFilesRel.length > 0 ||
    pendingProvenance.length > 0;

  const nextCommands: string[] = [];
  nextCommands.push('shrk knowledge stale-check --ci');
  nextCommands.push('shrk self-config doctor');
  if (packs.some((p) => p.signatureStatus !== PackSignatureStatusKind.Present)) {
    if (secret) {
      nextCommands.push('shrk packs sign --if-needed');
    } else {
      nextCommands.push('shrk packs sign --print-command');
      nextCommands.push('shrk packs sign --write-todo');
    }
  }

  const secretMissingHint = secret
    ? undefined
    : 'SHARKCRAFT_PACK_SECRET is not set in this environment. Pack signatures cannot be refreshed automatically; ' +
      'run `shrk packs sign --print-command` (or `--write-todo`) to obtain the command for a human / signing CI.';

  void options;

  return {
    schema: PACK_PENDING_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    secretAvailable: secret,
    hasPending,
    packs,
    draftFiles: draftFilesRel,
    pendingProvenance,
    nextCommands,
    ...(secretMissingHint ? { secretMissingHint } : {}),
  };
}

export function renderPackPendingMarkdown(report: IPackPendingReport): string {
  const lines: string[] = [];
  lines.push('# Pack pending state');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Secret available: ${report.secretAvailable ? 'yes' : 'no'}`);
  lines.push(`Has pending: ${report.hasPending ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Packs');
  lines.push('');
  if (report.packs.length === 0) lines.push('_(no packs discovered)_');
  for (const p of report.packs) {
    lines.push(
      `- \`${p.packageName}\` — ${p.signatureStatus}${p.modifiedFiles.length > 0 ? ` — modified: ${p.modifiedFiles.map((f) => f.filePath).join(', ')}` : ''}`,
    );
    if (p.nextCommand) lines.push(`    next: \`${p.nextCommand}\``);
  }
  lines.push('');
  lines.push('## Draft files');
  lines.push('');
  if (report.draftFiles.length === 0) lines.push('_(none)_');
  for (const d of report.draftFiles) {
    lines.push(`- \`${d.filePath}\` (${d.purpose}, mtime ${d.mtime})`);
  }
  lines.push('');
  lines.push('## Pending provenance');
  lines.push('');
  if (report.pendingProvenance.length === 0) lines.push('_(none)_');
  for (const e of report.pendingProvenance) {
    lines.push(`- \`${e.assetKind}:${e.assetId}\` (preview at ${e.generatedAt})${e.reason ? ` — ${e.reason}` : ''}`);
  }
  lines.push('');
  if (report.secretMissingHint) {
    lines.push('## Secret missing');
    lines.push('');
    lines.push(report.secretMissingHint);
    lines.push('');
  }
  lines.push('## Next commands');
  lines.push('');
  for (const c of report.nextCommands) lines.push(`- \`${c}\``);
  lines.push('');
  return lines.join('\n');
}
