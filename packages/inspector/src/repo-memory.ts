/**
 * Repository memory.
 *
 * Build a local-only index of historical signals from .sharkcraft/ artefacts
 * (sessions, reports, bundles, plans, validations, smoke, policy, etc.).
 * Pure local — no network, no telemetry, no embeddings, no model calls.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REPO_MEMORY_SCHEMA = 'sharkcraft.memory/v1';

export interface IMemoryFileEntry {
  path: string;
  touchCount: number;
  conflictCount: number;
  failedValidationCount: number;
  warningCount: number;
}

export interface IMemoryDiagnosticEntry {
  code: string;
  count: number;
  lastSeen?: string;
}

export interface IMemoryPlaybookEntry {
  id: string;
  successCount: number;
  failureCount: number;
}

export interface IMemoryConstructEntry {
  id: string;
  weight: number;
  lastSeen?: string;
}

export interface ILanguageHotspot {
  language: string;
  fileCount: number;
  totalWeight: number;
  topFiles: readonly string[];
}

export interface ILanguageRiskTrendEntry {
  language: string;
  trend: 'rising' | 'stable' | 'falling' | 'unknown';
  weight: number;
}

export interface IRepositoryMemoryIndex {
  schema: typeof REPO_MEMORY_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  sourceCount: number;
  scannedDirs: readonly string[];
  files: readonly IMemoryFileEntry[];
  diagnostics: readonly IMemoryDiagnosticEntry[];
  plansWithConflicts: readonly string[];
  boundaryViolationsRecurring: readonly string[];
  policyViolationsRecurring: readonly string[];
  releaseBlockers: readonly string[];
  packIssues: readonly string[];
  failedValidationCommands: readonly string[];
  slowValidationCommands: readonly { command: string; durationMs: number }[];
  recentTaskTypes: readonly string[];
  playbooks: readonly IMemoryPlaybookEntry[];
  highRiskConstructs: readonly IMemoryConstructEntry[];
  warnings: readonly string[];
  notes: readonly string[];
  /** Language-aware tagging. */
  languageByFile?: Readonly<Record<string, string>>;
  riskyFilesByLanguage?: Readonly<Record<string, readonly string[]>>;
  diagnosticsByLanguage?: Readonly<Record<string, readonly string[]>>;
  boundaryViolationsByLanguage?: Readonly<Record<string, readonly string[]>>;
  validationFailuresByLanguage?: Readonly<Record<string, readonly string[]>>;
  planConflictsByLanguage?: Readonly<Record<string, readonly string[]>>;
  languageHotspots?: readonly ILanguageHotspot[];
  languageRiskTrend?: readonly ILanguageRiskTrendEntry[];
}

export interface IMemoryRiskReport {
  schema: typeof REPO_MEMORY_SCHEMA;
  task: string;
  generatedAt: string;
  recommendation: 'no-memory' | 'no-overlap' | 'overlap-weak' | 'overlap-strong';
  matchedFiles: readonly IMemoryFileEntry[];
  matchedDiagnostics: readonly IMemoryDiagnosticEntry[];
  matchedConstructs: readonly IMemoryConstructEntry[];
  notes: readonly string[];
}

const MEMORY_DIR = nodePath.join('.sharkcraft', 'memory');
const INDEX_FILE = nodePath.join(MEMORY_DIR, 'index.json');

/** Heuristic language tagging by path extension. Returns undefined if unknown. */
function languageForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  return undefined;
}

/** Heuristic language tagging by diagnostic code prefix. */
function languageForDiagnosticCode(code: string): string | undefined {
  const lower = code.toLowerCase();
  if (lower.startsWith('ts.') || lower.includes('typescript')) return 'typescript';
  if (lower.startsWith('java.')) return 'java';
  if (lower.startsWith('cs.') || lower.startsWith('csharp.')) return 'csharp';
  if (lower.startsWith('py.') || lower.startsWith('python.')) return 'python';
  if (lower.startsWith('go.')) return 'go';
  if (lower.startsWith('rust.')) return 'rust';
  return undefined;
}

/** Heuristic language tagging by boundary rule id. */
function languageForRuleId(id: string): string | undefined {
  return languageForDiagnosticCode(id);
}

