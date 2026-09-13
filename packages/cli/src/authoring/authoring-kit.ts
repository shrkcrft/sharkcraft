/**
 * Shared authoring kit for CLI commands.
 *
 * Extracts the CLI-side helpers that were duplicated across knowledge,
 * rules, and templates authoring. The DOMAIN builders stay in
 * `@shrkcrft/inspector` (`buildKnowledgeAuthoringPreview`, future
 * `buildTemplateAuthoringPreview`). This module is the **adapter**:
 *
 *   - resolve provenance source from env (agent vs. CLI)
 *   - write draft files under .sharkcraft/authoring/ only (refuse escape)
 *   - parse `--reference kind:value[:required]` specs
 *   - parse repeated / comma-form flag values
 *
 * Layer order: cli only (no inspector imports needed — these are pure
 * Node + ParsedArgs helpers).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  KNOWLEDGE_REFERENCE_KINDS,
  type IKnowledgeReference,
  type KnowledgeReferenceKind,
} from '@shrkcrft/knowledge';
import {
  AssetProvenanceSource,
} from '@shrkcrft/inspector';
import { flagList, type ParsedArgs } from '../command-registry.ts';

export interface IAuthoringSource {
  source: AssetProvenanceSource;
  author?: string;
  sessionId?: string;
}

/**
 * Derive the provenance source from environment. Agent-driven sessions
 * set `SHARKCRAFT_AGENT` / `CLAUDE_CODE_SESSION` / `ANTHROPIC_AGENT`;
 * otherwise we treat the invocation as CLI-driven.
 */
export function detectAuthoringSource(): IAuthoringSource {
  const isAgent =
    Boolean(process.env['SHARKCRAFT_AGENT']) ||
    Boolean(process.env['CLAUDE_CODE_SESSION']) ||
    Boolean(process.env['ANTHROPIC_AGENT']);
  const sessionId =
    process.env['SHARKCRAFT_SESSION_ID'] ||
    process.env['CLAUDE_CODE_SESSION'] ||
    undefined;
  const author =
    process.env['SHARKCRAFT_AUTHOR'] || process.env['USER'] || undefined;
  return {
    source: isAgent ? AssetProvenanceSource.Agent : AssetProvenanceSource.Cli,
    ...(author ? { author } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Write draft files to disk. Refuses any path outside
 * `.sharkcraft/authoring/` or `.sharkcraft/fixes/`. Returns the list of
 * project-relative paths that were actually written.
 */
export function writeAuthoringDrafts(
  cwd: string,
  files: ReadonlyArray<{ path: string; body: string }>,
): string[] {
  const written: string[] = [];
  const authoringRoot = nodePath.resolve(cwd, '.sharkcraft', 'authoring');
  const fixesRoot = nodePath.resolve(cwd, '.sharkcraft', 'fixes');
  for (const f of files) {
    const abs = nodePath.resolve(cwd, f.path);
    if (
      !abs.startsWith(authoringRoot + nodePath.sep) &&
      !abs.startsWith(fixesRoot + nodePath.sep)
    ) {
      continue;
    }
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, f.body, 'utf8');
    written.push(f.path);
  }
  return written;
}

/**
 * Accept both repeated flags (`--reference a --reference b`) and
 * comma-form (`--reference a,b`). When the flag is passed multiple
 * times, occurrences stay verbatim so structured values like `kind:foo,bar`
 * aren't split.
 */
export function multiFlagValues(args: ParsedArgs, name: string): string[] {
  return flagList(args, name, { dedupe: true, split: 'auto' });
}

/**
 * Parse a `kind:value[:required]` reference spec. Returns null on
 * invalid input so callers can filter.
 *
 * A symbol may pin its declaring file — `symbol:<name>@<path>` — and address a
 * member — `symbol:Owner.member@<path>`. This is the inverse of
 * `formatKnowledgeReference`, so what the stale-check prints can be pasted
 * back as a `--reference`.
 *
 * The accepted kinds are {@link KNOWLEDGE_REFERENCE_KINDS} — the one
 * vocabulary the validator and the stale-check read — never a hand-copied list.
 */
export function parseReferenceSpec(spec: string): IKnowledgeReference | null {
  const parts = spec.split(':');
  if (parts.length < 2) return null;
  const [kindRaw, ...rest] = parts;
  if (!KNOWLEDGE_REFERENCE_KINDS.includes(kindRaw as KnowledgeReferenceKind)) return null;
  const kind = kindRaw as KnowledgeReferenceKind;
  const required = rest[rest.length - 1] === 'required';
  if (required) rest.pop();
  const value = rest.join(':');
  if (!value) return null;
  switch (kind) {
    case 'file':
    case 'directory':
      return { kind, path: value, ...(required ? { required: true } : {}) };
    case 'symbol': {
      // `Name@path` pins the declaring file (a symbol name never contains `@`).
      const at = value.indexOf('@');
      if (at > 0 && at < value.length - 1) {
        return {
          kind,
          symbol: value.slice(0, at),
          path: value.slice(at + 1),
          ...(required ? { required: true } : {}),
        };
      }
      return { kind, symbol: value, ...(required ? { required: true } : {}) };
    }
    default:
      // Every other kind in the vocabulary is id-keyed (a command, a registry
      // id, a url) — a kind added to the vocabulary is accepted here at once.
      return { kind, id: value, ...(required ? { required: true } : {}) };
  }
}
