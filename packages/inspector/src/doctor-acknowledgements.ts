/**
 * Doctor acknowledgements.
 *
 * Thin layer on top of the suppression system: an "acknowledgement" is a
 * suppression that REQUIRES a non-empty `reason` and an explicit expiry.
 * The on-disk format is the same `sharkcraft/doctor.suppressions.json`, so
 * existing tooling continues to work.
 *
 * Provides:
 *   - `parseExpiresIn(value)` — `7d` / `48h` / `2w` → ISO date string.
 *   - `buildAcknowledgement(input)` — validates reason + expiry and returns
 *     a suppression entry that the existing save path accepts.
 *   - `summarizeAcknowledgements(suppressions, now)` — splits live / expired
 *     / suppression-only entries so a "doctor --fail-on-expired-acknowledgement"
 *     run can decide the exit code.
 *
 * Read-only: no file mutation here; the CLI persistence calls
 * `saveDoctorSuppressions` from the suppressions module.
 */
import type { IDoctorSuppressionEntry } from './doctor-suppressions.ts';

export const DOCTOR_ACKNOWLEDGEMENT_SCHEMA = 'sharkcraft.doctor-acknowledgements/v1';

export interface IBuildAcknowledgementInput {
  /** Finding id (preferred) — matches the stable id from doctor-suppressions. */
  id?: string;
  /** Finding code/category (`actionhints-...`). */
  code?: string;
  /** Category bucket (`action-hint-quality`). */
  category?: string;
  /** Required free-form reason. */
  reason: string;
  /** Either `expiresAt` (ISO date) or `expiresIn` (`7d`, `48h`, `2w`). */
  expiresAt?: string;
  expiresIn?: string;
  /** Permit acknowledging an error finding. Default false. */
  allowError?: boolean;
  /** Used to evaluate `expiresIn` against a reference clock. Defaults to now. */
  now?: Date;
}

export interface IBuildAcknowledgementResult {
  ok: boolean;
  entry?: IDoctorSuppressionEntry;
  error?: string;
}

const DURATION_RE = /^(\d+)\s*(d|day|days|h|hour|hours|w|week|weeks|m|min|minute|minutes)$/i;

/**
 * Parse `7d`, `48h`, `2w` style relative durations into an ISO date string
 * computed from `now`. Returns null if the value is unparsable.
 */
export function parseExpiresIn(value: string, now: Date = new Date()): string | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 'd').toLowerCase();
  let ms: number;
  if (unit.startsWith('w')) ms = n * 7 * 24 * 60 * 60 * 1000;
  else if (unit.startsWith('h')) ms = n * 60 * 60 * 1000;
  else if (unit.startsWith('m') && !unit.startsWith('mo')) ms = n * 60 * 1000;
  else ms = n * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString();
}

export function buildAcknowledgement(
  input: IBuildAcknowledgementInput,
): IBuildAcknowledgementResult {
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) {
    return { ok: false, error: 'reason is required and must be non-empty' };
  }
  if (reason.toUpperCase().startsWith('TODO')) {
    return {
      ok: false,
      error:
        'reason starts with TODO; acknowledgements need a justification, not a placeholder',
    };
  }
  if (!input.id && !input.code && !input.category) {
    return { ok: false, error: 'one of id / code / category is required' };
  }
  let expiresAt = input.expiresAt;
  if (!expiresAt && input.expiresIn) {
    const parsed = parseExpiresIn(input.expiresIn, input.now ?? new Date());
    if (!parsed) {
      return {
        ok: false,
        error: `expiresIn "${input.expiresIn}" is not a duration (try 7d / 48h / 2w)`,
      };
    }
    expiresAt = parsed;
  }
  if (!expiresAt) {
    return {
      ok: false,
      error: 'an acknowledgement requires either --expires-at or --expires-in',
    };
  }
  // Sanity-check the expiry is in the future (and not in the distant past).
  const ts = new Date(expiresAt).getTime();
  if (!Number.isFinite(ts)) {
    return { ok: false, error: `expiresAt "${expiresAt}" is not a valid ISO date` };
  }
  const now = input.now ?? new Date();
  if (ts <= now.getTime()) {
    return { ok: false, error: `expiresAt "${expiresAt}" is already in the past` };
  }
  const entry: IDoctorSuppressionEntry = { reason };
  if (input.id) entry.id = input.id;
  if (input.code) entry.code = input.code;
  if (input.category) entry.category = input.category;
  entry.expiresAt = expiresAt;
  if (input.allowError) entry.allowError = input.allowError;
  return { ok: true, entry };
}

