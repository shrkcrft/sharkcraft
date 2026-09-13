import { describeInspectionDiscovery } from './inspection-discovery.ts';
import { buildKnowledgeStaleReport } from './knowledge-stale.ts';
import {
  evaluateKnowledgeStaleGate,
  formatPct,
  knowledgeStaleGateInput,
  settleKnowledgeStaleGate,
} from './knowledge-stale-gate.ts';
import type { IQualityGateResult } from './quality-report.ts';
import { warmReferenceRegistries } from './reference-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** The quality-bundle gate id of the knowledge stale-check. */
export const KNOWLEDGE_STALE_GATE_ID = 'knowledge-stale';

/** Unverifiable entry ids carried in the gate's data (the verb's JSON has all of them). */
const UNVERIFIABLE_IDS_SHOWN = 20;

/**
 * The knowledge stale-check as ONE quality gate — decided by THE gate the verb
 * settles (`evaluateKnowledgeStaleGate` + `settleKnowledgeStaleGate`), with the
 * config's `knowledgeCheck` block standing in for the verb's flags.
 *
 * `buildQualityReport` pushes it for every consumer (MCP `get_quality_report`,
 * the dashboard, the report site), and `shrk quality` maps this same row onto
 * its bundle item instead of re-deriving it — so the MCP report can no longer
 * read `pass` over a stale corpus `shrk quality` fails.
 *
 *   - an empty corpus, or a changeset no entry references → a DELIBERATE skip
 *     (`examinedNothing`, non-blocking; `data.skip` names which);
 *   - a request that can never be evaluated as configured, or a throw →
 *     `executed: false` (never a pass);
 *   - settled 1 → blocking failure; settled 2 → `data.partial` (NOT VERIFIED);
 *     settled 0 → pass.
 *
 * `data.settledExit` carries the settled exit so the CLI item's status is the
 * repro command's exit, by construction.
 */
export async function knowledgeStaleQualityGate(
  inspection: ISharkcraftInspection,
  changedFiles?: readonly string[],
): Promise<IQualityGateResult> {
  const base = { id: KNOWLEDGE_STALE_GATE_ID, label: 'Knowledge stale-check', runsShell: false } as const;
  const discovery = describeInspectionDiscovery(inspection);
  // A knowledge file that failed to load is never a deliberate skip — the
  // corpus is partial (or gone), and the gate says so.
  const loadFailed = discovery.knowledgeLoadFailures.length > 0;
  if (inspection.knowledgeEntries.length === 0 && !loadFailed) {
    return {
      ...base,
      passed: true,
      blocking: false,
      executed: true,
      notes: ['no knowledge entries declared — nothing to check'],
      data: { examinedNothing: true, skip: 'empty-corpus' },
    };
  }
  try {
    // A bare warm keeps any command resolver a CLI caller already injected.
    await warmReferenceRegistries(inspection);
    const report = buildKnowledgeStaleReport(inspection, changedFiles ? { changedFiles } : {});
    if (changedFiles && report.entriesInScope === 0 && !loadFailed) {
      return {
        ...base,
        passed: true,
        blocking: false,
        executed: true,
        notes: ['no knowledge entry references the changeset'],
        data: { examinedNothing: true, skip: 'out-of-changeset' },
      };
    }
    const gateInput = knowledgeStaleGateInput({
      flags: {},
      knowledgeCheck: inspection.config?.knowledgeCheck,
      discovery,
      scoped: changedFiles !== undefined,
    });
    if (gateInput.usageProblem) {
      return {
        ...base,
        passed: false,
        blocking: false,
        executed: false,
        notes: [`could not run as configured: ${gateInput.usageProblem}`],
      };
    }
    const gate = evaluateKnowledgeStaleGate(report, gateInput);
    const settled = settleKnowledgeStaleGate(gate);
    const c = report.coverage;
    const share = c.entriesInScope > 0 ? formatPct(c.unverifiable / c.entriesInScope) : '0%';
    return {
      ...base,
      // 1 fails; 2 "passed" over PART of its scope (`partial`), which the one
      // classification (`examineQualityGate`) reads as unexamined — never a pass.
      passed: settled.exit !== 1,
      blocking: true,
      executed: true,
      notes: [
        `entries in scope ${c.entriesInScope} · verified ${c.verified} · stale ${c.stale} · unverifiable ${c.unverifiable} (${share})`,
        ...gate.reasons,
        ...settled.shortfalls.map((s) => `NOT VERIFIED — ${s}`),
        ...settled.accepted,
      ],
      data: {
        coverage: c,
        unverifiableIds: report.unverifiableIds.slice(0, UNVERIFIABLE_IDS_SHOWN),
        failureCounts: report.failureCounts,
        settledExit: settled.exit,
        shortfalls: settled.shortfalls,
        ...(settled.exit === 2 ? { partial: true } : {}),
      },
    };
  } catch (e) {
    return {
      ...base,
      passed: false,
      blocking: false,
      executed: false,
      notes: [`could not run: ${(e as Error).message}`],
    };
  }
}
