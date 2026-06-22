/**
 * Token-economics measurement for `shrk delegate` (Phase 2).
 *
 * Measures, per scenario, the tokens the EXPENSIVE orchestrator (Claude) pays:
 *   - BASELINE  (Claude does the mechanical edit itself): read the whole target
 *               file (context-in) + emit the edit (out).
 *   - DELEGATED (Claude hands it to the local worker): the compact delegate_task
 *               brief (out) + the compact delegate-run result envelope (back).
 * The worker's LOCAL generation tokens are FREE to Claude and excluded.
 *
 * Prints BOTH a real BPE count (gpt-tokenizer / cl100k_base — the standard proxy)
 * and the deterministic estimator, plus |est−real| on the baseline, so the
 * "% trustworthy, absolute counts rough" contract from docs/compression.md holds.
 * Degrades to estimate-only when the tokenizer isn't installed.
 *
 *   bun run scripts/delegate-token-eval.ts
 *
 * Read-only. No writes, no commits. A per-scenario token-flow measurement, NOT a
 * live agent session.
 */
import { compressMarkdown, estimateTokens, EContentType } from '../packages/compress/src/index.ts';

let real: (s: string) => number;
let tokenizer: 'real' | 'estimated';
try {
  const enc = (await import('gpt-tokenizer')) as { encode: (s: string) => number[] };
  real = (s: string): number => enc.encode(s).length;
  tokenizer = 'real';
} catch {
  real = (s: string): number => estimateTokens(s);
  tokenizer = 'estimated';
}

/** A barrel index with `n` re-export lines — the add-barrel-export target. */
function barrel(n: number): string {
  const lines: string[] = ['// Auto-generated barrel. Keep exports alphabetical.', ''];
  for (let i = 0; i < n; i += 1) lines.push(`export * from './module-${String(i).padStart(3, '0')}';`);
  lines.push('');
  return lines.join('\n');
}

/** The brief delegate_task hands back (mirrors delegate-task.tool.ts buildBriefMarkdown). */
function brief(task: string): string {
  const md = [
    '# Delegate brief: Add a re-export line to a barrel index',
    '',
    `**Task:** ${task}`,
    '',
    '**Recipe:** `add-barrel-export`',
    '**Allowed ops:** export, ensure-import',
    '**Guardrail globs (the worker may ONLY touch files matching these):** src/**/index.ts',
    '**Verification (must pass or the edit is reverted):** barrel-tsc',
    '**Provider:** auto',
    '',
    '## How to delegate',
    '',
    'The CLI is the only write path. Run the `next` command: the local worker generates the edit,',
    'the deterministic engine verifies it and auto-reverts on failure.',
  ].join('\n');
  return compressMarkdown(md, { query: task }).compressed;
}

/** The compact result envelope delegate-run --json returns. */
function resultEnvelope(): string {
  return JSON.stringify({
    status: 'applied',
    recipeId: 'add-barrel-export',
    message: 'applied + verified (1 file)',
    written: ['src/index.ts'],
    verification: { passed: true, commandsFailed: [] },
  });
}

/**
 * What Claude emits to perform the edit ITSELF (an Edit tool call): a few lines
 * of anchor context + the new export line. Independent of file size.
 */
function inlineEdit(newLine: string): string {
  return [
    'old_string:',
    "export * from './module-498';",
    "export * from './module-499';",
    'new_string:',
    "export * from './module-498';",
    "export * from './module-499';",
    newLine,
  ].join('\n');
}

interface IRow {
  scenario: string;
  baseReal: number;
  delReal: number;
  realPct: number;
  estPct: number;
  estErrBasePct: number;
}

const rows: IRow[] = [];
const task = "re-export './health' from the service barrel";
const newLine = "export * from './health';";

for (const n of [20, 100, 400]) {
  const file = barrel(n);
  // Baseline: read the whole file + emit the edit.
  const baselineText = file + '\n' + inlineEdit(newLine);
  // Delegated: the brief out + the compact result back.
  const briefText = brief(task);
  const delegatedText = briefText + '\n' + resultEnvelope();

  const baseReal = real(baselineText);
  const delReal = real(delegatedText);
  const baseEst = estimateTokens(file, EContentType.SourceCode) + estimateTokens(inlineEdit(newLine), EContentType.SourceCode);
  const delEst = estimateTokens(briefText, EContentType.Markdown) + estimateTokens(resultEnvelope(), EContentType.Json);

  rows.push({
    scenario: `barrel ${n} exports`,
    baseReal,
    delReal,
    realPct: baseReal > 0 ? Math.round((1 - delReal / baseReal) * 100) : 0,
    estPct: baseEst > 0 ? Math.round((1 - delEst / baseEst) * 100) : 0,
    estErrBasePct: baseReal > 0 ? Math.round((Math.abs(baseEst - baseReal) / baseReal) * 100) : 0,
  });
}

console.log(`\nDelegate token economics — tokens CLAUDE pays (tokenizer: ${tokenizer})\n`);
console.log('scenario             baseline   delegated   saved%   est-saved%   |est-real| on baseline');
console.log('-------------------- ---------- ----------- -------- ------------ -----------------------');
for (const r of rows) {
  console.log(
    `${r.scenario.padEnd(20)} ${String(r.baseReal).padStart(9)} ${String(r.delReal).padStart(11)} ${(r.realPct + '%').padStart(7)} ${(r.estPct + '%').padStart(11)} ${(r.estErrBasePct + '%').padStart(22)}`,
  );
}
console.log(
  '\nNote: the worker\'s LOCAL generation tokens are free to Claude and excluded.\n' +
    'Savings scale with the size of the file Claude would otherwise read. The % is the\n' +
    'trustworthy figure (per docs/compression.md); absolute counts are approximate when\n' +
    'tokenizer=estimated. This is a per-scenario token-flow measurement, not a live session.\n',
);
