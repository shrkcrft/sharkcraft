import { coverageShortfall, type IVerdictCoverage } from '@shrkcrft/core';
import { loadGraphApiCached } from '@shrkcrft/graph';
import {
  buildKnowledgeStaleReport,
  declaredReferenceCoverage,
  ReferenceCheckOutcome,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import type { IGateResult } from '../schema/quality-gate.ts';

/** Reference kinds this gate is responsible for (symbol-ref integrity). */
const SCOPED_REF_KINDS = new Set<string>(['symbol', 'file']);

export interface IKnowledgeSymbolGateOptions {
  /**
   * Pre-loaded inspection (knowledge entries + project root). Loading the
   * inspection is async, so the caller (the gate command) builds it and
   * injects it here. The gate is skipped when omitted.
   */
  inspection?: ISharkcraftInspection;
  /** Restrict to entries whose references touch one of these changed files. */
  changedFiles?: readonly string[];
  /**
   * When true (default), a moved / renamed / missing symbol or file ref fails
   * the gate; otherwise it warns.
   */
  failOnStale?: boolean;
}

/**
 * Knowledge symbol-ref integrity gate. Walks every knowledge entry's symbol
 * and file references and verifies each still resolves. Resolution is
 * graph-backed: when the code graph is indexed it is passed to the stale-check
 * so a *moved* symbol (now declared in a different file) is detected as stale
 * rather than silently passing — single-file AST cannot see that. Skipped when
 * no inspection is supplied or there are no symbol/file references in scope.
 */
export function knowledgeSymbolGate(
  projectRoot: string,
  options: IKnowledgeSymbolGateOptions = {},
): IGateResult {
  const start = Date.now();
  const inspection = options.inspection;
  if (!inspection) {
    return {
      id: 'knowledge-symbol',
      label: 'Knowledge symbol refs',
      status: 'skipped',
      message: 'Skipped — no knowledge inspection supplied.',
      durationMs: Date.now() - start,
    };
  }
  if (inspection.knowledgeEntries.length === 0) {
    return {
      id: 'knowledge-symbol',
      label: 'Knowledge symbol refs',
      status: 'skipped',
      message: 'No knowledge entries — nothing to verify.',
      durationMs: Date.now() - start,
    };
  }

  // Graph-resolved when available; null falls the stale-check back to AST.
  const graph = loadGraphApiCached(projectRoot) ?? undefined;
  const report = buildKnowledgeStaleReport(inspection, {
    ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
    ...(graph ? { graph } : {}),
  });

  const scoped = report.referenceChecks.filter((c) => SCOPED_REF_KINDS.has(c.reference.kind));
  const evaluated = scoped.length;
  if (evaluated === 0) {
    return {
      id: 'knowledge-symbol',
      label: 'Knowledge symbol refs',
      status: 'skipped',
      message: 'No symbol/file references in scope — nothing evaluated.',
      details: { evaluated: 0, graphResolved: Boolean(graph) },
      durationMs: Date.now() - start,
    };
  }

  const broken = scoped.filter(
    (c) =>
      c.outcome === ReferenceCheckOutcome.Stale || c.outcome === ReferenceCheckOutcome.Missing,
  );
  // THE declared-reference fold (`declaredReferenceCoverage`) — the one the
  // stale-check's own verdict settles on — restricted to this gate's kinds.
  // Only a CHECKED reference counts as examined: an `unknown` one (unpinned,
  // ambiguous, a file that failed to read) is neither resolving nor broken,
  // and a malformed one was never checked. This gate used to count both as
  // "resolve" and PASS where `shrk knowledge stale-check` exits 2.
  const refCoverage: IVerdictCoverage = { ...declaredReferenceCoverage({ references: scoped }), subject: 'knowledge-symbol' };
  const gateCoverage: readonly IVerdictCoverage[] = [refCoverage];
  const ok = scoped.filter((c) => c.outcome === ReferenceCheckOutcome.Ok).length;
  const unknown = scoped.filter((c) => c.outcome === ReferenceCheckOutcome.Unknown).length;
  const invalid = scoped.filter((c) => c.outcome === ReferenceCheckOutcome.Invalid).length;
  const tally =
    `${ok} of ${evaluated} symbol/file reference(s) resolve` +
    (unknown > 0 ? `; ${unknown} could not be verified (unpinned, ambiguous or unreadable)` : '') +
    (invalid > 0 ? `; ${invalid} malformed` : '');
  // This gate is scoped to symbol/file references, so its pass says nothing
  // about entries that declare none — name them instead of letting "N resolve"
  // read as "the corpus is healthy". (`shrk knowledge stale-check` gates them.)
  const coverage = report.coverage;
  const unverifiableNote =
    coverage.unverifiable > 0
      ? `; ${coverage.unverifiable} of ${coverage.entriesInScope} entries unverifiable (no checkable reference — see \`shrk knowledge stale-check\`)`
      : '';
  if (broken.length === 0) {
    const shortfall = coverageShortfall(refCoverage);
    if (shortfall !== undefined) {
      // Nothing broken among what was checked, but not everything asked for
      // was checked: NOT VERIFIED — `shrk gate` settles it to 2 through the
      // coverage below, as `knowledge stale-check` does.
      return {
        id: 'knowledge-symbol',
        label: 'Knowledge symbol refs',
        status: 'warn',
        message: `NOT VERIFIED — ${shortfall}. ${tally}${unverifiableNote}. This is not a pass.`,
        details: { evaluated, ok, unknown, invalid, graphResolved: Boolean(graph), coverage, shortfalls: [shortfall] },
        coverage: gateCoverage,
        nextCommands: ['shrk knowledge stale-check'],
        durationMs: Date.now() - start,
      };
    }
    return {
      id: 'knowledge-symbol',
      label: 'Knowledge symbol refs',
      status: 'pass',
      message: `${tally}${unverifiableNote}.`,
      details: { evaluated, ok, unknown, invalid, graphResolved: Boolean(graph), coverage },
      coverage: gateCoverage,
      durationMs: Date.now() - start,
    };
  }

  const samples = broken.slice(0, 8).map((c) => {
    const target = c.reference.symbol
      ? `symbol \`${c.reference.symbol}\``
      : (c.reference.path ?? '?');
    const where = c.reference.path && c.reference.symbol ? ` (${c.reference.path})` : '';
    return `${c.entryId}: ${target}${where} — ${c.message}`;
  });
  const failOnStale = options.failOnStale ?? true;
  return {
    id: 'knowledge-symbol',
    label: 'Knowledge symbol refs',
    status: failOnStale ? 'fail' : 'warn',
    message: `${broken.length}/${evaluated} symbol/file reference(s) stale or missing (moved/renamed).`,
    details: { evaluated, broken: broken.length, ok, unknown, invalid, samples, graphResolved: Boolean(graph) },
    coverage: gateCoverage,
    nextCommands: ['shrk knowledge audit', 'shrk doctor'],
    durationMs: Date.now() - start,
  };
}
