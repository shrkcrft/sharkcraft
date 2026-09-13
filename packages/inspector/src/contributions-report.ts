/**
 * THE contributions report (round 12, ONE-CHANGE) — `shrk packs contributions`'
 * `By file:` section and MCP `get_pack_contributions`' `report`.
 *
 * "Did what I wrote take effect?" has three columns per contributed file:
 * entries ACCEPTED (the inventory's structural entries — every loader-backed
 * kind is structural since 12.1e), entries REJECTED with every reason (THE
 * rejection channel, carried by the inventory), and references that could not
 * be checked because their kind's registry is empty or undeclarable (the
 * self-config doctor's own reference probes, `collectUnresolvableReferences`).
 * Nothing here resolves or loads anything itself.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IVerdictCoverage } from '@shrkcrft/core';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import { ContributionKind } from './contribution-kind.ts';
import { contributionFileLabel, contributionKindOfLoader, formatEntryRejection } from './contribution-load-failures.ts';
import type { IContributionFileReport } from './i-contribution-file-report.ts';
import type { IContributionsReport } from './i-contributions-report.ts';
import type { IUnresolvableReferenceScan } from './i-unresolvable-reference-scan.ts';
import {
  buildPackContributionsInventoryAsync,
  contributionKindForSlot,
  type IPackContributionsInventory,
} from './pack-contributions-inventory.ts';
import { collectUnresolvableReferences } from './self-config-doctor-v2.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** A reference-declaring asset kind → the contribution kind its file is, for a file no other evidence named. */
const SOURCE_KIND: Readonly<Record<string, ContributionKind>> = {
  'registration-hint': ContributionKind.RegistrationHint,
  'routing-hint': ContributionKind.TaskRoutingHint,
  convention: ContributionKind.Convention,
  template: ContributionKind.Template,
  knowledge: ContributionKind.Knowledge,
  rule: ContributionKind.Rule,
  'path-convention': ContributionKind.Path,
  construct: ContributionKind.Construct,
  'boundary-rule': ContributionKind.Boundary,
  // Round 13: the scan covers search-tuning boost keys, as `search tuning doctor` does.
  'search-tuning': ContributionKind.SearchTuning,
};

/** A load failure's loader `kind` → its contribution kind, through THE table (`contributionKindOfLoader`). */
function asKind(kind: string, fallback: ContributionKind): ContributionKind {
  return contributionKindOfLoader(kind) ?? fallback;
}

interface IRowDraft {
  file: string;
  kind: ContributionKind;
  packageName?: string;
  status: IContributionFileReport['status'];
  loadError?: string;
  acceptedIds: Set<string>;
  rejected: IContributionFileReport['rejected'][number][];
  unresolvable: Map<string, { sourceId: string; field: string; kind: string; ids: string[]; reason: IContributionFileReport['unresolvableReferences'][number]['reason'] }>;
}

/**
 * The report from an already-built inventory and reference scan — the pure
 * half; {@link buildContributionsReport} gathers both.
 */
