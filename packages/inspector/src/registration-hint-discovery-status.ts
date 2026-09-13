/**
 * What a registration hint's discovery found on the live file system — the
 * same answer `registrations preview` acts on.
 *
 * A doctor's "0 issues" used to be read as "every hint verified", while glob
 * discovery was never checked at all: the hints whose author was LEAST sure of
 * the target got the LEAST verification.
 */
export enum RegistrationHintDiscoveryStatus {
  /** Exactly one target file (a fixed `targetFile` that exists, or a glob matching one file). */
  Verified = 'verified',
  /** A glob matched more than one file — preview refuses to guess. */
  Ambiguous = 'ambiguous',
  /** No file: a missing fixed target, a glob matching nothing, or no discovery at all. */
  Dead = 'dead',
  /** The discovery walk hit its directory cap, so the candidate set is incomplete. */
  Unverified = 'unverified',
  /**
   * No file yet, and every selector that matched nothing is marked
   * `{ pattern, expectEmpty: true }` (round 13): the hint targets what the
   * adopting app does not have yet — accepted (printed), never `dead`.
   */
  IntendedEmpty = 'intended-empty',
}
