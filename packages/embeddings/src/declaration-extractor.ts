import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export enum DeclarationKind {
  Interface = 'interface',
  Type = 'type',
  Enum = 'enum',
  Class = 'class',
  Function = 'function',
  Const = 'const',
}

export interface IDeclarationBlock {
  name: string;
  kind: DeclarationKind;
  /** 1-indexed line where the declaration starts. */
  startLine: number;
  /** Up-to MAX_LINES of source, brace-balanced for interface/type/enum/class. */
  snippet: string;
  /** Bytes in the snippet (handy for budgeting downstream). */
  size: number;
}

const MAX_LINES_PER_BLOCK = 24;
const MAX_BLOCKS_PER_FILE = 12;
const HEADER_PATTERN =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(interface|type|enum|class|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

/**
 * Extract top-level export declarations from a TypeScript / JavaScript
 * source file using simple regex + brace counting. The goal is to surface
 * just enough of each export so an LLM can reason about the file without
 * receiving the full body.
 *
 * Returns:
 *   - `interface` / `type` / `enum` / `class`: header line + brace-balanced
 *     body (or single-line `type X = …;`) capped at MAX_LINES_PER_BLOCK lines.
 *   - `function` / `const` / `let` / `var`: just the signature line(s) up to
 *     the first `=>` arrow or `{` opening brace.
 *
 * No AST. Misses some niche shapes (`export { x as y }`, `export default
 * function …`) but covers the 95% case at zero install cost. Reads at most
 * the first 600 lines of the file to keep walks cheap.
 */
export function extractDeclarations(cwd: string, path: string): IDeclarationBlock[] {
  const abs = nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path);
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const lines = body.split(/\r?\n/).slice(0, 600);
  const out: IDeclarationBlock[] = [];
  let i = 0;
  while (i < lines.length && out.length < MAX_BLOCKS_PER_FILE) {
    const line = lines[i]!;
    const match = HEADER_PATTERN.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const kindRaw = match[1]!;
    const name = match[2]!;
    const kind = toKind(kindRaw);
    if (kind === null) {
      i += 1;
      continue;
    }
    const { snippet, consumedLines } = captureBlock(lines, i, kind);
    if (snippet.length > 0) {
      out.push({
        name,
        kind,
        startLine: i + 1,
        snippet,
        size: snippet.length,
      });
    }
    i += Math.max(1, consumedLines);
  }
  return out;
}

function toKind(raw: string): DeclarationKind | null {
  switch (raw) {
    case 'interface':
      return DeclarationKind.Interface;
    case 'type':
      return DeclarationKind.Type;
    case 'enum':
      return DeclarationKind.Enum;
    case 'class':
      return DeclarationKind.Class;
    case 'function':
      return DeclarationKind.Function;
    case 'const':
    case 'let':
    case 'var':
      return DeclarationKind.Const;
    default:
      return null;
  }
}

function captureBlock(
  lines: string[],
  startIdx: number,
  kind: DeclarationKind,
): { snippet: string; consumedLines: number } {
  const header = lines[startIdx]!;
  // Signature-only kinds: just take the header (and a continuation line
  // if the signature wraps before the opening brace / arrow).
  if (kind === DeclarationKind.Function || kind === DeclarationKind.Const) {
    if (/[{=][^;]*$/.test(header) || /=>\s*$/.test(header)) {
      // Multi-line signature. Walk forward until we hit `{`, `=>`, or `;`.
      const collected: string[] = [header];
      for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 6); i += 1) {
        collected.push(lines[i]!);
        if (/[{;]\s*$/.test(lines[i]!) || /=>\s*$/.test(lines[i]!)) break;
      }
      return { snippet: collected.join('\n'), consumedLines: collected.length };
    }
    return { snippet: header, consumedLines: 1 };
  }
  // Type aliases: single-line `export type X = …;` or multi-line until `;`.
  if (kind === DeclarationKind.Type) {
    if (header.includes(';') || !header.includes('=')) {
      return { snippet: header, consumedLines: 1 };
    }
    const collected: string[] = [header];
    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + MAX_LINES_PER_BLOCK); i += 1) {
      collected.push(lines[i]!);
      if (/;\s*$/.test(lines[i]!)) break;
    }
    return { snippet: collected.join('\n'), consumedLines: collected.length };
  }
  // Brace-balanced blocks: interface, enum, class.
  const collected: string[] = [];
  let depth = 0;
  let started = false;
  let consumed = 0;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + MAX_LINES_PER_BLOCK); i += 1) {
    const cur = lines[i]!;
    collected.push(cur);
    consumed += 1;
    for (let c = 0; c < cur.length; c += 1) {
      const ch = cur[c]!;
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
  }
  // If we hit the line cap and the block didn't close, append an ellipsis
  // marker so the LLM knows it was truncated.
  if (started && depth > 0) collected.push('// … (truncated)');
  return { snippet: collected.join('\n'), consumedLines: consumed };
}