export interface IAcknowledgementSummary {
  /** Entries that look like acknowledgements (have reason + expiresAt). */
  acknowledgements: ReadonlyArray<IDoctorSuppressionEntry>;
  /** Entries with no expiry — bare suppressions, not acknowledgements. */
  bareSuppressions: ReadonlyArray<IDoctorSuppressionEntry>;
  /** Acknowledgements whose expiry already passed. */
  expired: ReadonlyArray<IDoctorSuppressionEntry>;
  /** Acknowledgements expiring within `expiringSoonDays`. */
  expiringSoon: ReadonlyArray<IDoctorSuppressionEntry>;
  /** Total active (non-expired) acknowledgement count. */
  activeCount: number;
}

export interface ISummarizeOptions {
  now?: Date;
  /** Default 7. Acknowledgements within this window are flagged expiring soon. */
  expiringSoonDays?: number;
}

export function summarizeAcknowledgements(
  entries: ReadonlyArray<IDoctorSuppressionEntry>,
  options: ISummarizeOptions = {},
): IAcknowledgementSummary {
  const now = options.now ?? new Date();
  const window = (options.expiringSoonDays ?? 7) * 24 * 60 * 60 * 1000;
  const acknowledgements: IDoctorSuppressionEntry[] = [];
  const bareSuppressions: IDoctorSuppressionEntry[] = [];
  const expired: IDoctorSuppressionEntry[] = [];
  const expiringSoon: IDoctorSuppressionEntry[] = [];

  for (const e of entries) {
    if (!e.expiresAt) {
      bareSuppressions.push(e);
      continue;
    }
    const ts = new Date(e.expiresAt).getTime();
    if (!Number.isFinite(ts)) {
      bareSuppressions.push(e);
      continue;
    }
    if (ts < now.getTime()) {
      expired.push(e);
      continue;
    }
    acknowledgements.push(e);
    if (ts - now.getTime() <= window) expiringSoon.push(e);
  }
  return {
    acknowledgements,
    bareSuppressions,
    expired,
    expiringSoon,
    activeCount: acknowledgements.length,
  };
}

export function renderAcknowledgementsText(summary: IAcknowledgementSummary): string {
  const lines: string[] = [];
  lines.push('=== Doctor acknowledgements ===');
  lines.push(`  active        ${summary.acknowledgements.length}`);
  lines.push(`  expiringSoon  ${summary.expiringSoon.length}`);
  lines.push(`  expired       ${summary.expired.length}`);
  lines.push(`  bare-suppressions (no expiry) ${summary.bareSuppressions.length}`);
  if (summary.acknowledgements.length > 0) {
    lines.push('');
    lines.push('Active:');
    for (const e of summary.acknowledgements) {
      lines.push(
        `  • ${describeKey(e)} [until ${e.expiresAt}] — ${e.reason}`,
      );
    }
  }
  if (summary.expiringSoon.length > 0) {
    lines.push('');
    lines.push('Expiring soon:');
    for (const e of summary.expiringSoon) {
      lines.push(`  • ${describeKey(e)} [until ${e.expiresAt}]`);
    }
  }
  if (summary.expired.length > 0) {
    lines.push('');
    lines.push('Expired (re-evaluate):');
    for (const e of summary.expired) {
      lines.push(
        `  • ${describeKey(e)} [expired ${e.expiresAt}] — ${e.reason}`,
      );
    }
  }
  if (summary.bareSuppressions.length > 0) {
    lines.push('');
    lines.push('Bare suppressions (no expiry — consider converting to acknowledgements):');
    for (const e of summary.bareSuppressions) {
      lines.push(`  • ${describeKey(e)} — ${e.reason}`);
    }
  }
  return lines.join('\n') + '\n';
}

function describeKey(e: IDoctorSuppressionEntry): string {
  return e.id ?? e.code ?? e.category ?? '(unknown)';
}
