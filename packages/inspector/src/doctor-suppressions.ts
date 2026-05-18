/**
 * Doctor warning noise control.
 *
 * Reads `sharkcraft/doctor.suppressions.json` (and, optionally, a
 * `doctorSuppressions` field on `sharkcraft.config.ts`) and lets callers
 * mark specific findings as suppressed.
 *
 * Rules:
 *  - Suppressed findings are counted, not deleted. Renderers know to hide
 *    them from the headline output but include the count in summary.
 *  - Expired suppressions surface as a warning so authors notice.
 *  - Errors are NOT suppressed unless the suppression explicitly marks
 *    `allowError: true`. The aggregate output also tells the user that
 *    one or more errors were force-suppressed.
 *
 * Schema: sharkcraft.doctor-suppressions/v1
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IDoctorCheck, IDoctorResult } from './doctor-result.ts';
import { DoctorSeverity } from './doctor-result.ts';

export const DOCTOR_SUPPRESSIONS_SCHEMA = 'sharkcraft.doctor-suppressions/v1';

export interface IDoctorSuppressionEntry {
  /** Stable id of the finding (preferred match). */
  id?: string;
  /** Optional code/category — any finding with this code matches. */
  code?: string;
  /** Optional category bucket — matches against the derived category. */
  category?: string;
  /** Required reason for suppression — surfaces in audit output. */
  reason: string;
  /** Optional ISO date after which the suppression no longer applies. */
  expiresAt?: string;
  /** Set true to allow suppressing errors. Default false. */
  allowError?: boolean;
}

export interface IDoctorSuppressionsConfig {
  schema?: typeof DOCTOR_SUPPRESSIONS_SCHEMA;
  doctorSuppressions: ReadonlyArray<IDoctorSuppressionEntry>;
}

export interface IDoctorFindingWithStableId extends IDoctorCheck {
  /** Stable id derived from `id` + a hash slug for repeated rows. */
  stableId: string;
  /** Best-effort category derived from the id prefix. */
  category: string;
}

export interface IDoctorFilteredResult {
  schema: 'sharkcraft.doctor-filtered/v1';
  passed: boolean;
  checks: ReadonlyArray<IDoctorFindingWithStableId>;
  suppressedChecks: ReadonlyArray<IDoctorFindingWithStableId>;
  expiredSuppressions: ReadonlyArray<IDoctorSuppressionEntry>;
  appliedSuppressions: ReadonlyArray<{ entry: IDoctorSuppressionEntry; matched: number }>;
  summary: {
    ok: number;
    info: number;
    warnings: number;
    errors: number;
    suppressedWarnings: number;
    suppressedInfo: number;
    suppressedErrors: number;
  };
}

export interface IDoctorFilterOptions {
  focus?: ReadonlyArray<'errors' | 'warnings' | 'warnings-new' | 'info' | 'ok' | 'all'>;
  hide?: ReadonlyArray<string>;
  quietKnown?: boolean;
  suppressions?: ReadonlyArray<IDoctorSuppressionEntry>;
}

/** Default file path for doctor suppressions. */
export function doctorSuppressionsFile(projectRoot: string): string {
  return nodePath.join(projectRoot, 'sharkcraft/doctor.suppressions.json');
}