export function contributionsReportOf(
  inspection: ISharkcraftInspection,
  inventory: IPackContributionsInventory,
  references: IUnresolvableReferenceScan,
): IContributionsReport {
  const rows = new Map<string, IRowDraft>();
  const rel = (abs: string): string => contributionFileLabel(inspection.projectRoot, abs);
  const posix = (file: string): string => file.split(nodePath.sep).join('/');
  const rowFor = (file: string, kind: ContributionKind, packageName?: string): IRowDraft => {
    const key = posix(file);
    let row = rows.get(key);
    if (!row) {
      row = {
        file: key,
        kind,
        ...(packageName ? { packageName } : {}),
        status: 'loaded',
        acceptedIds: new Set(),
        rejected: [],
        unresolvable: new Map(),
      };
      rows.set(key, row);
    }
    if (!row.packageName && packageName) row.packageName = packageName;
    return row;
  };

  // 1) Every file a pack manifest declares (a missing one is a `missing` row).
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
    for (const slot of CONTRIBUTION_FILE_KEYS) {
      const kind = contributionKindForSlot(slot);
      if (!kind) continue;
      for (const r of contributions[slot] ?? []) {
        const abs = nodePath.resolve(pack.packageRoot, r);
        const row = rowFor(rel(abs), kind, pack.packageName);
        if (!existsSync(abs)) row.status = 'missing';
      }
    }
  }
  // 2) Accepted entries (structural) — and every file the inventory saw.
  for (const e of inventory.entries) {
    if (!e.sourceFile) continue;
    const row = rowFor(e.sourceFile, e.kind, e.packageName);
    if (e.extractionMode === 'structural') row.acceptedIds.add(e.id);
  }
  // 3) Rejected entries — THE rejection channel.
  for (const r of inventory.rejections) {
    rowFor(r.file, r.kind, r.packageName).rejected.push({
      index: r.index,
      ...(r.exportName ? { exportName: r.exportName } : {}),
      ...(r.entryId !== undefined ? { entryId: r.entryId } : {}),
      reasons: r.reasons,
      cause: r.cause,
    });
  }
  // 4) Files that failed to load.
  for (const f of inventory.loadFailures) {
    const row = rowFor(f.file, asKind(f.kind, ContributionKind.Knowledge), f.packageName);
    row.status = 'failed';
    row.loadError = f.message;
  }
  // 5) References that could not be checked, grouped per (source, field, kind, reason).
  let unattributed = 0;
  for (const u of references.references) {
    if (!u.file) {
      unattributed += 1;
      continue;
    }
    const row = rowFor(rel(u.file), SOURCE_KIND[u.sourceKind] ?? ContributionKind.Knowledge, u.packageName);
    const key = `${u.sourceId}|${u.field}|${u.kind}|${u.reason}`;
    const g = row.unresolvable.get(key) ?? { sourceId: u.sourceId, field: u.field, kind: u.kind, ids: [], reason: u.reason };
    g.ids.push(u.id);
    row.unresolvable.set(key, g);
  }

  const files: IContributionFileReport[] = [...rows.values()]
    .map((r) => {
      const accepted = r.acceptedIds.size;
      return {
        file: r.file,
        kind: r.kind,
        ...(r.packageName ? { packageName: r.packageName } : {}),
        source: r.packageName ? ('pack' as const) : ('local' as const),
        status: r.status,
        declared: accepted + r.rejected.length,
        accepted,
        acceptedIds: [...r.acceptedIds].sort(),
        rejected: [...r.rejected].sort((a, b) => a.index - b.index),
        ...(r.loadError !== undefined ? { loadError: r.loadError } : {}),
        unresolvableReferences: [...r.unresolvable.values()].map((g) => ({ ...g, ids: [...g.ids] })),
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
  return summarise(files, references.expected, unattributed);
}

/** Totals + THE reference coverage over `files` (`probed` = every reference probed in view). */
function summarise(files: readonly IContributionFileReport[], probed: number, unattributed: number): IContributionsReport {
  const unresolvable =
    files.reduce((n, f) => n + f.unresolvableReferences.reduce((m, g) => m + g.ids.length, 0), 0) + unattributed;
  const labels = files.flatMap((f) =>
    f.unresolvableReferences.flatMap((g) => g.ids.map((id) => `${f.file}: ${g.sourceId} ${g.field} → ${g.kind} ${id}`)),
  );
  const referenceCoverage: IVerdictCoverage | undefined =
    probed > 0
      ? {
          subject: 'contributed references',
          unit: 'references',
          expected: probed,
          examined: Math.max(0, probed - unresolvable),
          ...(unresolvable > 0 ? { unexamined: labels.slice(0, 20), unexaminedTotal: unresolvable } : {}),
          reason: "could not be checked — their kind's registry is empty in this workspace, or nothing can declare it",
        }
      : undefined;
  return {
    files,
    totals: {
      files: files.length,
      declared: files.reduce((n, f) => n + f.declared, 0),
      accepted: files.reduce((n, f) => n + f.accepted, 0),
      rejected: files.reduce((n, f) => n + f.rejected.length, 0),
      loadFailed: files.filter((f) => f.status === 'failed').length,
      missing: files.filter((f) => f.status === 'missing').length,
      unresolvable,
    },
    ...(referenceCoverage ? { referenceCoverage } : {}),
  };
}

/**
 * The report narrowed to `--pack` / `--kind`. A narrowed view settles on the
 * references IN VIEW: its coverage is the view's unresolvable references
 * (examined 0 of them), so a filter can never borrow another file's pass.
 */
export function filterContributionsReport(
  report: IContributionsReport,
  filter: { readonly pack?: string; readonly kind?: string },
): IContributionsReport {
  if (!filter.pack && !filter.kind) return report;
  const files = report.files.filter(
    (f) => (!filter.pack || f.packageName === filter.pack) && (!filter.kind || f.kind === filter.kind),
  );
  const inView = files.reduce((n, f) => n + f.unresolvableReferences.reduce((m, g) => m + g.ids.length, 0), 0);
  return summarise(files, inView, 0);
}

/** Every contributed file, accepted vs rejected vs unresolvable. */
export async function buildContributionsReport(
  inspection: ISharkcraftInspection,
  options: { readonly inventory?: IPackContributionsInventory; readonly references?: IUnresolvableReferenceScan } = {},
): Promise<IContributionsReport> {
  const inventory = options.inventory ?? (await buildPackContributionsInventoryAsync(inspection));
  const references = options.references ?? (await collectUnresolvableReferences(inspection));
  return contributionsReportOf(inspection, inventory, references);
}

function fileMark(f: IContributionFileReport): string {
  if (f.status !== 'loaded' || f.rejected.length > 0) return '✗';
  return f.unresolvableReferences.length > 0 ? '~' : '✓';
}

function fileSummary(f: IContributionFileReport): string {
  if (f.status === 'failed') return `FAILED TO LOAD — ${f.loadError ?? 'import error'}`;
  if (f.status === 'missing') return 'MISSING on disk — nothing in it takes effect';
  const parts = [`${f.declared} declared`, `${f.accepted} accepted`];
  if (f.rejected.length > 0) parts.push(`${f.rejected.length} rejected`);
  const u = f.unresolvableReferences.reduce((n, g) => n + g.ids.length, 0);
  if (u > 0) parts.push(`${u} unresolvable reference(s)`);
  return parts.join(' · ');
}

/** The `By file:` text section (after `By kind:`). */
export function renderContributionsByFileText(report: IContributionsReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(
    `By file (${t.files}): ${t.declared} declared · ${t.accepted} accepted · ${t.rejected} rejected${
      t.loadFailed > 0 ? ` · ${t.loadFailed} failed to load` : ''
    }${t.missing > 0 ? ` · ${t.missing} missing` : ''}${t.unresolvable > 0 ? ` · ${t.unresolvable} unresolvable reference(s)` : ''}`,
  );
  for (const f of report.files) {
    lines.push(`  ${fileMark(f)} ${f.file}  ${f.kind}${f.packageName ? ` [${f.packageName}]` : ''}  ${fileSummary(f)}`);
    for (const r of f.rejected) lines.push(`      rejected      ${formatEntryRejection(r)}`);
    for (const g of f.unresolvableReferences) {
      lines.push(
        `      unresolvable  ${g.sourceId} ${g.field} → ${g.kind} ${g.ids.map((id) => `'${id}'`).join(', ')} — ${
          g.reason === 'undeclarable-kind' ? 'no registry can ever hold this kind' : "this kind's registry is empty here"
        }`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** The `## By file` markdown section. */
export function renderContributionsByFileMarkdown(report: IContributionsReport): string {
  const lines: string[] = ['## By file', ''];
  if (report.files.length === 0) {
    lines.push('None.');
    return lines.join('\n') + '\n';
  }
  lines.push('| File | Kind | Pack | Status | Declared | Accepted | Rejected | Unresolvable |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const f of report.files) {
    const u = f.unresolvableReferences.reduce((n, g) => n + g.ids.length, 0);
    lines.push(
      `| \`${f.file}\` | ${f.kind} | ${f.packageName ?? ''} | ${f.status} | ${f.declared} | ${f.accepted} | ${f.rejected.length} | ${u} |`,
    );
  }
  const detail = report.files.filter((f) => f.rejected.length > 0 || f.unresolvableReferences.length > 0);
  if (detail.length > 0) {
    lines.push('');
    for (const f of detail) {
      lines.push(`- \`${f.file}\``);
      for (const r of f.rejected) lines.push(`  - rejected: ${formatEntryRejection(r)}`);
      for (const g of f.unresolvableReferences) {
        lines.push(`  - unresolvable: ${g.sourceId} ${g.field} → ${g.kind} ${g.ids.join(', ')} (${g.reason})`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
