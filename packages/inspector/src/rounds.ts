/**
 * Round snapshots and round-to-round diff.
 *
 * Each round captures a snapshot of the engine surface at HEAD:
 *   - registered CLI commands (from COMMAND_CATALOG, name + description)
 *   - registered MCP tools (from the audit list, name + description)
 *   - docs/ filenames (top-level only)
 *
 * Snapshots live under `.sharkcraft/rounds/<id>/snapshot.json` plus a
 * sibling `meta.json` with the round title and capture timestamp. The
 * `diffRounds` helper loads two snapshots and renders the added /
 * removed deltas — the actual answer to "what shipped in R<n> vs
 * R<n-1>".
 *
 * Schemas:
 *   `sharkcraft.round-snapshot/v1`
 *   `sharkcraft.rounds-diff/v1`
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';

export const ROUND_SNAPSHOT_SCHEMA = 'sharkcraft.round-snapshot/v1';
export const ROUNDS_DIFF_SCHEMA = 'sharkcraft.rounds-diff/v1';

export interface IRoundCommandEntry {
  name: string;
  description: string;
}

export interface IRoundToolEntry {
  name: string;
  description: string;
}

export interface IRoundMeta {
  id: string;
  title?: string;
  capturedAt: string;
}

export interface IRoundSnapshot {
  schema: typeof ROUND_SNAPSHOT_SCHEMA;
  id: string;
  title?: string;
  capturedAt: string;
  commands: readonly IRoundCommandEntry[];
  mcpTools: readonly IRoundToolEntry[];
  docs: readonly string[];
}

export interface IRoundsDiff {
  schema: typeof ROUNDS_DIFF_SCHEMA;
  fromId: string;
  toId: string;
  commandsAdded: readonly IRoundCommandEntry[];
  commandsRemoved: readonly IRoundCommandEntry[];
  mcpToolsAdded: readonly IRoundToolEntry[];
  mcpToolsRemoved: readonly IRoundToolEntry[];
  docsAdded: readonly string[];
  docsRemoved: readonly string[];
}

export interface ICaptureInput {
  projectRoot: string;
  id: string;
  title?: string;
  commands: readonly IRoundCommandEntry[];
  mcpTools: readonly IRoundToolEntry[];
}

function roundsRoot(projectRoot: string): string {
  return nodePath.join(projectRoot, '.sharkcraft', 'rounds');
}

function roundDir(projectRoot: string, id: string): string {
  return nodePath.join(roundsRoot(projectRoot), id);
}

function collectTopLevelDocs(projectRoot: string): string[] {
  const docsDir = nodePath.join(projectRoot, 'docs');
  if (!existsSync(docsDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(docsDir)) {
    if (entry.startsWith('.')) continue;
    const abs = nodePath.join(docsDir, entry);
    try {
      const st = statSync(abs);
      if (st.isFile() && entry.endsWith('.md')) out.push(entry);
    } catch {
      // skip
    }
  }
  return out.sort();
}

export function captureRoundSnapshot(input: ICaptureInput): IRoundSnapshot {
  const snapshot: IRoundSnapshot = {
    schema: ROUND_SNAPSHOT_SCHEMA,
    id: input.id,
    ...(input.title ? { title: input.title } : {}),
    capturedAt: new Date().toISOString(),
    commands: [...input.commands].sort((a, b) => a.name.localeCompare(b.name)),
    mcpTools: [...input.mcpTools].sort((a, b) => a.name.localeCompare(b.name)),
    docs: collectTopLevelDocs(input.projectRoot),
  };
  return snapshot;
}

export function writeRoundSnapshot(
  projectRoot: string,
  snapshot: IRoundSnapshot,
): { snapshotFile: string; metaFile: string } {
  const dir = roundDir(projectRoot, snapshot.id);
  mkdirSync(dir, { recursive: true });
  const snapshotFile = nodePath.join(dir, 'snapshot.json');
  const metaFile = nodePath.join(dir, 'meta.json');
  writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  const meta: IRoundMeta = {
    id: snapshot.id,
    ...(snapshot.title ? { title: snapshot.title } : {}),
    capturedAt: snapshot.capturedAt,
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { snapshotFile, metaFile };
}

export function loadRoundSnapshot(
  projectRoot: string,
  id: string,
): IRoundSnapshot | null {
  const snapshotFile = nodePath.join(roundDir(projectRoot, id), 'snapshot.json');
  if (!existsSync(snapshotFile)) return null;
  try {
    return JSON.parse(readFileSync(snapshotFile, 'utf8')) as IRoundSnapshot;
  } catch {
    return null;
  }
}

export function listRoundIds(projectRoot: string): readonly string[] {
  const root = roundsRoot(projectRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      try {
        return statSync(nodePath.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function diffByName<T extends { name: string }>(
  from: readonly T[],
  to: readonly T[],
): { added: T[]; removed: T[] } {
  const fromNames = new Set(from.map((e) => e.name));
  const toNames = new Set(to.map((e) => e.name));
  return {
    added: to.filter((e) => !fromNames.has(e.name)),
    removed: from.filter((e) => !toNames.has(e.name)),
  };
}

function diffStringSets(
  from: readonly string[],
  to: readonly string[],
): { added: string[]; removed: string[] } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    added: to.filter((e) => !fromSet.has(e)),
    removed: from.filter((e) => !toSet.has(e)),
  };
}

export function diffRounds(
  fromSnapshot: IRoundSnapshot,
  toSnapshot: IRoundSnapshot,
): IRoundsDiff {
  const cmd = diffByName(fromSnapshot.commands, toSnapshot.commands);
  const mcp = diffByName(fromSnapshot.mcpTools, toSnapshot.mcpTools);
  const docs = diffStringSets(fromSnapshot.docs, toSnapshot.docs);
  return {
    schema: ROUNDS_DIFF_SCHEMA,
    fromId: fromSnapshot.id,
    toId: toSnapshot.id,
    commandsAdded: cmd.added,
    commandsRemoved: cmd.removed,
    mcpToolsAdded: mcp.added,
    mcpToolsRemoved: mcp.removed,
    docsAdded: docs.added,
    docsRemoved: docs.removed,
  };
}

export function renderRoundsDiffMarkdown(diff: IRoundsDiff): string {
  const lines: string[] = [];
  lines.push(`# Rounds diff: ${diff.fromId} → ${diff.toId}`);
  lines.push('');
  lines.push(`schema: ${diff.schema}`);
  lines.push('');
  const section = (title: string, names: readonly { name: string; description: string }[]): void => {
    lines.push(`## ${title} (${names.length})`);
    lines.push('');
    if (names.length === 0) {
      lines.push('  (none)');
    } else {
      for (const n of names) lines.push(`  - \`${n.name}\` — ${n.description}`);
    }
    lines.push('');
  };
  section('Commands added', diff.commandsAdded);
  section('Commands removed', diff.commandsRemoved);
  section('MCP tools added', diff.mcpToolsAdded);
  section('MCP tools removed', diff.mcpToolsRemoved);
  lines.push(`## Docs added (${diff.docsAdded.length})`);
  lines.push('');
  if (diff.docsAdded.length === 0) lines.push('  (none)');
  else for (const d of diff.docsAdded) lines.push(`  - ${d}`);
  lines.push('');
  lines.push(`## Docs removed (${diff.docsRemoved.length})`);
  lines.push('');
  if (diff.docsRemoved.length === 0) lines.push('  (none)');
  else for (const d of diff.docsRemoved) lines.push(`  - ${d}`);
  lines.push('');
  return lines.join('\n');
}
