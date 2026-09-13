/**
 * Pack signature freshness inspector.
 *
 * Reports each discovered pack's signature state without ever computing or
 * faking HMAC. Freshness is read from THE pack-asset freshness authority
 * (`detectPackAssetFreshness`): content digests recorded at sign time, never an
 * mtime. Statuses:
 *
 *   present     — signed, and every recorded contribution file still has the
 *                 content that was signed (real HMAC validation happens in
 *                 pack-doctor / packs verify).
 *   stale       — signed, but a recorded contribution file changed since.
 *   unverified  — signed, but the signature records no content digest for some
 *                 file (signed before digests existed) — freshness NOT verified.
 *   missing     — manifest has no signature block.
 *
 * The check is deterministic, read-only, and never requires the pack secret.
 */
import * as nodePath from 'node:path';
import { describePackAssetFreshness, detectPackAssetFreshness } from './pack-asset-freshness.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PACK_SIGNATURE_STATUS_SCHEMA = 'sharkcraft.pack-signature-status/v1';

export enum PackSignatureStatusKind {
  Present = 'present',
  Stale = 'stale',
  Unverified = 'unverified',
  Missing = 'missing',
}

export interface IPackSignatureEntry {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly status: PackSignatureStatusKind;
  readonly signatureSignedAt?: string;
  readonly reason?: string;
  /** First contribution file whose content changed since signing (back-compat alias of `divergedFiles[0]`). */
  readonly newerContributionFile?: string;
  /**
   * @deprecated Freshness is content divergence, never age — no mtime is read
   * any more. Always absent.
   */
  readonly newerContributionMtime?: string;
  /** Every pack-relative file whose content differs from the signed record. */
  readonly divergedFiles?: readonly string[];
  /** Pack-relative files the signature holds no content digest for. */
  readonly unrecordedFiles?: readonly string[];
  readonly secretAvailable: boolean;
  readonly nextCommand?: string;
  /**
   * True when the pack's signature was produced by the dev/local
   * signing flow (`shrk packs sign --dev`). Dev signatures verify but are
   * NOT release-trusted; release apply paths reject them unless explicitly
   * allowed.
   */
  readonly dev?: boolean;
}

export interface IPackSignatureStatusReport {
  readonly schema: typeof PACK_SIGNATURE_STATUS_SCHEMA;
  readonly generatedAt: string;
  readonly packs: readonly IPackSignatureEntry[];
  readonly summary: {
    readonly total: number;
    readonly present: number;
    readonly stale: number;
    /** Signed packs whose freshness could not be verified (no content record). */
    readonly unverified: number;
    readonly missing: number;
    /** Packs whose latest signature is dev-only (subset of `present`). */
    readonly dev: number;
  };
  readonly secretAvailable: boolean;
  readonly nextCommands: readonly string[];
}

