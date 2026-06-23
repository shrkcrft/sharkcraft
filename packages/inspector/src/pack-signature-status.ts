/**
 * Pack signature freshness inspector.
 *
 * Reports each discovered pack's signature state without ever computing or
 * faking HMAC. Surfaces three statuses:
 *
 *   present       — manifest has a signature and the timestamp is >= any
 *                   contribution file mtime we can see (heuristic — real
 *                   HMAC validation happens in pack-doctor).
 *   stale         — manifest has a signature but at least one contribution
 *                   file has a newer mtime than the signature timestamp.
 *   missing       — manifest has no signature block.
 *
 * The check is deterministic, read-only, and never requires the pack secret.
 */
import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PACK_SIGNATURE_STATUS_SCHEMA = 'sharkcraft.pack-signature-status/v1';

export enum PackSignatureStatusKind {
  Present = 'present',
  Stale = 'stale',
  Missing = 'missing',
}

export interface IPackSignatureEntry {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly status: PackSignatureStatusKind;
  readonly signatureSignedAt?: string;
  readonly reason?: string;
  readonly newerContributionFile?: string;
  readonly newerContributionMtime?: string;
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
    readonly missing: number;
    /** Packs whose latest signature is dev-only (subset of `present`). */
    readonly dev: number;
  };
  readonly secretAvailable: boolean;
  readonly nextCommands: readonly string[];
}

const CONTRIB_SLOTS = [
  'knowledgeFiles',
  'ruleFiles',
  'pathFiles',
  'pathConventionFiles',
  'templateFiles',
  'pipelineFiles',
  'presetFiles',
  'boundaryFiles',
  'contextTestFiles',
  'agentTestFiles',
  'scaffoldPatternFiles',
  'policyCheckFiles',
  'constructFiles',
  'constructFacetFiles',
  'playbookFiles',
  'searchTuningFiles',
  'feedbackRuleFiles',
  'decisionFiles',
  'mcpToolFiles',
  'aiProviderFiles',
  'docsFiles',
  'contractTemplateFiles',
  'migrationProfileFiles',
  'conventionFiles',
  'helperFiles',
  'taskRoutingHintFiles',
] as const;

export function buildPackSignatureStatusReport(
  inspection: ISharkcraftInspection,
): IPackSignatureStatusReport {
  const secret = Boolean(process.env['SHARKCRAFT_PACK_SECRET']);
  const out: IPackSignatureEntry[] = [];

  for (const pack of inspection.packs.validPacks ?? []) {
    const sig = pack.manifest?.signature;
    if (!sig) {
      out.push({
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        packageRoot: pack.packageRoot,
        status: PackSignatureStatusKind.Missing,
        reason: 'no signature block on manifest',
        secretAvailable: secret,
        nextCommand: secret
          ? `shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`
          : `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`,
      });
      continue;
    }
    const sigMs = (() => {
      try {
        return new Date(sig.signedAt).getTime();
      } catch {
        return 0;
      }
    })();
    let newerFile: string | undefined;
    let newerMtime: string | undefined;
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
    for (const slot of CONTRIB_SLOTS) {
      const rels = contributions[slot];
      if (!rels) continue;
      for (const rel of rels) {
        const abs = nodePath.resolve(pack.packageRoot, rel);
        if (!existsSync(abs)) continue;
        try {
          const st = statSync(abs);
          if (st.mtimeMs > sigMs + 1000) {
            newerFile = rel;
            newerMtime = new Date(st.mtimeMs).toISOString();
            break;
          }
        } catch {
          continue;
        }
      }
      if (newerFile) break;
    }
    if (newerFile && sig.dev === true) {
      // Dev packs are signed with the well-known PACK_DEV_SECRET and load fine
      // locally unsigned/dev — every local `npm run build` re-stales them, so a
      // standing "stale" warning is pure noise during pack development. Keep
      // them out of the stale bucket (still counted under summary.dev) and
      // soften the reason. Production (non-dev) signed packs are untouched.
      out.push({
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        packageRoot: pack.packageRoot,
        status: PackSignatureStatusKind.Present,
        signatureSignedAt: sig.signedAt,
        secretAvailable: secret,
        dev: true,
        reason: `dev signature re-staled by a local build ("${newerFile}" newer) — dev packs load fine locally; re-sign before release`,
      });
    } else if (newerFile) {
      out.push({
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        packageRoot: pack.packageRoot,
        status: PackSignatureStatusKind.Stale,
        signatureSignedAt: sig.signedAt,
        reason: `contribution file "${newerFile}" mtime (${newerMtime}) is newer than signature (${sig.signedAt})`,
        newerContributionFile: newerFile,
        newerContributionMtime: newerMtime,
        secretAvailable: secret,
        nextCommand: secret
          ? `shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`
          : `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`,
      });
    } else {
      out.push({
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        packageRoot: pack.packageRoot,
        status: PackSignatureStatusKind.Present,
        signatureSignedAt: sig.signedAt,
        secretAvailable: secret,
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
 * states (`unsigned`, `stale`, `invalid`, `valid`, `secret-missing`,
 * `not-required`) per pack with a one-line "why this matters".
 *
 * Read-only. Reads `inspection.packs.discoveredPacks[i].signatureStatus`
 * which already reflects the verifier's outcome when the inspector was
 * constructed with `verifyPackSignatures: true`.
 */
export type PackSignatureExplainState =
  | 'valid'
  | 'unsigned'
  | 'stale'
  | 'invalid'
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
      explanation = `${fresh.reason ?? 'Signature is older than at least one contribution file.'}`;
      nextCommand = signCmd;
    } else if (fresh?.status === 'present') {
      state = 'valid';
      explanation = 'Signature timestamp is newer than every contribution file.';
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
