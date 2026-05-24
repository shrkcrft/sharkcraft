import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPatternEnvelope } from '../schema/pattern.ts';
import {
  STRUCTURAL_PATTERN_REGISTRY_SCHEMA,
  validatePatternEnvelope,
  type IPatternRegistry,
  type IPatternValidationResult,
  type IRegisteredPattern,
} from '../schema/pattern-registry.ts';

const REGISTRY_REL = '.sharkcraft/structural/patterns.json';

/**
 * On-disk registry of structural-search patterns. Pattern authors call
 * `add(envelope)` to register a reusable pattern by id; the doctor
 * reads the list to surface freshness + validation state without
 * recomputing matches against the codebase.
 *
 * The store deliberately validates the envelope at write time so a
 * malformed pattern can never sneak past the boundary. Replaying via
 * `validate()` is a no-op when every entry already has
 * `lastValidatedAt` newer than the registry's own mtime.
 */
export class PatternRegistryStore {
  public readonly absPath: string;

  constructor(private readonly projectRoot: string) {
    this.absPath = nodePath.join(projectRoot, REGISTRY_REL);
  }

  exists(): boolean {
    return existsSync(this.absPath);
  }

  read(): IPatternRegistry {
    if (!this.exists()) return emptyRegistry();
    try {
      const raw = JSON.parse(readFileSync(this.absPath, 'utf8')) as IPatternRegistry;
      if (raw.schema !== STRUCTURAL_PATTERN_REGISTRY_SCHEMA) return emptyRegistry();
      return raw;
    } catch {
      return emptyRegistry();
    }
  }

  write(registry: IPatternRegistry): void {
    mkdirSync(nodePath.dirname(this.absPath), { recursive: true });
    writeFileSync(this.absPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  /**
   * Add or replace a pattern by id. Returns the validation result of
   * the envelope; when invalid the registry is NOT modified.
   */
  add(envelope: IPatternEnvelope): {
    result: IPatternValidationResult;
    entry?: IRegisteredPattern;
  } {
    if (!envelope.id) {
      return { result: { ok: false, error: 'pattern envelope is missing required `id`' } };
    }
    const result = validatePatternEnvelope(envelope);
    if (!result.ok) return { result };
    const now = new Date().toISOString();
    const entry: IRegisteredPattern = {
      id: envelope.id,
      ...(envelope.title ? { title: envelope.title } : {}),
      ...(envelope.description ? { description: envelope.description } : {}),
      pattern: envelope.pattern,
      addedAt: now,
      lastValidatedAt: now,
    };
    const reg = this.read();
    const filtered = reg.patterns.filter((p) => p.id !== envelope.id);
    this.write({
      schema: STRUCTURAL_PATTERN_REGISTRY_SCHEMA,
      patterns: [...filtered, entry].sort((a, b) => a.id.localeCompare(b.id)),
    });
    return { result, entry };
  }

  remove(id: string): boolean {
    const reg = this.read();
    const next = reg.patterns.filter((p) => p.id !== id);
    if (next.length === reg.patterns.length) return false;
    this.write({ schema: STRUCTURAL_PATTERN_REGISTRY_SCHEMA, patterns: next });
    return true;
  }

  clear(): boolean {
    if (!this.exists()) return false;
    rmSync(this.absPath);
    return true;
  }

  /**
   * Re-validate every entry. Updates `lastValidatedAt` on success and
   * `lastValidationError` on failure (preserving the entry in the
   * registry — the user can decide whether to remove it). Returns the
   * count of failed entries.
   */
  validateAll(): { total: number; failed: number; errors: ReadonlyArray<{ id: string; error: string }> } {
    const reg = this.read();
    const failed: { id: string; error: string }[] = [];
    const now = new Date().toISOString();
    const next = reg.patterns.map((entry) => {
      const envelope: IPatternEnvelope = {
        schema: 'sharkcraft.structural-pattern/v1',
        id: entry.id,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        pattern: entry.pattern,
      };
      const result = validatePatternEnvelope(envelope);
      if (result.ok) {
        const cleaned: IRegisteredPattern = { ...entry, lastValidatedAt: now };
        delete (cleaned as { lastValidationError?: string }).lastValidationError;
        return cleaned;
      }
      failed.push({ id: entry.id, error: result.error ?? 'invalid pattern' });
      return { ...entry, lastValidationError: result.error ?? 'invalid pattern' };
    });
    if (reg.patterns.length > 0) {
      this.write({ schema: STRUCTURAL_PATTERN_REGISTRY_SCHEMA, patterns: next });
    }
    return { total: reg.patterns.length, failed: failed.length, errors: failed };
  }
}

function emptyRegistry(): IPatternRegistry {
  return { schema: STRUCTURAL_PATTERN_REGISTRY_SCHEMA, patterns: [] };
}