export function buildPackSignatureStatusReport(
  inspection: ISharkcraftInspection,
): IPackSignatureStatusReport {
  const secret = Boolean(process.env['SHARKCRAFT_PACK_SECRET']);
  const out: IPackSignatureEntry[] = [];

  for (const pack of inspection.packs.validPacks ?? []) {
    const rel = nodePath.relative(inspection.projectRoot, pack.packageRoot);
    const signCmd = secret ? `shrk packs sign ${rel}` : `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${rel}`;
    const sig = pack.manifest?.signature;
    if (!sig) {
      out.push({
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        packageRoot: pack.packageRoot,
        status: PackSignatureStatusKind.Missing,
        reason: 'no signature block on manifest',
        secretAvailable: secret,
        nextCommand: signCmd,
      });
      continue;
    }
    const freshness = detectPackAssetFreshness(pack);
    const said = describePackAssetFreshness(freshness).signature;
    const base = {
      packageName: pack.packageName,
      packageVersion: pack.packageVersion,
      packageRoot: pack.packageRoot,
      signatureSignedAt: sig.signedAt,
      secretAvailable: secret,
      ...(freshness.signature.diverged.length > 0
        ? { divergedFiles: freshness.signature.diverged, newerContributionFile: freshness.signature.diverged[0] }
        : {}),
      ...(freshness.signature.unrecorded.length > 0 ? { unrecordedFiles: freshness.signature.unrecorded } : {}),
    };
    if (freshness.signature.state === 'diverged' && sig.dev === true) {
      // Dev packs are signed with the well-known PACK_DEV_SECRET and load fine
      // locally — every local build re-stales them, so a standing "stale" is
      // pure noise during pack development. Keep them out of the stale bucket
      // (still counted under summary.dev) and soften the reason. Production
      // (non-dev) signed packs are untouched.
      out.push({
        ...base,
        status: PackSignatureStatusKind.Present,
        dev: true,
        reason: `dev signature re-staled by a local build ("${freshness.signature.diverged[0]}" changed since signing) — dev packs load fine locally; re-sign before release`,
      });
    } else if (freshness.signature.state === 'diverged') {
      out.push({
        ...base,
        status: PackSignatureStatusKind.Stale,
        ...(said ? { reason: said } : {}),
        nextCommand: signCmd,
      });
    } else if (freshness.signature.state === 'unrecorded') {
      out.push({
        ...base,
        status: PackSignatureStatusKind.Unverified,
        ...(said ? { reason: said } : {}),
        ...(sig.dev === true ? { dev: true } : {}),
        nextCommand: signCmd,
      });
    } else {
      out.push({
        ...base,
        status: PackSignatureStatusKind.Present,
        ...(sig.dev === true ? { dev: true } : {}),
      });
    }
  }
  return {
    schema: PACK_SIGNATURE_STATUS_SCHEMA,
    generatedAt: new Date().toISOString(),
    packs: out,
    summary: {
      total: out.length,
      present: out.filter((p) => p.status === PackSignatureStatusKind.Present).length,
      stale: out.filter((p) => p.status === PackSignatureStatusKind.Stale).length,
      unverified: out.filter((p) => p.status === PackSignatureStatusKind.Unverified).length,
      missing: out.filter((p) => p.status === PackSignatureStatusKind.Missing).length,
      dev: out.filter((p) => p.dev === true).length,
    },
    secretAvailable: secret,
    nextCommands: out
      .filter((p) => p.nextCommand)
      .map((p) => p.nextCommand!)
      .filter((c, i, a) => a.indexOf(c) === i),
  };
}

/**
 * Pack signature explanation. Surfaces the distinct lifecycle
 * states (`unsigned`, `stale`, `invalid`, `valid`, `present-unverified`,
 * `freshness-unverified`, `dev-signature`, `secret-missing`, `not-required`)
 * per pack with a one-line "why this matters".
 *
 * Read-only. Reads `inspection.packs.discoveredPacks[i].signatureStatus`
 * which already reflects the verifier's outcome when the inspector was
 * constructed with `verifyPackSignatures: true`.
 *
 * `valid` is reserved STRICTLY for a real HMAC pass (verifier === 'verified').
 * A pack whose signed content record still matches — but whose HMAC was not
 * checked this run — is `present-unverified`, never `valid`: freshness is not
 * verification.
 */
export type PackSignatureExplainState =
  | 'valid'
  | 'unsigned'
  | 'stale'
  | 'invalid'
  | 'present-unverified'
  | 'freshness-unverified'
  | 'dev-signature'
  | 'secret-missing'
  | 'not-required'
  | 'unknown';

export interface IPackSignatureExplainEntry {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly state: PackSignatureExplainState;
  readonly explanation: string;
  readonly nextCommand?: string;
}

export interface IPackSignatureExplainReport {
  readonly schema: 'sharkcraft.pack-signature-explain/v1';
  readonly generatedAt: string;
  readonly secretAvailable: boolean;
  readonly mode: 'required' | 'optional';
  readonly packs: readonly IPackSignatureExplainEntry[];
}

