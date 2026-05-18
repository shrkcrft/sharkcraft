/**
 * Golden output tests.
 *
 * Compare current CLI output against stored normalized snapshots.
 * Timestamps, durations, temp dirs are stripped before comparison.
 *
 * Snapshots live under `examples/golden-output/<name>.txt`. Pass
 * `--update` to rewrite them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const GOLDEN_OUTPUT_SCHEMA = 'sharkcraft.golden-output/v1';

export interface IGoldenOutputCase {
  id: string;
  command: string;
  goldenFile: string;
}

export interface IGoldenOutputCompareResult {
  id: string;
  match: boolean;
  diff?: string;
  goldenPresent: boolean;
}

export interface IGoldenOutputReport {
  schema: typeof GOLDEN_OUTPUT_SCHEMA;
  generatedAt: string;
  cases: readonly IGoldenOutputCompareResult[];
  summary: { total: number; matches: number; mismatches: number; missing: number };
}

const DEFAULT_CASES: readonly IGoldenOutputCase[] = [
  { id: 'start-here', command: 'shrk start-here', goldenFile: 'examples/golden-output/start-here.txt' },
  { id: 'commands-primary', command: 'shrk commands primary', goldenFile: 'examples/golden-output/commands-primary.txt' },
  { id: 'brief-compact', command: 'shrk brief "general project work" --mode compact', goldenFile: 'examples/golden-output/brief-compact.txt' },
  { id: 'impact-text', command: 'shrk impact --since HEAD~1', goldenFile: 'examples/golden-output/impact-text.txt' },
  { id: 'release-readiness', command: 'shrk release readiness', goldenFile: 'examples/golden-output/release-readiness.txt' },
];

export function listGoldenCases(): readonly IGoldenOutputCase[] {
  return DEFAULT_CASES;
}

/**
 * Normalize an output blob so timestamps, durations, and absolute paths
 * don't cause spurious diffs.
 */
export function normalizeOutput(raw: string): string {
  return raw
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, '<ISO>')
    .replace(/\(\d+ms\)/g, '(<MS>)')
    .replace(/\b\d+\s*ms\b/g, '<MS>ms')
    .replace(/\/var\/folders\/[^\s]+/g, '<TMPDIR>')
    .replace(/\/tmp\/[^\s]+/g, '<TMPDIR>')
    .replace(/\/Users\/[^/\s]+\/[A-Za-z0-9._-]+/g, '<REPO>')
    .replace(/process \d+/g, 'process <PID>')
    .replace(/\b\d+\.\d+s\b/g, '<S>s');
}

function lineDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out: string[] = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      out.push(`@@ line ${i + 1}`);
      if (al[i] !== undefined) out.push(`- ${al[i]}`);
      if (bl[i] !== undefined) out.push(`+ ${bl[i]}`);
      if (out.length > 80) {
        out.push('… (truncated)');
        break;
      }
    }
  }
  return out.join('\n');
}

export function compareGoldenOutput(
  projectRoot: string,
  caseEntry: IGoldenOutputCase,
  currentOutput: string,
): IGoldenOutputCompareResult {
  const file = nodePath.join(projectRoot, caseEntry.goldenFile);
  const normalizedCurrent = normalizeOutput(currentOutput);
  if (!existsSync(file)) {
    return { id: caseEntry.id, match: false, goldenPresent: false };
  }
  const golden = normalizeOutput(readFileSync(file, 'utf8'));
  if (golden === normalizedCurrent) return { id: caseEntry.id, match: true, goldenPresent: true };
  return {
    id: caseEntry.id,
    match: false,
    goldenPresent: true,
    diff: lineDiff(golden, normalizedCurrent),
  };
}

export function writeGoldenOutput(
  projectRoot: string,
  caseEntry: IGoldenOutputCase,
  currentOutput: string,
): string {
  const file = nodePath.join(projectRoot, caseEntry.goldenFile);
  const normalized = normalizeOutput(currentOutput);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, normalized, 'utf8');
  return file;
}

export function summarizeGoldenResults(
  results: readonly IGoldenOutputCompareResult[],
): IGoldenOutputReport['summary'] {
  let matches = 0,
    mismatches = 0,
    missing = 0;
  for (const r of results) {
    if (!r.goldenPresent) missing++;
    else if (r.match) matches++;
    else mismatches++;
  }
  return { total: results.length, matches, mismatches, missing };
}
