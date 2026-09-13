/**
 * Self-config doctor — the v1 schema (`sharkcraft.self-config-doctor/v1`).
 *
 * v1 is a PROJECTION of v2 (`buildSelfConfigDoctorReportV2`). It used to be a
 * second doctor with its own private checks: the CLI (v2) and the MCP tool /
 * `fix preview --self-config` (v1) answered "is my config healthy?" with
 * different check sets, and v1 still carried the hand-written `lookups.x.has`
 * chain that reported correct ids as unknown. Now there is one set of checks;
 * v1 only renames fields for back-compat (`sourceId` → `referencingId`,
 * `targetId` → `referencedId`, `targetKind` → `referencedKind`, `file` →
 * `sourceFile`) and maps the v2 `pack-signature-stale` code back to its v1
 * spelling `pack-conflict:stale-signature`.
 *
 * `buildSelfConfigGraph` keeps its own lookup (a node list, not a check).
 *
 * Read-only. Never imports executable pack code beyond the loaders that
 * already do.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IVerdictCoverage } from '@shrkcrft/core';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  referenceIdsFor,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';
import {
  buildSelfConfigDoctorReportV2,
  type ISelfConfigDoctorReportV2,
  type ISelfConfigFindingV2,
} from './self-config-doctor-v2.ts';

export const SELF_CONFIG_DOCTOR_SCHEMA = 'sharkcraft.self-config-doctor/v1';

export enum SelfConfigSeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface ISelfConfigFinding {
  readonly severity: SelfConfigSeverity;
  readonly code: string;
  readonly message: string;
  readonly sourceFile?: string;
  readonly referencingId?: string;
  readonly referencedId?: string;
  readonly referencedKind?: string;
  readonly nextCommand?: string;
  /** How many times v2 found this same finding (omitted when once). */
  readonly occurrences?: number;
}

export interface ISelfConfigDoctorReport {
  readonly schema: typeof SELF_CONFIG_DOCTOR_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly findings: readonly ISelfConfigFinding[];
  readonly totals: Readonly<Record<string, number>>;
  /**
   * v2's verdict. `unverified` (round 11): no errors, but a coverage record has
   * a shortfall — a dead or unverifiable unit, e.g. command strings over MCP,
   * which cannot inject the CLI's command index. See `coverage`.
   */
  readonly verdict: 'ok' | 'warnings' | 'errors' | 'unverified';
  readonly nextCommands: readonly string[];
  /** v2's per-unit coverage — what each probe family examined. */
  readonly coverage?: readonly IVerdictCoverage[];
  /** v2's dead units (selectors that match nothing, boosts that never fire). */
  readonly deadUnits?: readonly string[];
}

export interface ISelfConfigGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly source?: string;
}

export interface ISelfConfigGraphEdge {
  readonly from: ISelfConfigGraphNode;
  readonly to: ISelfConfigGraphNode;
  readonly relation: string;
}

export interface ISelfConfigGraph {
  readonly schema: 'sharkcraft.self-config-graph/v1';
  readonly nodes: readonly ISelfConfigGraphNode[];
  readonly edges: readonly ISelfConfigGraphEdge[];
  readonly brokenEdges: readonly ISelfConfigGraphEdge[];
}

interface IIdLookup {
  knowledge: Set<string>;
  rules: Set<string>;
  templates: Set<string>;
  pipelines: Set<string>;
  conventions: Set<string>;
  contractTemplates: Set<string>;
  migrationProfiles: Set<string>;
}

/**
 * The graph's node sets — every set a projection of the SHARED reference
 * registry (no check reads them; the checks are v2's).
 */
async function buildLookups(inspection: ISharkcraftInspection): Promise<IIdLookup> {
  await warmReferenceRegistries(inspection);
  const ids = (kind: ReferenceKind): Set<string> =>
    new Set<string>(referenceIdsFor(inspection, kind));
  return {
    knowledge: ids('knowledge'),
    rules: ids('rule'),
    templates: ids('template'),
    pipelines: ids('pipeline'),
    conventions: ids('convention'),
    contractTemplates: ids('contract-template'),
    migrationProfiles: ids('migration-profile'),
  };
}

/** v2's `pack-signature-stale` is v1's `pack-conflict:stale-signature`. */
function v1Code(code: string): string {
  return code === 'pack-signature-stale' ? 'pack-conflict:stale-signature' : code;
}

function projectFinding(f: ISelfConfigFindingV2): ISelfConfigFinding {
  return {
    severity:
      f.severity === 'error'
        ? SelfConfigSeverity.Error
        : f.severity === 'warning'
          ? SelfConfigSeverity.Warning
          : SelfConfigSeverity.Info,
    code: v1Code(f.code),
    message: f.message,
    ...(f.file !== undefined ? { sourceFile: f.file } : {}),
    referencingId: f.sourceId,
    referencedId: f.targetId,
    referencedKind: f.targetKind,
    ...(f.nextCommand !== undefined ? { nextCommand: f.nextCommand } : {}),
    ...(f.occurrences !== undefined ? { occurrences: f.occurrences } : {}),
  };
}