export interface IExplainPackSignatureStatusOptions {
  requireSignatures?: boolean;
}

export function explainPackSignatureStatus(
  inspection: ISharkcraftInspection,
  options: IExplainPackSignatureStatusOptions = {},
): IPackSignatureExplainReport {
  const secretAvailable = Boolean(process.env['SHARKCRAFT_PACK_SECRET']);
  const mode = options.requireSignatures ? 'required' : 'optional';
  const freshness = buildPackSignatureStatusReport(inspection);
  const freshnessByRoot = new Map(freshness.packs.map((p) => [p.packageRoot, p]));
  const out: IPackSignatureExplainEntry[] = [];

  for (const pack of inspection.packs.discoveredPacks ?? []) {
    const fresh = freshnessByRoot.get(pack.packageRoot);
    const verifier = pack.signatureStatus;
    const rel = nodePathRelative(inspection.projectRoot, pack.packageRoot);
    const signCmd = secretAvailable
      ? `shrk packs sign ${rel}`
      : `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${rel}`;
    let state: PackSignatureExplainState = 'unknown';
    let explanation = '';
    let nextCommand: string | undefined;
    if (verifier === 'verified') {
      state = 'valid';
      explanation = 'HMAC verified at inspection time.';
    } else if (verifier === 'invalid-signature') {
      state = 'invalid';
      explanation = 'Manifest signature failed HMAC verification — pack contents may have been tampered with.';
      nextCommand = 'shrk packs verify --required';
    } else if (verifier === 'dev-signature') {
      state = 'dev-signature';
      explanation =
        'Manifest carries a dev signature — verified only against the well-known public dev secret, NOT release-trusted. Re-sign with the release secret before publishing.';
      nextCommand = secretAvailable ? signCmd : 'shrk packs verify --required --allow-dev-signature';
    } else if (verifier === 'missing-signature' || (!verifier && fresh?.status === 'missing')) {
      state = 'unsigned';
      explanation = 'Manifest has no signature block.';
      nextCommand = signCmd;
    } else if (verifier === 'missing-secret' || (!verifier && !secretAvailable && fresh?.status !== 'present')) {
      state = 'secret-missing';
      explanation = 'SHARKCRAFT_PACK_SECRET is unset; cannot verify or re-sign in this session.';
      nextCommand = signCmd;
    } else if (fresh?.status === 'stale') {
      state = 'stale';
      explanation = `${fresh.reason ?? 'A contribution file changed since the signature was made.'}`;
      nextCommand = signCmd;
    } else if (fresh?.status === 'unverified') {
      state = 'freshness-unverified';
      explanation = `${fresh.reason ?? 'The signature records no content digests, so freshness is NOT verified.'}`;
      nextCommand = signCmd;
    } else if (fresh?.status === 'present') {
      // Freshness only — the HMAC was NOT checked this run. Reserve `valid`
      // strictly for a real verifier pass so a bogus-HMAC-but-fresh pack is
      // never mislabelled as verified.
      state = 'present-unverified';
      explanation =
        'Signature present and every contribution file still matches its signed content digest, but the HMAC was NOT checked this run.';
      nextCommand = 'shrk packs verify --required';
    } else {
      state = mode === 'required' ? 'unknown' : 'not-required';
      explanation = mode === 'required'
        ? 'Verifier did not run; rerun with --verify-signatures.'
        : 'Signatures are not required in this run.';
    }
    out.push({
      packageName: pack.packageName,
      packageVersion: pack.packageVersion,
      packageRoot: pack.packageRoot,
      state,
      explanation,
      ...(nextCommand ? { nextCommand } : {}),
    });
  }
  return {
    schema: 'sharkcraft.pack-signature-explain/v1',
    generatedAt: new Date().toISOString(),
    secretAvailable,
    mode,
    packs: out,
  };
}

function nodePathRelative(from: string, to: string): string {
  return nodePath.relative(from, to) || '.';
}