export function loadDoctorSuppressions(
  projectRoot: string,
): IDoctorSuppressionsConfig {
  const file = doctorSuppressionsFile(projectRoot);
  if (!existsSync(file)) {
    return { schema: DOCTOR_SUPPRESSIONS_SCHEMA, doctorSuppressions: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as IDoctorSuppressionsConfig;
    const entries = Array.isArray(raw.doctorSuppressions) ? raw.doctorSuppressions : [];
    return {
      schema: DOCTOR_SUPPRESSIONS_SCHEMA,
      doctorSuppressions: entries.filter((e) => e && typeof e.reason === 'string'),
    };
  } catch {
    return { schema: DOCTOR_SUPPRESSIONS_SCHEMA, doctorSuppressions: [] };
  }
}

export function saveDoctorSuppressions(
  projectRoot: string,
  config: IDoctorSuppressionsConfig,
): string {
  const file = doctorSuppressionsFile(projectRoot);
  const out: IDoctorSuppressionsConfig = {
    schema: DOCTOR_SUPPRESSIONS_SCHEMA,
    doctorSuppressions: config.doctorSuppressions,
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Derive a stable id for a finding so the same warning can be suppressed
 * across runs even when the message text shifts slightly.
 */
export function deriveStableId(check: IDoctorCheck): string {
  // The base id is already deterministic in the doctor; we append a short
  // message hash so duplicate-id rows still get distinct ids.
  const msg = check.message ?? '';
  let hash = 0;
  for (let i = 0; i < msg.length; i++) {
    hash = (hash * 31 + msg.charCodeAt(i)) | 0;
  }
  const slug = Math.abs(hash).toString(36).slice(0, 6);
  return `${check.id}:${slug}`;
}

export function deriveCategory(check: IDoctorCheck): string {
  const id = check.id || '';
  // Match common prefixes seen in the doctor output.
  if (id.startsWith('actionhints-') || id.startsWith('action-hint')) return 'action-hint-quality';
  if (id.startsWith('missing-')) return 'missing-commands-or-mcp';
  if (id.startsWith('pack:')) return 'pack-doctor';
  if (id.startsWith('boundary')) return 'boundary';
  return id.split(/[:.\s]/)[0] ?? 'general';
}

function isExpired(entry: IDoctorSuppressionEntry, now: Date): boolean {
  if (!entry.expiresAt) return false;
  try {
    return new Date(entry.expiresAt).getTime() < now.getTime();
  } catch {
    return false;
  }
}

function entryMatches(entry: IDoctorSuppressionEntry, finding: IDoctorFindingWithStableId): boolean {
  if (entry.id && entry.id === finding.stableId) return true;
  if (entry.id && entry.id === finding.id) return true;
  if (entry.code && entry.code === finding.id) return true;
  if (entry.category && entry.category === finding.category) return true;
  return false;
}

function shouldHideByCategory(category: string, hide: ReadonlyArray<string> | undefined): boolean {
  if (!hide || hide.length === 0) return false;
  return hide.includes(category);
}

function passesFocus(
  finding: IDoctorFindingWithStableId,
  focus: ReadonlyArray<string> | undefined,
): boolean {
  if (!focus || focus.length === 0 || focus.includes('all')) return true;
  const sev = finding.severity;
  if (focus.includes('errors') && sev === DoctorSeverity.Error) return true;
  if (focus.includes('warnings') && sev === DoctorSeverity.Warning) return true;
  if (focus.includes('info') && sev === DoctorSeverity.Info) return true;
  if (focus.includes('ok') && sev === DoctorSeverity.Ok) return true;
  // "warnings-new" means: warnings that don't match a suppression. Filter
  // later — at this point we let the row through and the caller will drop
  // already-suppressed warnings via quietKnown.
  if (focus.includes('warnings-new') && sev === DoctorSeverity.Warning) return true;
  return false;
}

export function filterDoctorResult(
  doctor: IDoctorResult,
  options: IDoctorFilterOptions = {},
): IDoctorFilteredResult {
  const now = new Date();
  const suppressions = options.suppressions ?? [];
  const expired: IDoctorSuppressionEntry[] = [];
  const liveSuppressions: IDoctorSuppressionEntry[] = [];
  for (const s of suppressions) {
    if (isExpired(s, now)) expired.push(s);
    else liveSuppressions.push(s);
  }

  const annotated = doctor.checks.map<IDoctorFindingWithStableId>((c) => ({
    ...c,
    stableId: deriveStableId(c),
    category: deriveCategory(c),
  }));

  const matched = new Map<IDoctorSuppressionEntry, number>();
  for (const s of liveSuppressions) matched.set(s, 0);

  const visible: IDoctorFindingWithStableId[] = [];
  const suppressed: IDoctorFindingWithStableId[] = [];

  for (const finding of annotated) {
    // 1) hide by category list.
    if (shouldHideByCategory(finding.category, options.hide)) {
      suppressed.push(finding);
      continue;
    }
    // 2) suppression entries.
    const match = liveSuppressions.find((s) => entryMatches(s, finding));
    if (match) {
      const isError = finding.severity === DoctorSeverity.Error;
      if (isError && !match.allowError) {
        // Cannot suppress an error implicitly — keep it.
        visible.push(finding);
        continue;
      }
      matched.set(match, (matched.get(match) ?? 0) + 1);
      suppressed.push(finding);
      continue;
    }
    // 3) focus filter.
    if (!passesFocus(finding, options.focus)) {
      suppressed.push(finding);
      continue;
    }
    visible.push(finding);
  }

  // 4) quiet-known: drop visible rows that have a matching suppression
  //    (already moved to suppressed) — already handled. Additionally, when
  //    quietKnown is set we drop "ok" rows that share a category with a
  //    suppression so they don't clutter the headline.
  if (options.quietKnown) {
    const knownCats = new Set(liveSuppressions.map((s) => s.category).filter(Boolean));
    for (let i = visible.length - 1; i >= 0; i--) {
      const v = visible[i];
      if (v && v.severity === DoctorSeverity.Ok && knownCats.has(v.category)) {
        visible.splice(i, 1);
      }
    }
  }

  const summary = {
    ok: 0,
    info: 0,
    warnings: 0,
    errors: 0,
    suppressedWarnings: 0,
    suppressedInfo: 0,
    suppressedErrors: 0,
  };
  for (const v of visible) {
    if (v.severity === DoctorSeverity.Ok) summary.ok += 1;
    else if (v.severity === DoctorSeverity.Info) summary.info += 1;
    else if (v.severity === DoctorSeverity.Warning) summary.warnings += 1;
    else if (v.severity === DoctorSeverity.Error) summary.errors += 1;
  }
  for (const s of suppressed) {
    if (s.severity === DoctorSeverity.Warning) summary.suppressedWarnings += 1;
    else if (s.severity === DoctorSeverity.Info) summary.suppressedInfo += 1;
    else if (s.severity === DoctorSeverity.Error) summary.suppressedErrors += 1;
  }

  return {
    schema: 'sharkcraft.doctor-filtered/v1',
    passed: summary.errors === 0,
    checks: visible,
    suppressedChecks: suppressed,
    expiredSuppressions: expired,
    appliedSuppressions: liveSuppressions.map((entry) => ({
      entry,
      matched: matched.get(entry) ?? 0,
    })),
    summary,
  };
}

export interface IBuildSuppressionEntryInput {
  /** Pass a stableId or finding code. */
  id?: string;
  code?: string;
  category?: string;
  reason: string;
  expiresAt?: string;
  allowError?: boolean;
}

export function buildSuppressionEntry(input: IBuildSuppressionEntryInput): IDoctorSuppressionEntry {
  const out: IDoctorSuppressionEntry = { reason: input.reason };
  if (input.id) out.id = input.id;
  if (input.code) out.code = input.code;
  if (input.category) out.category = input.category;
  if (input.expiresAt) out.expiresAt = input.expiresAt;
  if (input.allowError) out.allowError = input.allowError;
  return out;
}
