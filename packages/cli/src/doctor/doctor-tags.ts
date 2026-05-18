/**
 * Doctor warning source + state tagging.
 *
 * The default `shrk doctor` render used to be a wall: every warning,
 * advisory or not, listed inline. Doctor folds advisory + acknowledged
 * warnings into a summary line so the default view shows only what's
 * actionable. `--show-advisory` (or `--strict`) restores the full view.
 *
 * The classifier is derived from the check id and severity — no upstream
 * inspector schema change. If a future inspector adds a real `source` /
 * `state` field, the helper can read it preferentially.
 */
import {
  DoctorSeverity,
  type IDoctorCheck,
  type IDoctorSuppressionEntry,
} from '@shrkcrft/inspector';

export enum DoctorSource {
  Local = 'local',
  Pack = 'pack',
  BuiltIn = 'built-in',
  Generated = 'generated',
  Legacy = 'legacy',
  Unknown = 'unknown',
}

export enum DoctorState {
  Blocker = 'blocker',
  Active = 'active',
  Advisory = 'advisory',
  Acknowledged = 'acknowledged',
  ExpiredAcknowledgement = 'expired-acknowledgement',
}

const SOURCE_PREFIX_MAP: ReadonlyArray<readonly [RegExp, DoctorSource]> = [
  [/^pack-/i, DoctorSource.Pack],
  [/^packs-/i, DoctorSource.Pack],
  [/^stale-pack-signature/i, DoctorSource.Pack],
  [/^generated-/i, DoctorSource.Generated],
  [/^legacy-/i, DoctorSource.Legacy],
  [/^config-/i, DoctorSource.BuiltIn],
  [/^self-config/i, DoctorSource.BuiltIn],
  [/^sharkcraft-folder/i, DoctorSource.BuiltIn],
  [/^runtime-/i, DoctorSource.BuiltIn],
  [/^actionhints-/i, DoctorSource.Local],
  [/^action-hint/i, DoctorSource.Local],
  [/^knowledge-/i, DoctorSource.Local],
  [/^template-/i, DoctorSource.Local],
  [/^rule(s)?-/i, DoctorSource.Local],
  [/^path(s)?-/i, DoctorSource.Local],
  [/^pipeline(s)?-/i, DoctorSource.Local],
  [/^boundar(y|ies)/i, DoctorSource.Local],
];

export function classifySource(check: IDoctorCheck): DoctorSource {
  for (const [re, src] of SOURCE_PREFIX_MAP) {
    if (re.test(check.id)) return src;
  }
  return DoctorSource.Unknown;
}

export interface IClassifyStateInput {
  /** Acknowledgement summary as produced by `summarizeAcknowledgements`. */
  readonly acknowledgements: ReadonlyArray<IDoctorSuppressionEntry>;
  /** Acknowledgements whose expiresAt is in the past. */
  readonly expiredAcknowledgements: ReadonlyArray<IDoctorSuppressionEntry>;
}

function suppressionMatches(
  check: IDoctorCheck,
  entry: IDoctorSuppressionEntry,
): boolean {
  if (entry.id && entry.id === check.id) return true;
  if (entry.code && entry.code === check.code) return true;
  if (entry.category && check.category && entry.category === check.category) return true;
  return false;
}

export function classifyState(
  check: IDoctorCheck,
  ack: IClassifyStateInput,
): DoctorState {
  // Expired acknowledgements take priority over the advisory tag — they
  // need attention.
  for (const e of ack.expiredAcknowledgements) {
    if (suppressionMatches(check, e)) return DoctorState.ExpiredAcknowledgement;
  }
  for (const a of ack.acknowledgements) {
    if (suppressionMatches(check, a)) return DoctorState.Acknowledged;
  }
  if (check.advisory === true) return DoctorState.Advisory;
  if (check.severity === DoctorSeverity.Error) return DoctorState.Blocker;
  if (check.severity === DoctorSeverity.Warning) return DoctorState.Active;
  // Info / Ok stay as Active for the purpose of folding (they're not
  // blockers but they're also not advisory).
  return DoctorState.Active;
}

export interface IDoctorTagged {
  readonly check: IDoctorCheck;
  readonly source: DoctorSource;
  readonly state: DoctorState;
}

export interface IDoctorFoldedView {
  /** Tagged checks in input order. */
  readonly tagged: ReadonlyArray<IDoctorTagged>;
  /** Checks the default render should show (blockers + active warnings). */
  readonly visible: ReadonlyArray<IDoctorTagged>;
  /** Checks folded into the summary line. */
  readonly folded: ReadonlyArray<IDoctorTagged>;
  /** Per-state counts for the summary line. */
  readonly counts: Readonly<Record<DoctorState, number>>;
}

export interface IFoldOptions {
  /** When true, every advisory/acknowledged check stays visible. Default false. */
  readonly showAdvisory?: boolean;
  /** When true, all checks regardless of state stay visible. Default false. */
  readonly showAll?: boolean;
  /** Acknowledgement payload for state classification. */
  readonly ack: IClassifyStateInput;
}

export function foldDoctorChecks(
  checks: ReadonlyArray<IDoctorCheck>,
  options: IFoldOptions,
): IDoctorFoldedView {
  const counts: Record<DoctorState, number> = {
    [DoctorState.Blocker]: 0,
    [DoctorState.Active]: 0,
    [DoctorState.Advisory]: 0,
    [DoctorState.Acknowledged]: 0,
    [DoctorState.ExpiredAcknowledgement]: 0,
  };
  const tagged: IDoctorTagged[] = [];
  const visible: IDoctorTagged[] = [];
  const folded: IDoctorTagged[] = [];

  const okSeverities = new Set<DoctorSeverity>([
    DoctorSeverity.Ok,
    DoctorSeverity.Info,
  ]);

  for (const check of checks) {
    const source = classifySource(check);
    const state = classifyState(check, options.ack);
    const entry: IDoctorTagged = { check, source, state };
    tagged.push(entry);
    counts[state] += 1;

    if (options.showAll) {
      visible.push(entry);
      continue;
    }
    // Always show OK / Info regardless of state (they're rendered as the
    // header strip in doctor output).
    if (okSeverities.has(check.severity)) {
      visible.push(entry);
      continue;
    }
    if (options.showAdvisory) {
      visible.push(entry);
      continue;
    }
    if (
      state === DoctorState.Advisory ||
      state === DoctorState.Acknowledged
    ) {
      folded.push(entry);
      continue;
    }
    visible.push(entry);
  }

  return { tagged, visible, folded, counts };
}

/** Render the one-line fold summary for the default doctor view. */
export function renderFoldedSummary(view: IDoctorFoldedView): string {
  const parts: string[] = [];
  if (view.counts[DoctorState.Advisory] > 0) {
    parts.push(`${view.counts[DoctorState.Advisory]} advisory`);
  }
  if (view.counts[DoctorState.Acknowledged] > 0) {
    parts.push(`${view.counts[DoctorState.Acknowledged]} acknowledged`);
  }
  if (view.counts[DoctorState.ExpiredAcknowledgement] > 0) {
    parts.push(
      `${view.counts[DoctorState.ExpiredAcknowledgement]} expired-acknowledgement`,
    );
  }
  if (parts.length === 0) return '';
  return `Folded: ${parts.join(', ')} (run with --show-advisory or --strict to expand)\n`;
}
