/**
 * Registration hint registry. Pack- and local-contributed hints
 * surface downstream registration steps that constructs typically need
 * (composer wiring, route table entries, capability registration, etc.).
 *
 * The engine ships zero hints; every entry comes from a contribution.
 *
 * Read-only: hints can be listed, fetched by id, validated, and previewed
 * against the live file system, but the engine never auto-applies them.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  validateRegistrationHint,
  type IRegistrationHint,
  type IRegistrationHintOperation,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const REGISTRATION_HINT_REGISTRY_SCHEMA = 'sharkcraft.registration-hint-registry/v1';

export enum RegistrationHintSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IRegistrationHintEntry {
  readonly hint: IRegistrationHint;
  readonly source: RegistrationHintSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface IRegistrationHintDoctorIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly hintId?: string;
  readonly source?: string;
}

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    registrationHints?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.registrationHints)) return mod.registrationHints;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['registration-hints.ts', 'registration-hints/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  const cfg = inspection.config as { registrationHintFiles?: readonly string[] } | null;
  for (const rel of cfg?.registrationHintFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadRegistrationHints(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IRegistrationHintEntry[];
  issues: readonly IRegistrationHintDoctorIssue[];
}> {
  const entries: IRegistrationHintEntry[] = [];
  const issues: IRegistrationHintDoctorIssue[] = [];
  const seen = new Set<string>();

  const ingest = (
    raw: IRegistrationHint,
    source: RegistrationHintSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    const v = validateRegistrationHint(raw);
    if (!v.valid) {
      for (const i of v.issues) {
        issues.push({
          severity: 'error',
          code: 'invalid-hint',
          message: `${i.field}: ${i.message}`,
          hintId: typeof raw.id === 'string' ? raw.id : undefined,
          source: sourceFile,
        });
      }
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Registration hint "${raw.id}" already loaded; skipping ${sourceFile}.`,
        hintId: raw.id,
        source: sourceFile,
      });
      return;
    }
    seen.add(raw.id);
    entries.push({
      hint: raw,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<IRegistrationHint>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const h of list) ingest(h, RegistrationHintSource.Local, undefined, rel);
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as { registrationHintFiles?: readonly string[] };
    for (const rel of contributions.registrationHintFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importDefault<IRegistrationHint>(file);
        for (const h of list) ingest(h, RegistrationHintSource.Pack, pack.packageName, rel);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { entries, issues };
}

export async function listRegistrationHints(
  inspection: ISharkcraftInspection,
): Promise<readonly IRegistrationHintEntry[]> {
  const { entries } = await loadRegistrationHints(inspection);
  return entries;
}

export async function getRegistrationHint(
  inspection: ISharkcraftInspection,
  hintId: string,
): Promise<IRegistrationHintEntry | null> {
  const entries = await listRegistrationHints(inspection);
  return entries.find((e) => e.hint.id === hintId) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export interface IRegistrationHintPreviewOperation {
  readonly kind: IRegistrationHintOperation['kind'];
  readonly anchor?: string;
  readonly snippet?: string;
  /** Pretty-printed description for human review. */
  readonly description: string;
}

export interface IRegistrationHintPreview {
  readonly schema: 'sharkcraft.registration-hint-preview/v1';
  readonly hintId: string;
  readonly title: string;
  readonly targetFile: string | null;
  readonly candidates: readonly string[];
  /** True when discovery is ambiguous (multiple candidates) or no file matches. */
  readonly ambiguous: boolean;
  readonly requiresHumanReview: boolean;
  readonly operations: readonly IRegistrationHintPreviewOperation[];
  readonly missingVariables: readonly string[];
  readonly safetyNotes: readonly string[];
  readonly validationCommands: readonly string[];
  readonly nextCommand: string;
}

export interface IRegistrationHintPreviewOptions {
  readonly variables?: Readonly<Record<string, string>>;
}

export async function previewRegistrationHint(
  inspection: ISharkcraftInspection,
  hintId: string,
  options: IRegistrationHintPreviewOptions = {},
): Promise<IRegistrationHintPreview | null> {
  const entry = await getRegistrationHint(inspection, hintId);
  if (!entry) return null;
  const { hint } = entry;
  const variables = options.variables ?? {};
  const missingVariables = (hint.variables ?? [])
    .filter((v) => v.required && variables[v.name] === undefined && v.defaultValue === undefined)
    .map((v) => v.name);

  // Discovery: prefer fixed targetFile when present, otherwise enumerate
  // candidates from globs on the live file system.
  let targetFile: string | null = null;
  let candidates: string[] = [];
  if (hint.discovery.targetFile) {
    targetFile = hint.discovery.targetFile;
    candidates = [hint.discovery.targetFile];
  } else if (hint.discovery.targetGlobs && hint.discovery.targetGlobs.length > 0) {
    candidates = await resolveGlobsAgainstRoot(
      inspection.projectRoot,
      hint.discovery.targetGlobs,
    );
    if (candidates.length === 1) targetFile = candidates[0]!;
  }
  const ambiguous = candidates.length !== 1;
  const requiresHumanReview = hint.requiresHumanReview === true || ambiguous;
  const renderedOps: IRegistrationHintPreviewOperation[] = hint.operations.map((op) => {
    const description = describeOp(op);
    const out: IRegistrationHintPreviewOperation = { kind: op.kind, description };
    if (op.anchor) (out as { anchor?: string }).anchor = op.anchor;
    if (op.snippet) (out as { snippet?: string }).snippet = substituteVars(op.snippet, variables);
    return out;
  });
  return {
    schema: 'sharkcraft.registration-hint-preview/v1',
    hintId,
    title: hint.title,
    targetFile,
    candidates,
    ambiguous,
    requiresHumanReview,
    operations: renderedOps,
    missingVariables,
    safetyNotes: hint.safetyNotes ?? [],
    validationCommands: hint.validationCommands ?? [],
    nextCommand: ambiguous
      ? `# Multiple candidates — pick one and apply manually.`
      : `# Preview only. Apply manually after human review.`,
  };
}

