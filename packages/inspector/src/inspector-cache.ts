import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';

export type LoaderAssetKind =
  | 'knowledge'
  | 'rules'
  | 'paths'
  | 'docs'
  | 'templates'
  | 'pipelines'
  | 'presets'
  | 'boundaries';

export type LoaderAssetStatus = 'ok' | 'failed' | 'timeout';

export interface ICachedAssetEntry {
  v: 1;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  contentHashPrefix: string;
  status: LoaderAssetStatus;
  elapsedMs: number;
  recordedAtMs: number;
  kind: LoaderAssetKind;
  ids: readonly string[];
  warningCount: number;
  errorMessage?: string;
  timedOut?: boolean;
}

export interface IInspectorCache {
  readonly enabled: boolean;
  readonly dir: string;
  /** Get the persisted entry for a path (regardless of freshness). */
  get(filePath: string): ICachedAssetEntry | null;
  /** Persist (best-effort) — no-op when disabled. */
  put(entry: ICachedAssetEntry): void;
  /** True iff the on-disk entry matches the current file fingerprint. */
  isFreshFor(filePath: string, entry: ICachedAssetEntry): boolean;
  /** Inspect the resolved cache directory for diagnostics. */
  list(): readonly ICachedAssetEntry[];
}

export interface IInspectorCacheOptions {
  projectRoot: string;
  enabled?: boolean;
}

const CACHE_REL_DIR = '.sharkcraft/cache/inspector/v1';

function fileKey(filePath: string): string {
  const abs = nodePath.resolve(filePath);
  return createHash('sha256').update(abs).digest('hex').slice(0, 32);
}

class DiskInspectorCache implements IInspectorCache {
  readonly enabled: boolean;
  readonly dir: string;

  constructor(options: IInspectorCacheOptions) {
    this.enabled = options.enabled ?? true;
    this.dir = nodePath.join(options.projectRoot, CACHE_REL_DIR);
    if (this.enabled && !existsSync(this.dir)) {
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch {
        // best-effort
      }
    }
  }

  get(filePath: string): ICachedAssetEntry | null {
    if (!this.enabled) return null;
    const fp = nodePath.join(this.dir, fileKey(filePath) + '.json');
    if (!existsSync(fp)) return null;
    try {
      const raw = readFileSync(fp, 'utf8');
      const parsed = JSON.parse(raw) as ICachedAssetEntry;
      if (parsed.v !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  put(entry: ICachedAssetEntry): void {
    if (!this.enabled) return;
    const fp = nodePath.join(this.dir, fileKey(entry.filePath) + '.json');
    try {
      writeFileSync(fp, JSON.stringify(entry));
    } catch {
      // best-effort
    }
  }

  isFreshFor(filePath: string, entry: ICachedAssetEntry): boolean {
    if (!this.enabled) return false;
    try {
      const st = statSync(filePath);
      return st.mtimeMs === entry.mtimeMs && st.size === entry.sizeBytes;
    } catch {
      return false;
    }
  }

  list(): readonly ICachedAssetEntry[] {
    if (!this.enabled || !existsSync(this.dir)) return [];
    const out: ICachedAssetEntry[] = [];
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = readFileSync(nodePath.join(this.dir, name), 'utf8');
          const parsed = JSON.parse(raw) as ICachedAssetEntry;
          if (parsed.v === 1) out.push(parsed);
        } catch {
          // skip
        }
      }
    } catch {
      // best-effort
    }
    return out;
  }
}

export function createInspectorCache(options: IInspectorCacheOptions): IInspectorCache {
  return new DiskInspectorCache(options);
}

export interface IFileFingerprint {
  mtimeMs: number;
  sizeBytes: number;
  contentHashPrefix: string;
}

export function computeFileFingerprint(filePath: string): IFileFingerprint | null {
  try {
    const st = statSync(filePath);
    const buf = readFileSync(filePath);
    return {
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      contentHashPrefix: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    };
  } catch {
    return null;
  }
}
