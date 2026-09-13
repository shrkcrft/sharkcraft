/**
 * THE knowledge stale-check verdict now lives in `@shrkcrft/inspector`
 * (`knowledge-stale-gate.ts`), so `buildQualityReport` — MCP
 * `get_quality_report`, the dashboard, the report site — settles the SAME gate
 * as `shrk knowledge stale-check` and `shrk quality` (round 11 review: the MCP
 * report had no knowledge gate at all). Re-exported here so every CLI import
 * stays unchanged; there is no second implementation.
 */
export {
  evaluateKnowledgeStaleGate,
  formatPct,
  KNOWLEDGE_FAIL_ON_CATEGORIES,
  knowledgeStaleGateInput,
  knowledgeStaleWindowProblem,
  parseMinReferenced,
  settleKnowledgeStaleGate,
} from '@shrkcrft/inspector';