async function resolveGlobsAgainstRoot(
  projectRoot: string,
  globs: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const glob of globs) {
    // Crude glob: only `*` and `**` recognized; fallback to literal.
    if (!glob.includes('*')) {
      const abs = nodePath.join(projectRoot, glob);
      if (existsSync(abs)) out.push(glob);
      continue;
    }
    const baseSegments: string[] = [];
    for (const seg of glob.split('/')) {
      if (seg.includes('*')) break;
      baseSegments.push(seg);
    }
    const base = baseSegments.length > 0 ? nodePath.join(projectRoot, ...baseSegments) : projectRoot;
    // Replace `**` with `___DOUBLESTAR___` BEFORE escaping; then
    // escape special chars; then convert single `*` and the placeholder.
    const escaped = glob
      .replace(/\*\*/g, '___DOUBLESTAR___')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLESTAR___/g, '.*');
    let re: RegExp;
    try {
      re = new RegExp('^' + escaped + '$');
    } catch {
      // Malformed glob — skip.
      continue;
    }
    if (!existsSync(base)) continue;
    // Walk the base directory looking for matches (capped, deterministic).
    const stack: string[] = [base];
    let safety = 0;
    while (stack.length > 0 && safety < 5000) {
      const dir = stack.pop()!;
      safety += 1;
      try {
        const { readdirSync } = await import('node:fs');
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const next = nodePath.join(dir, String(e.name));
          if (e.isDirectory()) stack.push(next);
          else if (e.isFile()) {
            const rel = nodePath.relative(projectRoot, next);
            if (re.test(rel)) out.push(rel);
          }
        }
      } catch {
        // ignore traversal errors
      }
    }
  }
  return Array.from(new Set(out));
}

function describeOp(op: IRegistrationHintOperation): string {
  switch (op.kind) {
    case 'ensure-import':
      return `ensure-import from "${op.from ?? '?'}"${op.symbols ? ` { ${op.symbols.join(', ')} }` : ''}`;
    case 'insert-enum-entry':
      return `insert-enum-entry ${op.enumName ?? '?'}`;
    case 'insert-object-entry':
      return `insert-object-entry ${op.objectName ?? '?'}`;
    case 'insert-before-closing-brace':
      return `insert-before-closing-brace of "${op.containerName ?? '?'}"`;
    case 'insert-between-anchors':
      return `insert-between-anchors "${op.beginAnchor ?? '?'}" .. "${op.endAnchor ?? '?'}"`;
    case 'insert-after':
      return `insert-after anchor "${op.anchor ?? '?'}"`;
    case 'insert-before':
      return `insert-before anchor "${op.anchor ?? '?'}"`;
    case 'append':
      return `append snippet`;
    case 'export':
      return `export${op.symbols ? ` { ${op.symbols.join(', ')} }` : ''} from "${op.from ?? '?'}"`;
  }
}

function substituteVars(snippet: string, vars: Readonly<Record<string, string>>): string {
  return snippet.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor
// ─────────────────────────────────────────────────────────────────────────────

export async function listRegistrationHintIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IRegistrationHintDoctorIssue[]> {
  const { issues, entries } = await loadRegistrationHints(inspection);
  const out: IRegistrationHintDoctorIssue[] = [...issues];
  // Cross-validate: target files referenced by hints with a fixed
  // `targetFile` must currently exist; report missing as warning.
  for (const e of entries) {
    if (e.hint.discovery.targetFile) {
      const abs = nodePath.join(inspection.projectRoot, e.hint.discovery.targetFile);
      if (!existsSync(abs)) {
        out.push({
          severity: 'warning',
          code: 'target-file-missing',
          message: `Registration hint "${e.hint.id}" targets ${e.hint.discovery.targetFile} but the file is missing.`,
          hintId: e.hint.id,
          source: e.sourceFile,
        });
      } else {
        // Sanity: if the hint uses an anchor, verify the anchor exists.
        for (const op of e.hint.operations) {
          if (op.anchor) {
            try {
              const content = readFileSync(abs, 'utf8');
              if (!content.includes(op.anchor)) {
                out.push({
                  severity: 'info',
                  code: 'anchor-not-present',
                  message: `Hint "${e.hint.id}" expects anchor "${op.anchor}" in ${e.hint.discovery.targetFile} but it is missing today.`,
                  hintId: e.hint.id,
                  source: e.sourceFile,
                });
              }
            } catch {
              // ignore read errors
            }
          }
        }
      }
    }
  }
  return out;
}
