/**
 * Three-way merge preview for adoption patches.
 *
 * Inputs (the three "sides"):
 *   - base: the file hash recorded in adoption-state.json
 *   - current: the file content on disk right now
 *   - proposed: the append block from the adoption patch
 *
 * Output: a verdict per target — safe | probably-safe | stale-target |
 * stale-draft | manual-review | create-file-safe | conflict.
 *
 * This is read-only. It never writes or mutates the target.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IAdoptionStateFile } from './adoption-state.ts';

export enum ThreeWayVerdict {
  Safe = 'safe',
  ProbablySafe = 'probably-safe',
  StaleTarget = 'stale-target',
  StaleDraft = 'stale-draft',
  ManualReview = 'manual-review',
  CreateFileSafe = 'create-file-safe',
  Conflict = 'conflict',
}

export interface IThreeWayPreviewInput {
  /** Project root. Used to read the current file content. */
  projectRoot: string;
  /** Target relative to projectRoot. */
  relativePath: string;
  /** The base hash recorded in adoption-state (the hash captured when the
   *  patch was rendered). For create-file hunks this is "(missing)". */
  baseHash: string;
  /** Optional append-block body. When provided, we can check whether the
   *  append-block contents already exist in the file (the patch would be a
   *  no-op) or whether they conflict with existing content. */
  appendBlock?: string;
  /** If the draft for this target changed since the state was written, the
   *  patch is also stale. Caller computes this from the draft-file diff. */
  draftChangedSinceState?: boolean;
}

export interface IThreeWayPreviewResult {
  relativePath: string;
  verdict: ThreeWayVerdict;
  reasons: readonly string[];
  /** Whether the file is currently present on disk. */
  targetExists: boolean;
  /** Whether the current file hash equals the recorded base hash. */
  targetUnchanged: boolean;
  /** When appendBlock is provided: whether the file already contains it. */
  alreadyApplied: boolean;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Detect whether the file already ends with (a non-trivial chunk of) the
 *  append block. Used to flag "patch already applied" rather than "conflict". */
function endsWith(content: string, fragment: string): boolean {
  // The fragment may have leading/trailing whitespace that's not in the file.
  // Compare on trimmed content vs trimmed fragment, and also check raw EOF.
  if (fragment.length === 0) return false;
  if (content.endsWith(fragment)) return true;
  const t = content.trimEnd();
  const f = fragment.trimEnd();
  return t.endsWith(f);
}

/** Whether the file already contains *every* line of the fragment (probably
 *  applied in a different order or with reformatting). */
function containsAllLines(content: string, fragment: string): boolean {
  const lines = fragment.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  for (const l of lines) {
    if (!content.includes(l)) return false;
  }
  return true;
}

export function previewThreeWay(input: IThreeWayPreviewInput): IThreeWayPreviewResult {
  const full = nodePath.resolve(input.projectRoot, input.relativePath);
  const exists = existsSync(full);
  const reasons: string[] = [];

  // Case A: the patch was a "create file" — base hash is the sentinel.
  if (input.baseHash === '(missing)') {
    if (!exists) {
      return {
        relativePath: input.relativePath,
        verdict: ThreeWayVerdict.CreateFileSafe,
        reasons: ['target file does not exist; create-file hunk is safe'],
        targetExists: false,
        targetUnchanged: true,
        alreadyApplied: false,
      };
    }
    // The file now exists where it didn't at plan-time. That's a stale-target.
    return {
      relativePath: input.relativePath,
      verdict: ThreeWayVerdict.StaleTarget,
      reasons: ['target file was created after the patch was generated'],
      targetExists: true,
      targetUnchanged: false,
      alreadyApplied: false,
    };
  }

  if (!exists) {
    return {
      relativePath: input.relativePath,
      verdict: ThreeWayVerdict.StaleTarget,
      reasons: ['target file was deleted after the patch was generated'],
      targetExists: false,
      targetUnchanged: false,
      alreadyApplied: false,
    };
  }

  const body = readFileSync(full, 'utf8');
  const currentHash = sha256(body);
  const targetUnchanged = currentHash === input.baseHash;
  let alreadyApplied = false;

  if (input.appendBlock) {
    alreadyApplied = endsWith(body, input.appendBlock) || containsAllLines(body, input.appendBlock);
  }

  if (alreadyApplied) {
    reasons.push('the append block already appears in the target — patch is a no-op');
  }
  if (input.draftChangedSinceState) {
    reasons.push('source draft changed after the patch was generated');
  }

  // Case B: target hash unchanged → safe.
  if (targetUnchanged) {
    if (input.draftChangedSinceState) {
      return {
        relativePath: input.relativePath,
        verdict: ThreeWayVerdict.StaleDraft,
        reasons,
        targetExists: true,
        targetUnchanged: true,
        alreadyApplied,
      };
    }
    return {
      relativePath: input.relativePath,
      verdict: alreadyApplied ? ThreeWayVerdict.ManualReview : ThreeWayVerdict.Safe,
      reasons:
        reasons.length === 0
          ? ['target file unchanged since the patch was generated']
          : reasons,
      targetExists: true,
      targetUnchanged: true,
      alreadyApplied,
    };
  }

  // Case C: target changed. If the append block is present, the patch was
  // already applied — manual review (or no-op).
  if (alreadyApplied) {
    return {
      relativePath: input.relativePath,
      verdict: ThreeWayVerdict.ManualReview,
      reasons: ['target changed since the patch was generated, but the append block is present'],
      targetExists: true,
      targetUnchanged: false,
      alreadyApplied: true,
    };
  }

  // Case D: target changed but the file still ends with content (i.e. the
  // file wasn't truncated to empty). For an append-only patch with a small
  // context window, git apply may still work — call it "probably-safe".
  if (body.trimEnd().length > 0) {
    return {
      relativePath: input.relativePath,
      verdict: ThreeWayVerdict.ProbablySafe,
      reasons: ['target changed since the patch was generated; review before applying'],
      targetExists: true,
      targetUnchanged: false,
      alreadyApplied: false,
    };
  }

  // Case E: target became empty or unrecognisable.
  return {
    relativePath: input.relativePath,
    verdict: ThreeWayVerdict.ManualReview,
    reasons: ['target file is empty or unrecognisable — re-render patch'],
    targetExists: true,
    targetUnchanged: false,
    alreadyApplied: false,
  };
}

export interface IThreeWayPreviewBatchResult {
  perTarget: readonly IThreeWayPreviewResult[];
  summary: Record<ThreeWayVerdict, number>;
}

export function previewThreeWayBatch(
  projectRoot: string,
  targets: readonly IAdoptionStateFile[],
  options: { draftsChanged?: boolean } = {},
): IThreeWayPreviewBatchResult {
  const perTarget = targets.map((t) =>
    previewThreeWay({
      projectRoot,
      relativePath: t.relativePath,
      baseHash: t.hash,
      ...(options.draftsChanged ? { draftChangedSinceState: true } : {}),
    }),
  );
  const summary: Record<ThreeWayVerdict, number> = {
    [ThreeWayVerdict.Safe]: 0,
    [ThreeWayVerdict.ProbablySafe]: 0,
    [ThreeWayVerdict.StaleTarget]: 0,
    [ThreeWayVerdict.StaleDraft]: 0,
    [ThreeWayVerdict.ManualReview]: 0,
    [ThreeWayVerdict.CreateFileSafe]: 0,
    [ThreeWayVerdict.Conflict]: 0,
  };
  for (const r of perTarget) summary[r.verdict] += 1;
  return { perTarget, summary };
}