/** Heuristic language tagging from a validation command string. */
function languageForValidationCommand(cmd: string): string | undefined {
  if (/(^|\s)tsc\b/.test(cmd) || /\bbun\s+test\b/.test(cmd) || /\bnpm\s+test\b/.test(cmd) || /\bpnpm\s+test\b/.test(cmd)) return 'typescript';
  if (/\bmvn\b|\bgradle\b|\bgradlew\b/.test(cmd)) return 'java';
  if (/\bdotnet\b/.test(cmd)) return 'csharp';
  if (/\bpytest\b|\bmypy\b|\bruff\b|\bpython\s/.test(cmd)) return 'python';
  if (/\bgo\s+(test|vet|build)\b/.test(cmd)) return 'go';
  if (/\bcargo\b/.test(cmd)) return 'rust';
  return undefined;
}

const SOURCE_DIRS = [
  '.sharkcraft/sessions',
  '.sharkcraft/reports',
  '.sharkcraft/bundles',
  '.sharkcraft/plans',
];

interface IFileAccumulator {
  touchCount: number;
  conflictCount: number;
  failedValidationCount: number;
  warningCount: number;
}

function walkJsonFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(nodePath.join(cur, e));
      continue;
    }
    if (!st.isFile()) continue;
    if (!cur.endsWith('.json') && !cur.endsWith('.md')) continue;
    out.push(cur);
  }
  return out;
}

function safeReadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bumpFile(map: Map<string, IFileAccumulator>, file: string): IFileAccumulator {
  const cur = map.get(file) ?? {
    touchCount: 0,
    conflictCount: 0,
    failedValidationCount: 0,
    warningCount: 0,
  };
  map.set(file, cur);
  return cur;
}

function normalizeFileKey(file: string): string {
  return file.replace(/\\/g, '/');
}

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}

function extractFilesFromAny(node: unknown, sink: (file: string) => void): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (/[a-z0-9_.-]+\/[a-z0-9_.\-/]+\.(ts|tsx|js|jsx|md|json)/i.test(node)) sink(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) extractFilesFromAny(v, sink);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (
        k === 'file' ||
        k === 'relativePath' ||
        k === 'path' ||
        k === 'target' ||
        k === 'source'
      ) {
        if (typeof v === 'string') sink(v);
      }
      extractFilesFromAny(v, sink);
    }
  }
}

function extractTaskFromName(file: string): string | undefined {
  // .sharkcraft/sessions/<ts>-<slug>/...
  const m = file.match(/sessions\/[^/]+\/?/);
  if (m) return m[0];
  return undefined;
}

