import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  importAgentsMd,
  importClaudeMd,
  importCursorRules,
  type IImportedEntry,
  type IImportWarning,
} from '@shrkcrft/importer';

/**
 * One entry as emitted into the imported-agent-rules draft. Strips importer
 * machinery (KnowledgeType / KnowledgePriority enums) to plain strings that
 * the draft renderer can splat into the generated TypeScript without
 * needing to import importer types at runtime.
 */
export interface IDraftAgentEntry {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: readonly string[];
  scope?: readonly string[];
  source?: { origin: string };
  /** True when the importer flagged the bullet as ambiguous. */
  flaggedAmbiguous?: boolean;
}

export interface IImportedAgentRulesBundle {
  sourceFiles: readonly string[];
  entries: readonly IDraftAgentEntry[];
  warnings: readonly string[];
  /** Per-source counts the report can echo back. */
  perSource: readonly {
    kind: 'agents-md' | 'claude-md' | 'cursor-rules';
    path: string;
    entryCount: number;
  }[];
}

export interface IImportAgentRulesOptions {
  projectRoot: string;
}

/**
 * Probe AGENTS.md, CLAUDE.md, and .cursor/rules under projectRoot and return
 * a single bundle the onboarding flow can render to a draft. Read-only:
 * never writes a file.
 */
export function importAgentRulesForOnboarding(
  options: IImportAgentRulesOptions,
): IImportedAgentRulesBundle {
  const root = options.projectRoot;
  const sourceFiles: string[] = [];
  const entries: IDraftAgentEntry[] = [];
  const warnings: string[] = [];
  const perSource: Array<{
    kind: 'agents-md' | 'claude-md' | 'cursor-rules';
    path: string;
    entryCount: number;
  }> = [];

  // AGENTS.md
  const agentsPath = nodePath.join(root, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const result = importAgentsMd({ filePath: agentsPath, projectRoot: root });
    sourceFiles.push(...result.sourceFiles);
    const mapped = result.entries.map((e) => toDraftEntry(e, 'agents-md'));
    entries.push(...mapped);
    for (const w of result.warnings) warnings.push(formatWarning(w));
    perSource.push({
      kind: 'agents-md',
      path: 'AGENTS.md',
      entryCount: mapped.length,
    });
  }
  // CLAUDE.md
  const claudePath = nodePath.join(root, 'CLAUDE.md');
  if (existsSync(claudePath)) {
    const result = importClaudeMd({ filePath: claudePath, projectRoot: root });
    sourceFiles.push(...result.sourceFiles);
    const mapped = result.entries.map((e) => toDraftEntry(e, 'claude-md'));
    entries.push(...mapped);
    for (const w of result.warnings) warnings.push(formatWarning(w));
    perSource.push({
      kind: 'claude-md',
      path: 'CLAUDE.md',
      entryCount: mapped.length,
    });
  }
  // .cursor/rules — directory; the cursor importer walks the dir itself.
  const cursorRoot = nodePath.join(root, '.cursor', 'rules');
  if (existsSync(cursorRoot) && safeIsDir(cursorRoot)) {
    const result = importCursorRules({
      filePath: cursorRoot,
      projectRoot: root,
    });
    sourceFiles.push(...result.sourceFiles);
    const mapped = result.entries.map((e) => toDraftEntry(e, 'cursor-rules'));
    entries.push(...mapped);
    for (const w of result.warnings) warnings.push(formatWarning(w));
    perSource.push({
      kind: 'cursor-rules',
      path: '.cursor/rules',
      entryCount: mapped.length,
    });
  }

  return {
    sourceFiles: dedupe(sourceFiles),
    entries: dedupeById(entries),
    warnings,
    perSource,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toDraftEntry(
  entry: IImportedEntry,
  source: 'agents-md' | 'claude-md' | 'cursor-rules',
): IDraftAgentEntry {
  const flaggedAmbiguous = (entry.importerNotes ?? []).some((n) =>
    n.toLowerCase().includes('ambiguous'),
  );
  return {
    id: prefixId(entry.id, source),
    type: String(entry.type),
    title: entry.title,
    content: entry.content,
    tags: [...new Set(['imported', source, ...entry.tags])],
    ...(entry.origin ? { source: { origin: entry.origin } } : {}),
    ...(flaggedAmbiguous ? { flaggedAmbiguous: true } : {}),
  };
}

function prefixId(
  id: string,
  source: 'agents-md' | 'claude-md' | 'cursor-rules',
): string {
  if (id.startsWith(`imported.${source}.`)) return id;
  if (id.includes('.')) return `imported.${source}.${id}`;
  return `imported.${source}.${id}`;
}

function formatWarning(w: IImportWarning): string {
  return `${w.origin}: ${w.message}`;
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function dedupeById(xs: readonly IDraftAgentEntry[]): IDraftAgentEntry[] {
  const seen = new Set<string>();
  const out: IDraftAgentEntry[] = [];
  for (const e of xs) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

