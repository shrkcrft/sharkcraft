/**
 * Diagnostics suggest — pattern-match stderr against the diagnostics
 * registry and return the most likely diagnostic + next command.
 */
import { buildDiagnosticByCode, listDiagnostics, type IDiagnosticRegistryEntry } from './failure-diagnostics.ts';

export const DIAGNOSTICS_SUGGEST_SCHEMA = 'sharkcraft.diagnostics-suggest/v1';

export interface IDiagnosticsSuggestion {
  code: string;
  title: string;
  confidence: 'low' | 'medium' | 'high';
  matchedPattern: string;
  nextCommand: string;
  docsLink?: string;
}

export interface IDiagnosticsSuggestReport {
  schema: typeof DIAGNOSTICS_SUGGEST_SCHEMA;
  input: string;
  topSuggestion?: IDiagnosticsSuggestion;
  candidates: readonly IDiagnosticsSuggestion[];
}

interface IMatcher {
  code: string;
  patterns: readonly RegExp[];
}

const MATCHERS: readonly IMatcher[] = [
  { code: 'missing-sharkcraft-config', patterns: [/sharkcraft\.config\.ts.*not found/i, /no sharkcraft config/i, /missing sharkcraft folder/i] },
  { code: 'missing-node-modules', patterns: [/cannot find module/i, /MODULE_NOT_FOUND/i, /node_modules.*missing/i] },
  { code: 'pack-helper-missing', patterns: [/Export named .* not found/i, /helper .* missing/i, /symbol .* not exported/i] },
  { code: 'mcp-cache-miss', patterns: [/cache[-\s]?miss/i, /chunk .* not found/i, /briefId .* not found/i] },
  { code: 'adoption-checkpoint-stale', patterns: [/checkpoint.*stale/i, /adoption.*regenerate/i] },
  { code: 'unknown-command', patterns: [/Unknown command/i, /unknown subcommand/i] },
  { code: 'missing-template-variables', patterns: [/missing variable/i, /required variable/i, /template variable .* not provided/i] },
  { code: 'unsafe-path-refused', patterns: [/unsafe path/i, /refusing to write outside/i, /path traversal/i] },
  { code: 'failed-verification', patterns: [/verification (failed|command failed)/i, /typecheck failed/i, /tests failed/i] },
  { code: 'release-readiness-blocker', patterns: [/readiness.*blocker/i, /release.*not ready/i] },
  { code: 'plan-signature-mismatch', patterns: [/signature mismatch/i, /invalid plan signature/i, /unsigned plan/i] },
  { code: 'workflow-file-not-found', patterns: [/\.github\/workflows\/.*not found/i, /workflow file .* missing/i] },
];

function confidenceFromMatches(matches: number): IDiagnosticsSuggestion['confidence'] {
  if (matches >= 3) return 'high';
  if (matches >= 2) return 'medium';
  return 'low';
}

export function suggestDiagnostic(input: string): IDiagnosticsSuggestReport {
  const text = input ?? '';
  const registry = new Map<string, IDiagnosticRegistryEntry>();
  for (const e of listDiagnostics()) registry.set(e.code, e);
  const candidates: IDiagnosticsSuggestion[] = [];
  for (const m of MATCHERS) {
    const entry = registry.get(m.code);
    if (!entry) continue;
    let hits = 0;
    let matched = '';
    for (const p of m.patterns) {
      if (p.test(text)) {
        hits++;
        if (!matched) matched = p.source;
      }
    }
    if (hits === 0) continue;
    const built = buildDiagnosticByCode(entry.code, {});
    candidates.push({
      code: entry.code,
      title: built.problem,
      confidence: confidenceFromMatches(hits),
      matchedPattern: matched,
      nextCommand: built.nextCommand,
      ...(built.docsLink ? { docsLink: built.docsLink } : {}),
    });
  }
  candidates.sort((a, b) => {
    const order = { high: 3, medium: 2, low: 1 } as const;
    return order[b.confidence] - order[a.confidence];
  });
  return {
    schema: DIAGNOSTICS_SUGGEST_SCHEMA,
    input: text,
    ...(candidates[0] ? { topSuggestion: candidates[0] } : {}),
    candidates,
  };
}
