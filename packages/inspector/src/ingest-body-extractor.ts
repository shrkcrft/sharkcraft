/**
 * Extract a draft entry body from a `sharkcraft/ingestion/generated/<X>.draft.ts`
 * file for a given entry id.
 *
 * Extraction strategy:
 *   1. Find the line containing `id: '<id>'`.
 *   2. Walk outwards to find the enclosing `{ ... }` object literal.
 *   3. Return the object literal text (without the leading whitespace) plus a
 *      trailing comma. The caller appends it to the live sharkcraft/<file>.ts.
 *   4. If multiple `id: '<id>'` matches exist, or the enclosing block cannot
 *      be unambiguously identified, return `null` and let the caller fall back
 *      to the comment-stub body.
 *
 * Imports are NOT preserved by this extractor — the caller decides whether
 * to surface a manual checklist for missing imports. Most draft entries are
 * plain object literals with no extra imports.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IIngestBodyExtractionResult {
  status: 'materialised' | 'stubbed' | 'skipped' | 'conflict';
  body: string | null;
  reason?: string;
}

const DRAFT_FILE_CANDIDATES = (target: string): string[] => {
  // target is `sharkcraft/<file>.ts`; the draft is typically at
  // `sharkcraft/ingestion/generated/<file>.draft.ts`. We try both.
  const base = target.replace(/^sharkcraft\//, '').replace(/\.ts$/, '');
  return [
    `sharkcraft/ingestion/generated/${base}.draft.ts`,
    `sharkcraft/ingestion/drafts/${base}.draft.ts`,
    `sharkcraft/${base}.draft.ts`,
  ];
};

function findDraftFile(projectRoot: string, target: string): string | null {
  for (const rel of DRAFT_FILE_CANDIDATES(target)) {
    const abs = join(projectRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function extractObjectBlock(content: string, entryId: string): IIngestBodyExtractionResult {
  // Find every occurrence of `id: '<entryId>'` (allow double quotes too).
  const idRe = new RegExp(`id:\\s*['"]${entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g');
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(content)) !== null) matches.push(m.index);
  if (matches.length === 0) {
    return { status: 'skipped', body: null, reason: `id "${entryId}" not found in draft file` };
  }
  if (matches.length > 1) {
    return {
      status: 'conflict',
      body: null,
      reason: `id "${entryId}" matched ${matches.length} times in draft file — ambiguous, falling back to stub`,
    };
  }
  // Walk backwards to find the enclosing `{`.
  const idx = matches[0]!;
  let openIdx = -1;
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = content[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth -= 1;
    }
  }
  if (openIdx === -1) {
    return {
      status: 'conflict',
      body: null,
      reason: `Could not find opening brace before "id: ${entryId}".`,
    };
  }
  // Walk forwards from openIdx to find matching `}`.
  let closeIdx = -1;
  depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    return {
      status: 'conflict',
      body: null,
      reason: `Could not find closing brace for entry "${entryId}".`,
    };
  }
  const block = content.slice(openIdx, closeIdx + 1);
  // Append a trailing comma if the block does not already have one in context.
  // The live file is an array; entries are object literals separated by commas.
  return {
    status: 'materialised',
    body: block + ',',
  };
}

export function extractIngestBody(input: {
  projectRoot: string;
  target: string;
  entryId: string;
}): IIngestBodyExtractionResult {
  const draftFile = findDraftFile(input.projectRoot, input.target);
  if (!draftFile) {
    return {
      status: 'skipped',
      body: null,
      reason: `No draft file found for target "${input.target}". Use comment stub.`,
    };
  }
  let content: string;
  try {
    content = readFileSync(draftFile, 'utf8');
  } catch (e) {
    return {
      status: 'skipped',
      body: null,
      reason: `Failed to read draft file: ${(e as Error).message}`,
    };
  }
  return extractObjectBlock(content, input.entryId);
}
