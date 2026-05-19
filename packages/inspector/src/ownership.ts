import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader } from '@shrkcrft/core';

export const OWNERSHIP_SCHEMA = 'sharkcraft.ownership-rule/v1';

export interface IOwnershipRule {
  id: string;
  title: string;
  paths: readonly string[];
  owners: readonly string[];
  reviewers: readonly string[];
  tags: readonly string[];
  notes?: string;
  severity?: 'info' | 'warning' | 'error';
  requiredReview?: boolean;
}

export interface IOwnershipMatch {
  file: string;
  rules: readonly IOwnershipRule[];
  owners: readonly string[];
  reviewers: readonly string[];
  requiredReview: boolean;
}

export interface IOwnershipImpact {
  files: readonly string[];
  matches: readonly IOwnershipMatch[];
  /** Distinct owners across all matches. */
  owners: readonly string[];
  /** Distinct reviewers across all matches. */
  reviewers: readonly string[];
  /** Files needing required review. */
  requiredReviewFiles: readonly string[];
}

export interface ILoadOwnershipResult {
  rules: readonly IOwnershipRule[];
  sources: readonly string[];
  warnings: readonly string[];
}

const DEFAULT_PATHS = ['sharkcraft/ownership.ts', 'CODEOWNERS', '.github/CODEOWNERS'];

export async function loadOwnershipRules(
  cwd: string,
  configured?: readonly string[],
): Promise<ILoadOwnershipResult> {
  const rules: IOwnershipRule[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];
  const candidates = configured && configured.length > 0 ? configured : DEFAULT_PATHS;
  for (const rel of candidates) {
    const full = nodePath.resolve(cwd, rel);
    if (!existsSync(full)) continue;
    sources.push(full);
    if (full.endsWith('.ts') || full.endsWith('.js') || full.endsWith('.mjs') || full.endsWith('.cjs')) {
      try {
        // pathToFileURL mirrors the resolver pattern in TypeScriptKnowledgeLoader.
        const mod = (await importModuleViaLoader(full)) as {
          default?: readonly IOwnershipRule[];
          ownershipRules?: readonly IOwnershipRule[];
        };
        const list = mod.default ?? mod.ownershipRules ?? [];
        for (const r of list) rules.push(normalize(r));
      } catch (e) {
        warnings.push(`ownership: failed to load ${full}: ${(e as Error).message}`);
      }
    } else {
      const text = readFileSync(full, 'utf8');
      rules.push(...parseCodeOwners(text, full));
    }
  }
  return { rules, sources, warnings };
}

function normalize(r: IOwnershipRule): IOwnershipRule {
  return {
    ...r,
    paths: r.paths ?? [],
    owners: r.owners ?? [],
    reviewers: r.reviewers ?? [],
    tags: r.tags ?? [],
  };
}

function parseCodeOwners(text: string, file: string): IOwnershipRule[] {
  const out: IOwnershipRule[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0]!;
    const owners = parts.slice(1);
    out.push({
      id: `codeowners:${i + 1}`,
      title: `CODEOWNERS line ${i + 1}: ${pattern}`,
      paths: [globToPrefix(pattern)],
      owners,
      reviewers: owners,
      tags: ['codeowners'],
      notes: `from ${nodePath.basename(file)}`,
    });
  }
  return out;
}

function globToPrefix(g: string): string {
  // Strip leading "/" and trailing "/*" / "/**".
  let s = g.startsWith('/') ? g.slice(1) : g;
  s = s.replace(/\/\*\*?$/, '');
  // Truncate at the first wildcard so we still get a path prefix.
  const idx = s.search(/[*?\[]/);
  if (idx >= 0) s = s.slice(0, idx);
  return s.replace(/\/$/, '');
}

export function matchFile(file: string, rules: readonly IOwnershipRule[]): IOwnershipMatch {
  const matched = rules.filter((r) =>
    r.paths.some((p) => file === p || file.startsWith(p + '/') || file.includes(p)),
  );
  const owners = uniqueStrings(matched.flatMap((r) => r.owners));
  const reviewers = uniqueStrings(matched.flatMap((r) => r.reviewers));
  const requiredReview = matched.some((r) => r.requiredReview === true);
  return { file, rules: matched, owners, reviewers, requiredReview };
}

export function impactFor(
  files: readonly string[],
  rules: readonly IOwnershipRule[],
): IOwnershipImpact {
  const matches = files.map((f) => matchFile(f, rules));
  const owners = uniqueStrings(matches.flatMap((m) => m.owners));
  const reviewers = uniqueStrings(matches.flatMap((m) => m.reviewers));
  const requiredReviewFiles = matches.filter((m) => m.requiredReview).map((m) => m.file);
  return { files, matches, owners, reviewers, requiredReviewFiles };
}

function uniqueStrings(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}
