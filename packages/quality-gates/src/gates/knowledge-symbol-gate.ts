import { loadGraphApiCached } from '@shrkcrft/graph';
import {
  buildKnowledgeStaleReport,
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
  if (broken.length === 0) {
    return {
      id: 'knowledge-symbol',
      label: 'Knowledge symbol refs',
      status: 'pass',
      message: `${evaluated} symbol/file reference(s) resolve.`,
      details: { evaluated, graphResolved: Boolean(graph) },
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
    details: { evaluated, broken: broken.length, samples, graphResolved: Boolean(graph) },
    nextCommands: ['shrk knowledge audit', 'shrk doctor'],
    durationMs: Date.now() - start,
  };
}