/** The v1 shape of a v2 report — field renames only; no check of its own. */
export function projectSelfConfigDoctorV2ToV1(report: ISelfConfigDoctorReportV2): ISelfConfigDoctorReport {
  return {
    schema: SELF_CONFIG_DOCTOR_SCHEMA,
    generatedAt: report.generatedAt,
    projectRoot: report.projectRoot,
    findings: report.findings.map(projectFinding),
    totals: { error: report.totals.error, warning: report.totals.warning, info: report.totals.info },
    verdict: report.verdict,
    nextCommands: report.nextCommands,
    coverage: report.coverage,
    deadUnits: report.deadUnits,
  };
}

/**
 * The v1 report: {@link projectSelfConfigDoctorV2ToV1} of THE doctor. Kept
 * for the MCP `get_self_config_doctor` default and v1 JSON consumers.
 */
export async function buildSelfConfigDoctorReport(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigDoctorReport> {
  return projectSelfConfigDoctorV2ToV1(await buildSelfConfigDoctorReportV2(inspection));
}

export async function buildSelfConfigGraph(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigGraph> {
  const nodes: ISelfConfigGraphNode[] = [];
  const edges: ISelfConfigGraphEdge[] = [];
  const brokenEdges: ISelfConfigGraphEdge[] = [];
  const lookups = await buildLookups(inspection);

  // Nodes: collect ids per kind
  for (const id of lookups.knowledge) nodes.push({ id, kind: 'knowledge' });
  for (const id of lookups.rules) nodes.push({ id, kind: 'rule' });
  for (const id of lookups.templates) nodes.push({ id, kind: 'template' });
  for (const id of lookups.pipelines) nodes.push({ id, kind: 'pipeline' });
  for (const id of lookups.conventions) nodes.push({ id, kind: 'convention' });
  for (const id of lookups.contractTemplates) nodes.push({ id, kind: 'contract-template' });
  for (const id of lookups.migrationProfiles) nodes.push({ id, kind: 'migration-profile' });

  // Edges from knowledge → referenced ids (best-effort).
  for (const k of inspection.knowledgeEntries) {
    for (const ref of k.references ?? []) {
      const refId = ref.path ?? '';
      if (!refId) continue;
      const from = { id: k.id, kind: 'knowledge' };
      const to = { id: refId, kind: ref.kind ?? 'file' };
      const edge: ISelfConfigGraphEdge = { from, to, relation: 'references' };
      edges.push(edge);
      if (ref.kind === 'file') {
        const abs = nodePath.isAbsolute(refId)
          ? refId
          : nodePath.join(inspection.projectRoot, refId);
        if (!existsSync(abs)) brokenEdges.push(edge);
      }
    }
  }

  return {
    schema: 'sharkcraft.self-config-graph/v1',
    nodes,
    edges,
    brokenEdges,
  };
}

export function renderSelfConfigDoctorText(report: ISelfConfigDoctorReport): string {
  const lines: string[] = [];
  lines.push(`=== Self-config doctor ===`);
  lines.push(`  generatedAt   ${report.generatedAt}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push(`  errors        ${report.totals['error'] ?? 0}`);
  lines.push(`  warnings      ${report.totals['warning'] ?? 0}`);
  lines.push(`  info          ${report.totals['info'] ?? 0}`);
  lines.push('');
  if (report.findings.length === 0) {
    // No ✓: whether this is a pass is the settled verdict's call.
    lines.push('  No findings.');
    return lines.join('\n') + '\n';
  }
  for (const f of report.findings.slice(0, 100)) {
    lines.push(`  ${f.severity.padEnd(7)} [${f.code}] ${f.message}`);
    if (f.nextCommand) lines.push(`           next: ${f.nextCommand}`);
  }
  if (report.findings.length > 100) {
    lines.push(`  … (${report.findings.length - 100} more)`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('\nNext:');
    for (const c of report.nextCommands) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function renderSelfConfigDoctorMarkdown(report: ISelfConfigDoctorReport): string {
  const lines: string[] = ['# Self-config doctor', ''];
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push(`- errors: ${report.totals['error'] ?? 0}`);
  lines.push(`- warnings: ${report.totals['warning'] ?? 0}`);
  lines.push(`- info: ${report.totals['info'] ?? 0}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n') + '\n';
  }
  lines.push('| Severity | Code | Message | Next |');
  lines.push('| --- | --- | --- | --- |');
  for (const f of report.findings) {
    lines.push(
      `| ${f.severity} | \`${f.code}\` | ${f.message} | ${f.nextCommand ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
