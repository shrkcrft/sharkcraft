/**
 * Anchor-aware barrel insert polish.
 *
 * Pure helper that turns a desired barrel mutation into a plan v2 `export`
 * (or `append`) operation with:
 *   - de-duplication: existing exports for the same `from` clause win.
 *   - alphabetic insertion: when requested, insert the new line in sorted
 *     order rather than appending.
 *   - explicit idempotency marker: opt-in marker text the caller can use
 *     to gate later runs.
 *   - ambiguity detection: if the barrel mixes `export *` and
 *     `export { ... }` styles for the same `from`, surface a conflict
 *     instead of guessing.
 *
 * The output shape is suitable for `ITemplateChange.operation`. Callers
 * compose it into the bigger plan exactly like the existing
 * `add-barrel-export` helper does.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IBuildBarrelExportInput {
  /** Project-relative barrel file path (e.g. `libs/x/src/index.ts`). */
  targetPath: string;
  /** Source path `from './lib/y'`. */
  from: string;
  /** Optional explicit symbol export (`export { Foo } from '...'`). */
  symbol?: string;
  /** Insert sorted by `from` (default 'append'). */
  sort?: 'alphabetic' | 'append';
  /** Optional group comment / marker (e.g. `// feature exports`). */
  group?: string;
  /** Idempotency marker substring — when present in the file, the op is a no-op. */
  idempotencyMarker?: string;
  /** Project root for filesystem inspection (default cwd). */
  projectRoot?: string;
}

export type BarrelExportOutcome =
  | 'inserted-alphabetic'
  | 'appended'
  | 'duplicate-skipped'
  | 'idempotent-marker-present'
  | 'conflict-ambiguous-style';

export interface IBarrelExportOperation {
  schema: 'sharkcraft.barrel-export/v1';
  targetPath: string;
  outcome: BarrelExportOutcome;
  operationDetail: string;
  operation:
    | {
        kind: 'export';
        from: string;
        symbols?: readonly string[];
        ifMissing?: string;
        description?: string;
      }
    | {
        kind: 'insert-before';
        anchor: string;
        snippet: string;
        ifMissing?: string;
        description?: string;
      }
    | {
        kind: 'append';
        snippet: string;
        ifMissing?: string;
        description?: string;
      };
  /** When `conflict-ambiguous-style`, surfaces what was inconsistent. */
  conflict?: string;
}

const SCHEMA = 'sharkcraft.barrel-export/v1' as const;

function readBarrel(targetPath: string, projectRoot: string): string | null {
  const full = nodePath.isAbsolute(targetPath)
    ? targetPath
    : nodePath.join(projectRoot, targetPath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function buildExportLine(from: string, symbol?: string): string {
  if (symbol) return `export { ${symbol} } from '${from}';`;
  return `export * from '${from}';`;
}

function findFirstSortedAnchor(text: string, from: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    const m = /^export\s+\*?\s*(\{[^}]*\}\s*)?from\s+['"]([^'"]+)['"]/.exec(line.trim());
    if (!m) continue;
    const existingFrom = m[2] ?? '';
    if (existingFrom > from) return line;
  }
  return null;
}

function detectAmbiguousStyle(text: string, from: string): string | null {
  let starCount = 0;
  let namedCount = 0;
  for (const line of text.split('\n')) {
    const m = /^export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/.exec(line.trim());
    if (!m || m[1] !== from) continue;
    if (line.includes('export *')) starCount += 1;
    else namedCount += 1;
  }
  if (starCount > 0 && namedCount > 0) {
    return `Barrel exports for "${from}" mix \`export *\` and \`export { ... }\` styles.`;
  }
  return null;
}

export function buildBarrelExportOperation(
  input: IBuildBarrelExportInput,
): IBarrelExportOperation {
  const projectRoot = input.projectRoot ?? process.cwd();
  const text = readBarrel(input.targetPath, projectRoot);
  const exportLine = buildExportLine(input.from, input.symbol);
  const description = `Barrel export for ${input.from}${input.symbol ? ` (${input.symbol})` : ''}`;
  // 1) Idempotency marker — short-circuit if the marker is present.
  if (text && input.idempotencyMarker && text.includes(input.idempotencyMarker)) {
    return {
      schema: SCHEMA,
      targetPath: input.targetPath,
      outcome: 'idempotent-marker-present',
      operationDetail: `Barrel already contains marker "${input.idempotencyMarker}"; no op.`,
      operation: {
        kind: 'append',
        snippet: '',
        ifMissing: input.idempotencyMarker,
        description,
      },
    };
  }
  // 2) Ambiguous-style conflict — surface, do not auto-pick.
  if (text) {
    const conflict = detectAmbiguousStyle(text, input.from);
    if (conflict) {
      return {
        schema: SCHEMA,
        targetPath: input.targetPath,
        outcome: 'conflict-ambiguous-style',
        operationDetail: conflict,
        operation: {
          kind: 'append',
          snippet: exportLine + '\n',
          description,
        },
        conflict,
      };
    }
    // 3) Existing export → duplicate-skipped.
    if (text.includes(exportLine)) {
      return {
        schema: SCHEMA,
        targetPath: input.targetPath,
        outcome: 'duplicate-skipped',
        operationDetail: `Barrel already exports ${input.from}; skipping.`,
        operation: {
          kind: 'export',
          from: input.from,
          ifMissing: exportLine,
          description,
          ...(input.symbol ? { symbols: [input.symbol] } : {}),
        },
      };
    }
  }
  // 4) Alphabetic insert.
  if (input.sort === 'alphabetic' && text) {
    const anchor = findFirstSortedAnchor(text, input.from);
    if (anchor) {
      const snippet = (input.group ? `// ${input.group}\n` : '') + exportLine + '\n';
      return {
        schema: SCHEMA,
        targetPath: input.targetPath,
        outcome: 'inserted-alphabetic',
        operationDetail: `Inserted before "${anchor}".`,
        operation: {
          kind: 'insert-before',
          anchor,
          snippet,
          ifMissing: exportLine,
          description,
        },
      };
    }
  }
  // 5) Append fallback (default).
  const snippet = (input.group ? `// ${input.group}\n` : '') + exportLine + '\n';
  return {
    schema: SCHEMA,
    targetPath: input.targetPath,
    outcome: 'appended',
    operationDetail: 'Appended to end of barrel.',
    operation: {
      kind: 'export',
      from: input.from,
      ifMissing: exportLine,
      description,
      ...(input.symbol ? { symbols: [input.symbol] } : {}),
    },
  };
  void snippet;
}
