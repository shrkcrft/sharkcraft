/**
 * Read/write helpers for spec.md / spec.json / events.jsonl.
 *
 * Pure filesystem layer. Validation lives elsewhere; this module only
 * reads/writes the on-disk artifacts. The directory layout is
 * `.sharkcraft/specs/<id>/`:
 *
 *   spec.md           — frontmatter + body, authoritative
 *   spec.json         — derived canonical view
 *   plan.json         — signed combined plan (after `implement --write-plan`)
 *   verification.json — most recent verify report (after `verify`)
 *   events.jsonl      — append-only log of `spec` operations
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { deriveSpecJson } from './spec-derive.ts';
import { splitSpecMd } from './spec-frontmatter.ts';
import { SPEC_EVENTS_SCHEMA_V1, type ISpecJson } from './spec-model.ts';

export const SPECS_DIR_RELATIVE = '.sharkcraft/specs';

export function specsRoot(projectRoot: string): string {
  return nodePath.join(projectRoot, SPECS_DIR_RELATIVE);
}

export function specDir(projectRoot: string, id: string): string {
  return nodePath.join(specsRoot(projectRoot), id);
}

export function specMdPath(projectRoot: string, id: string): string {
  return nodePath.join(specDir(projectRoot, id), 'spec.md');
}

export function specJsonPath(projectRoot: string, id: string): string {
  return nodePath.join(specDir(projectRoot, id), 'spec.json');
}

export function specPlanPath(projectRoot: string, id: string): string {
  return nodePath.join(specDir(projectRoot, id), 'plan.json');
}

export function specVerificationPath(projectRoot: string, id: string): string {
  return nodePath.join(specDir(projectRoot, id), 'verification.json');
}

export function specEventsPath(projectRoot: string, id: string): string {
  return nodePath.join(specDir(projectRoot, id), 'events.jsonl');
}

export function listSpecIds(projectRoot: string): string[] {
  const root = specsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = nodePath.join(root, entry);
    let s: ReturnType<typeof statSync> | null = null;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s?.isDirectory()) {
      const md = nodePath.join(full, 'spec.md');
      if (existsSync(md)) out.push(entry);
    }
  }
  out.sort().reverse();
  return out;
}

export function writeSpecMd(projectRoot: string, id: string, body: string): Result<void, AppError> {
  try {
    mkdirSync(specDir(projectRoot, id), { recursive: true });
    writeFileSync(specMdPath(projectRoot, id), body.endsWith('\n') ? body : body + '\n', 'utf8');
    return ok(undefined);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, 'Failed to write spec.md', { cause: e }),
    );
  }
}

export function readSpecMd(projectRoot: string, id: string): Result<string, AppError> {
  const p = specMdPath(projectRoot, id);
  if (!existsSync(p)) {
    return err(
      new AppErrorImpl(ERROR_CODES.NOT_FOUND, `Spec not found: ${id} (expected ${p})`),
    );
  }
  try {
    return ok(readFileSync(p, 'utf8'));
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to read spec.md for ${id}`, { cause: e }),
    );
  }
}

export function writeSpecJson(
  projectRoot: string,
  id: string,
  json: ISpecJson,
): Result<void, AppError> {
  try {
    mkdirSync(specDir(projectRoot, id), { recursive: true });
    writeFileSync(specJsonPath(projectRoot, id), JSON.stringify(json, null, 2) + '\n', 'utf8');
    return ok(undefined);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, 'Failed to write spec.json', { cause: e }),
    );
  }
}

export function readSpecJson(projectRoot: string, id: string): Result<ISpecJson, AppError> {
  const p = specJsonPath(projectRoot, id);
  if (!existsSync(p)) {
    return err(new AppErrorImpl(ERROR_CODES.NOT_FOUND, `spec.json not found for ${id}`));
  }
  try {
    const raw = readFileSync(p, 'utf8');
    return ok(JSON.parse(raw) as ISpecJson);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `Invalid spec.json for ${id}`, { cause: e }),
    );
  }
}

/**
 * Convenience: parse spec.md, derive spec.json, return both. Does NOT
 * read or write the cached spec.json on disk — caller decides.
 */
export function loadSpec(
  projectRoot: string,
  id: string,
): Result<{ spec: ISpecJson; body: string }, AppError> {
  const raw = readSpecMd(projectRoot, id);
  if (!raw.ok) return err(raw.error);
  const parsed = splitSpecMd(raw.value);
  if (!parsed.ok) return err(parsed.error);
  const derived = deriveSpecJson(parsed.value);
  if (!derived.ok) return err(derived.error);
  return ok({ spec: derived.value, body: parsed.value.body });
}

export interface ISpecEvent {
  readonly schema: typeof SPEC_EVENTS_SCHEMA_V1;
  readonly ts: string;
  readonly specId: string;
  readonly operation: string;
  readonly verdict?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function appendSpecEvent(
  projectRoot: string,
  id: string,
  event: Omit<ISpecEvent, 'schema' | 'ts' | 'specId'> & { ts?: string },
): Result<void, AppError> {
  try {
    mkdirSync(specDir(projectRoot, id), { recursive: true });
    const entry: ISpecEvent = {
      schema: SPEC_EVENTS_SCHEMA_V1,
      ts: event.ts ?? new Date().toISOString(),
      specId: id,
      operation: event.operation,
      ...(event.verdict !== undefined ? { verdict: event.verdict } : {}),
      ...(event.details !== undefined ? { details: event.details } : {}),
    };
    appendFileSync(specEventsPath(projectRoot, id), JSON.stringify(entry) + '\n', 'utf8');
    return ok(undefined);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, 'Failed to append spec event', { cause: e }),
    );
  }
}

export function readSpecEvents(projectRoot: string, id: string): readonly ISpecEvent[] {
  const p = specEventsPath(projectRoot, id);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, 'utf8');
    const out: ISpecEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as ISpecEvent);
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface IPersistSpecArtifactsInput {
  readonly projectRoot: string;
  readonly id: string;
  readonly md: string;
  readonly json: ISpecJson;
}

export function persistSpecArtifacts(input: IPersistSpecArtifactsInput): Result<void, AppError> {
  const mdRes = writeSpecMd(input.projectRoot, input.id, input.md);
  if (!mdRes.ok) return err(mdRes.error);
  const jsonRes = writeSpecJson(input.projectRoot, input.id, input.json);
  if (!jsonRes.ok) return err(jsonRes.error);
  return ok(undefined);
}