export async function buildRepositoryMemory(
  inspection: ISharkcraftInspection,
): Promise<IRepositoryMemoryIndex> {
  const root = inspection.projectRoot;
  const scannedDirs: string[] = [];
  const files = new Map<string, IFileAccumulator>();
  const diagnostics = new Map<string, { count: number; lastSeen?: string }>();
  const plansWithConflicts: string[] = [];
  const boundaryViolations = new Map<string, number>();
  const policyViolations = new Map<string, number>();
  const releaseBlockers: string[] = [];
  const packIssues: string[] = [];
  const failedValidationCommands: string[] = [];
  const slowValidationCommands: { command: string; durationMs: number }[] = [];
  const recentTaskTypes: string[] = [];
  const playbooks = new Map<string, { successCount: number; failureCount: number }>();
  const constructs = new Map<string, { weight: number; lastSeen?: string }>();
  const warnings: string[] = [];

  let sourceCount = 0;
  for (const rel of SOURCE_DIRS) {
    const abs = nodePath.join(root, rel);
    if (!existsSync(abs)) continue;
    scannedDirs.push(rel);
    const filesInDir = walkJsonFiles(abs);
    for (const file of filesInDir) {
      sourceCount++;
      const json = safeReadJson(file);
      if (!json || typeof json !== 'object') continue;

      const fname = file.toLowerCase();

      // File touch heuristic: walk the JSON looking for file-shaped strings.
      extractFilesFromAny(json, (f) => {
        const key = normalizeFileKey(f);
        bumpFile(files, key).touchCount += 1;
      });

      // Plan files with conflicts.
      const j = json as Record<string, unknown>;
      if (Array.isArray(j['expectedChanges'])) {
        for (const c of j['expectedChanges'] as Array<Record<string, unknown>>) {
          if (c['type'] === 'conflict') {
            plansWithConflicts.push(file);
            const target = typeof c['relativePath'] === 'string' ? (c['relativePath'] as string) : '';
            if (target) bumpFile(files, normalizeFileKey(target)).conflictCount += 1;
          }
        }
      }

      // Validation reports.
      if (Array.isArray(j['verificationResults'])) {
        for (const v of j['verificationResults'] as Array<Record<string, unknown>>) {
          const cmd = typeof v['command'] === 'string' ? (v['command'] as string) : '';
          if (typeof v['exitCode'] === 'number' && (v['exitCode'] as number) !== 0 && cmd) {
            failedValidationCommands.push(cmd);
          }
          if (typeof v['durationMs'] === 'number' && cmd) {
            const d = v['durationMs'] as number;
            if (d > 30000) slowValidationCommands.push({ command: cmd, durationMs: d });
          }
        }
      }

      // Boundary violations.
      if (Array.isArray(j['violations'])) {
        for (const v of j['violations'] as Array<Record<string, unknown>>) {
          const ruleId = typeof v['ruleId'] === 'string' ? (v['ruleId'] as string) : '';
          if (ruleId) boundaryViolations.set(ruleId, (boundaryViolations.get(ruleId) ?? 0) + 1);
          const fp = typeof v['file'] === 'string' ? (v['file'] as string) : '';
          if (fp) bumpFile(files, normalizeFileKey(fp)).warningCount += 1;
        }
      }

      // Policy / compliance reports.
      if (Array.isArray(j['policyViolations']) || Array.isArray(j['findings'])) {
        const list = (Array.isArray(j['policyViolations']) ? j['policyViolations'] : j['findings']) as
          | Array<Record<string, unknown>>
          | undefined;
        if (list) {
          for (const v of list) {
            const code =
              typeof v['policyId'] === 'string'
                ? (v['policyId'] as string)
                : typeof v['code'] === 'string'
                  ? (v['code'] as string)
                  : '';
            if (code) policyViolations.set(code, (policyViolations.get(code) ?? 0) + 1);
          }
        }
      }

      // Release readiness / smoke.
      if (Array.isArray(j['blockers'])) {
        for (const b of j['blockers'] as Array<Record<string, unknown>>) {
          const id = typeof b['id'] === 'string' ? (b['id'] as string) : '';
          if (id) pushUnique(releaseBlockers, id);
        }
      }

      // Pack issues.
      if (Array.isArray(j['packs'])) {
        for (const p of j['packs'] as Array<Record<string, unknown>>) {
          if (p['valid'] === false || (Array.isArray(p['warnings']) && (p['warnings'] as unknown[]).length > 0)) {
            const name = typeof p['name'] === 'string' ? (p['name'] as string) : '(unnamed pack)';
            pushUnique(packIssues, name);
          }
        }
      }

      // Diagnostics.
      const code = typeof j['code'] === 'string' ? (j['code'] as string) : '';
      if (code && (fname.includes('diagnostic') || code.startsWith('plan-') || code.includes('failed'))) {
        const cur = diagnostics.get(code) ?? { count: 0 };
        cur.count += 1;
        if (typeof j['generatedAt'] === 'string') cur.lastSeen = j['generatedAt'] as string;
        diagnostics.set(code, cur);
      }

      // Sessions: capture taskType / playbook.
      const taskKind = typeof j['intent'] === 'object' && j['intent'] !== null ? (j['intent'] as Record<string, unknown>)['kind'] : undefined;
      if (typeof taskKind === 'string') pushUnique(recentTaskTypes, taskKind);
      const taskHint = extractTaskFromName(file);
      if (taskHint) void taskHint;

      const playbookId = typeof j['playbookId'] === 'string' ? (j['playbookId'] as string) : '';
      if (playbookId) {
        const cur = playbooks.get(playbookId) ?? { successCount: 0, failureCount: 0 };
        const status = typeof j['status'] === 'string' ? (j['status'] as string).toLowerCase() : '';
        if (status === 'success' || status === 'completed') cur.successCount += 1;
        else if (status === 'failed' || status === 'error') cur.failureCount += 1;
        playbooks.set(playbookId, cur);
      }

      // Constructs touched.
      if (Array.isArray(j['affectedConstructs'])) {
        for (const c of j['affectedConstructs'] as unknown[]) {
          const id =
            typeof c === 'string'
              ? c
              : typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string'
                ? ((c as { id: string }).id)
                : '';
          if (id) {
            const cur = constructs.get(id) ?? { weight: 0 };
            cur.weight += 1;
            constructs.set(id, cur);
          }
        }
      }
    }
  }

  if (sourceCount === 0) warnings.push('No .sharkcraft/ history found — index is empty.');

  // Language tagging derived from file paths.
  const languageByFile: Record<string, string> = {};
  const riskyByLang: Record<string, string[]> = {};
  for (const [path] of files) {
    const lang = languageForPath(path);
    if (!lang) continue;
    languageByFile[path] = lang;
    if (!riskyByLang[lang]) riskyByLang[lang] = [];
    riskyByLang[lang]!.push(path);
  }

  const diagsByLang: Record<string, string[]> = {};
  for (const code of diagnostics.keys()) {
    const langGuess = languageForDiagnosticCode(code);
    if (!langGuess) continue;
    if (!diagsByLang[langGuess]) diagsByLang[langGuess] = [];
    diagsByLang[langGuess]!.push(code);
  }

  const boundaryByLang: Record<string, string[]> = {};
  for (const id of boundaryViolations.keys()) {
    const langGuess = languageForRuleId(id);
    if (!langGuess) continue;
    if (!boundaryByLang[langGuess]) boundaryByLang[langGuess] = [];
    boundaryByLang[langGuess]!.push(id);
  }

  const validationByLang: Record<string, string[]> = {};
  for (const cmd of failedValidationCommands) {
    const langGuess = languageForValidationCommand(cmd);
    if (!langGuess) continue;
    if (!validationByLang[langGuess]) validationByLang[langGuess] = [];
    validationByLang[langGuess]!.push(cmd);
  }

  const planConflictsByLang: Record<string, string[]> = {};
  for (const path of plansWithConflicts) {
    const lang = languageForPath(path);
    if (!lang) continue;
    if (!planConflictsByLang[lang]) planConflictsByLang[lang] = [];
    planConflictsByLang[lang]!.push(path);
  }

  const hotspots: ILanguageHotspot[] = [];
  for (const [lang, lst] of Object.entries(riskyByLang)) {
    const top = lst.slice(0, 8);
    let totalWeight = 0;
    for (const path of lst) {
      const acc = files.get(path);
      if (acc) totalWeight += acc.touchCount + acc.conflictCount + acc.failedValidationCount;
    }
    hotspots.push({ language: lang, fileCount: lst.length, totalWeight, topFiles: top });
  }
  hotspots.sort((a, b) => b.totalWeight - a.totalWeight);

  const trend: ILanguageRiskTrendEntry[] = hotspots.map((h) => ({
    language: h.language,
    trend: h.totalWeight >= 6 ? 'rising' : h.totalWeight > 0 ? 'stable' : 'unknown',
    weight: h.totalWeight,
  }));

  return {
    schema: REPO_MEMORY_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    sourceCount,
    scannedDirs,
    languageByFile,
    riskyFilesByLanguage: Object.fromEntries(Object.entries(riskyByLang).map(([k, v]) => [k, v.slice(0, 30)])),
    diagnosticsByLanguage: diagsByLang,
    boundaryViolationsByLanguage: boundaryByLang,
    validationFailuresByLanguage: validationByLang,
    planConflictsByLanguage: planConflictsByLang,
    languageHotspots: hotspots,
    languageRiskTrend: trend,
    files: [...files.entries()]
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.touchCount + b.conflictCount + b.failedValidationCount - (a.touchCount + a.conflictCount + a.failedValidationCount))
      .slice(0, 200),
    diagnostics: [...diagnostics.entries()]
      .map(([code, v]) => ({ code, count: v.count, ...(v.lastSeen ? { lastSeen: v.lastSeen } : {}) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
    plansWithConflicts: [...new Set(plansWithConflicts)].slice(0, 50),
    boundaryViolationsRecurring: [...boundaryViolations.entries()]
      .filter(([, n]) => n >= 2)
      .map(([id]) => id)
      .slice(0, 50),
    policyViolationsRecurring: [...policyViolations.entries()]
      .filter(([, n]) => n >= 2)
      .map(([id]) => id)
      .slice(0, 50),
    releaseBlockers,
    packIssues,
    failedValidationCommands: [...new Set(failedValidationCommands)].slice(0, 50),
    slowValidationCommands: slowValidationCommands.slice(0, 25),
    recentTaskTypes,
    playbooks: [...playbooks.entries()].map(([id, v]) => ({ id, ...v })),
    highRiskConstructs: [...constructs.entries()]
      .map(([id, v]) => ({ id, weight: v.weight, ...(v.lastSeen ? { lastSeen: v.lastSeen } : {}) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 50),
    warnings,
    notes: ['Local-only index. No network. No telemetry. No embeddings.'],
  };
}

export function memoryIndexPath(projectRoot: string): string {
  return nodePath.join(projectRoot, INDEX_FILE);
}

export function memoryDir(projectRoot: string): string {
  return nodePath.join(projectRoot, MEMORY_DIR);
}

export function saveRepositoryMemory(
  projectRoot: string,
  index: IRepositoryMemoryIndex,
): string {
  const dir = memoryDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const file = memoryIndexPath(projectRoot);
  writeFileSync(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return file;
}

export function loadRepositoryMemory(projectRoot: string): IRepositoryMemoryIndex | null {
  const file = memoryIndexPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IRepositoryMemoryIndex;
  } catch {
    return null;
  }
}

export interface IResetMemoryResult {
  dryRun: boolean;
  removed: readonly string[];
  notRemoved: readonly string[];
}

export function resetRepositoryMemory(projectRoot: string, opts: { dryRun: boolean }): IResetMemoryResult {
  const dir = memoryDir(projectRoot);
  const safetyPrefix = nodePath.join(projectRoot, '.sharkcraft', 'memory');
  // Triple-check: refuse if we would touch anything outside .sharkcraft/memory.
  if (!dir.startsWith(safetyPrefix)) {
    return { dryRun: opts.dryRun, removed: [], notRemoved: [dir] };
  }
  if (!existsSync(dir)) return { dryRun: opts.dryRun, removed: [], notRemoved: [] };
  if (opts.dryRun) {
    return { dryRun: true, removed: [dir], notRemoved: [] };
  }
  rmSync(dir, { recursive: true, force: true });
  return { dryRun: false, removed: [dir], notRemoved: [] };
}

export function memoryRiskForTask(
  index: IRepositoryMemoryIndex | null,
  task: string,
): IMemoryRiskReport {
  if (!index || index.sourceCount === 0) {
    return {
      schema: REPO_MEMORY_SCHEMA,
      task,
      generatedAt: new Date().toISOString(),
      recommendation: 'no-memory',
      matchedFiles: [],
      matchedDiagnostics: [],
      matchedConstructs: [],
      notes: ['No memory index found. Run `shrk memory build` first.'],
    };
  }
  const lower = task.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

  const matchedFiles = index.files
    .filter((f) => tokens.some((t) => f.path.toLowerCase().includes(t)))
    .slice(0, 20);

  const matchedDiagnostics = index.diagnostics
    .filter((d) => tokens.some((t) => d.code.toLowerCase().includes(t)))
    .slice(0, 10);

  const matchedConstructs = index.highRiskConstructs
    .filter((c) => tokens.some((t) => c.id.toLowerCase().includes(t)))
    .slice(0, 10);

  const matches = matchedFiles.length + matchedDiagnostics.length + matchedConstructs.length;
  let recommendation: IMemoryRiskReport['recommendation'] = 'no-overlap';
  if (matches === 0) recommendation = 'no-overlap';
  else if (matches < 3) recommendation = 'overlap-weak';
  else recommendation = 'overlap-strong';

  const notes: string[] = [];
  if (matches > 0) {
    notes.push(`Memory shows historical activity for ${matches} signal(s) relevant to this task.`);
  }
  return {
    schema: REPO_MEMORY_SCHEMA,
    task,
    generatedAt: new Date().toISOString(),
    recommendation,
    matchedFiles,
    matchedDiagnostics,
    matchedConstructs,
    notes,
  };
}

export function renderMemoryReportText(index: IRepositoryMemoryIndex): string {
  let out = `=== Repository memory ===\n`;
  out += `  project root      ${index.projectRoot}\n`;
  out += `  generated         ${index.generatedAt}\n`;
  out += `  sources scanned   ${index.sourceCount}\n`;
  out += `  scanned dirs      ${index.scannedDirs.join(', ') || '(none)'}\n\n`;
  if (index.files.length) {
    out += `Top files (touch + conflict + failure):\n`;
    for (const f of index.files.slice(0, 20))
      out += `  ${String(f.touchCount).padStart(4)}x  ${f.path}  conflicts=${f.conflictCount} warnings=${f.warningCount}\n`;
    out += `\n`;
  }
  if (index.diagnostics.length) {
    out += `Recurring diagnostics:\n`;
    for (const d of index.diagnostics) out += `  ${String(d.count).padStart(3)}x  ${d.code}\n`;
    out += `\n`;
  }
  if (index.plansWithConflicts.length) {
    out += `Plans with conflicts (${index.plansWithConflicts.length}):\n`;
    for (const p of index.plansWithConflicts.slice(0, 10)) out += `  • ${p}\n`;
    out += `\n`;
  }
  if (index.boundaryViolationsRecurring.length) {
    out += `Recurring boundary violations: ${index.boundaryViolationsRecurring.join(', ')}\n\n`;
  }
  if (index.policyViolationsRecurring.length) {
    out += `Recurring policy violations: ${index.policyViolationsRecurring.join(', ')}\n\n`;
  }
  if (index.releaseBlockers.length) {
    out += `Release blockers seen: ${index.releaseBlockers.join(', ')}\n\n`;
  }
  if (index.packIssues.length) {
    out += `Pack issues seen: ${index.packIssues.join(', ')}\n\n`;
  }
  if (index.failedValidationCommands.length) {
    out += `Failed validation commands:\n`;
    for (const c of index.failedValidationCommands.slice(0, 10)) out += `  • ${c}\n`;
    out += `\n`;
  }
  if (index.slowValidationCommands.length) {
    out += `Slow validation commands:\n`;
    for (const s of index.slowValidationCommands.slice(0, 10))
      out += `  • ${s.command}  (${s.durationMs}ms)\n`;
    out += `\n`;
  }
  if (index.recentTaskTypes.length) {
    out += `Recent task types: ${index.recentTaskTypes.join(', ')}\n\n`;
  }
  if (index.playbooks.length) {
    out += `Playbooks (success / failure):\n`;
    for (const p of index.playbooks) out += `  • ${p.id}: ✔${p.successCount} ✗${p.failureCount}\n`;
    out += `\n`;
  }
  if (index.highRiskConstructs.length) {
    out += `Constructs by activity weight:\n`;
    for (const c of index.highRiskConstructs.slice(0, 15))
      out += `  ${String(c.weight).padStart(3)}x  ${c.id}\n`;
    out += `\n`;
  }
  if (index.warnings.length) {
    out += `Warnings:\n`;
    for (const w of index.warnings) out += `  • ${w}\n`;
    out += `\n`;
  }
  out += `Notes:\n`;
  for (const n of index.notes) out += `  • ${n}\n`;
  return out;
}

export function renderMemoryRiskText(r: IMemoryRiskReport): string {
  let out = `=== Memory-based risk for task ===\n`;
  out += `  task            ${r.task}\n`;
  out += `  recommendation  ${r.recommendation}\n\n`;
  if (r.matchedFiles.length) {
    out += `Matched risky files:\n`;
    for (const f of r.matchedFiles)
      out += `  ${String(f.touchCount).padStart(4)}x ${f.path} conflicts=${f.conflictCount}\n`;
    out += `\n`;
  }
  if (r.matchedDiagnostics.length) {
    out += `Matched diagnostics:\n`;
    for (const d of r.matchedDiagnostics)
      out += `  ${String(d.count).padStart(3)}x ${d.code}\n`;
    out += `\n`;
  }
  if (r.matchedConstructs.length) {
    out += `Matched constructs:\n`;
    for (const c of r.matchedConstructs)
      out += `  ${String(c.weight).padStart(3)}x ${c.id}\n`;
    out += `\n`;
  }
  if (r.notes.length) {
    out += `Notes:\n`;
    for (const n of r.notes) out += `  • ${n}\n`;
  }
  return out;
}
