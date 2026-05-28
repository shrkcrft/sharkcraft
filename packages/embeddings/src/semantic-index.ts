import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

const DEFAULT_MODEL = 'Xenova/bge-base-en-v1.5';
/**
 * Default ONNX weight precision for the embedding model.
 *
 * Why `q8` (int8 quantized): transformers.js 3.x runs ONNX on CPU
 * only in Node — there's no Metal / WebGPU backend outside the
 * browser. On Apple Silicon CPU, `q8` is ~2-3× faster than `fp32`
 * with negligible cosine-similarity drift for retrieval; `fp16` on
 * CPU isn't accelerated by ONNX Runtime's Arm EP, so it offers no
 * speed-up over `fp32`. Override with `SHRK_EMBEDDINGS_DTYPE=fp32`
 * if you need maximum precision (e.g. for a regression study).
 *
 * Accepted values (best → worst for retrieval quality):
 *   `fp32` | `fp16` | `q8` (default) | `int8` | `uint8` | `q4` | `q4f16` | `bnb4`
 *
 * Setting this also silences the "dtype not specified for 'model'.
 * Using the default dtype (fp32) for this device (cpu)" warning
 * that transformers.js emits when no explicit dtype is passed.
 */
const DEFAULT_DTYPE = 'q8';
const INDEX_VERSION = 2;
const INDEX_DIR_NAME = '.sharkcraft/embeddings';
const META_FILE = `index-v${INDEX_VERSION}.meta.json`;
const VECTORS_FILE = `index-v${INDEX_VERSION}.vec.bin`;

export interface ISemanticHit {
  path: string;
  score: number;
}

export interface ISemanticIndexEntry {
  path: string;
  summary?: string | null;
  exports?: readonly string[];
}

export interface ISemanticFreshnessReport {
  hasIndex: boolean;
  model: string | null;
  indexed: number;
  fresh: number;
  stale: number;
  missing: number;
  untracked: number;
  stalePaths: string[];
  untrackedPaths: string[];
  missingPaths: string[];
  corrupt?: boolean;
}

export interface ISemanticRefreshReport {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  totalAfter: number;
  rebuilt: boolean;
}

interface IIndexMeta {
  version: number;
  model: string;
  dimensions: number;
  builtAt: string;
  paths: string[];
  mtimes: Record<string, number>;
}

/**
 * Local semantic search backed by a small sentence-transformer embedding
 * model loaded via `@huggingface/transformers` (ONNX Runtime).
 *
 * Lifecycle:
 *   - `SemanticIndex.tryLoad(cwd)` returns a populated index if a
 *     persisted one is present, the model name matches, and the
 *     vector blob is the expected size. Cheap: no model download.
 *   - `SemanticIndex.build(cwd, entries, opts)` does a full rebuild —
 *     downloads the model on first run, embeds every entry, persists.
 *   - `index.refresh(entries, descriptors, opts)` is the cheap path:
 *     compares fs mtimes against the stored ones, re-embeds only
 *     added/changed files, drops vectors for removed files, and
 *     rewrites the persistent store.
 *   - `searchFiles(query, k)` is a cosine scan over the in-memory
 *     matrix; the query is embedded on demand.
 *
 * Indexing embeds a *descriptor* per file (path + leading doc comment
 * + top export labels), not the full body — keeps the corpus dense,
 * fast to build, and resistant to source churn that doesn't change intent.
 */
export class SemanticIndex {
  /** Optional override used by tests so we don't need to download a model. */
  static _embedderForTests:
    | ((text: string, model: string) => Promise<Float32Array>)
    | null = null;

  private pipelinePromise: Promise<IFeatureExtractionPipeline> | null = null;

  private constructor(
    private meta: IIndexMeta,
    private vectors: Float32Array,
    private readonly cwd: string,
  ) {}

  static async tryLoad(
    cwd: string,
    options: { model?: string } = {},
  ): Promise<SemanticIndex | null> {
    const dir = nodePath.join(cwd, INDEX_DIR_NAME);
    const metaPath = nodePath.join(dir, META_FILE);
    const vecPath = nodePath.join(dir, VECTORS_FILE);
    if (!existsSync(metaPath) || !existsSync(vecPath)) return null;
    let meta: IIndexMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as IIndexMeta;
    } catch {
      return null;
    }
    if (meta.version !== INDEX_VERSION) return null;
    const requestedModel = options.model ?? meta.model;
    if (meta.model !== requestedModel) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(vecPath);
    } catch {
      return null;
    }
    const expectedBytes = meta.paths.length * meta.dimensions * 4;
    if (bytes.length !== expectedBytes) return null;
    // Copy into a freshly-allocated buffer so the Float32Array owns its
    // storage independently of the underlying Buffer (which may be backed
    // by a pooled allocator with extra bytes).
    const owned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(owned).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const vectors = new Float32Array(owned);
    if (!meta.mtimes) meta.mtimes = {};
    return new SemanticIndex(meta, vectors, cwd);
  }

  static async build(
    cwd: string,
    entries: ReadonlyArray<ISemanticIndexEntry>,
    options: { model?: string; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<SemanticIndex> {
    const model = options.model ?? DEFAULT_MODEL;
    const stub = new SemanticIndex(
      {
        version: INDEX_VERSION,
        model,
        dimensions: 0,
        builtAt: new Date().toISOString(),
        paths: [],
        mtimes: {},
      },
      new Float32Array(0),
      cwd,
    );
    const dimensions = await stub.detectDimensions();
    const vectors = new Float32Array(entries.length * dimensions);
    const mtimes: Record<string, number> = {};
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const vec = await stub.embed(buildDescriptor(entry));
      if (vec.length !== dimensions) {
        throw new Error(
          `Embedding for ${entry.path} returned ${vec.length} dims, expected ${dimensions}.`,
        );
      }
      vectors.set(vec, i * dimensions);
      mtimes[entry.path] = readMtime(cwd, entry.path);
      options.onProgress?.(i + 1, entries.length);
    }
    const meta: IIndexMeta = {
      version: INDEX_VERSION,
      model,
      dimensions,
      builtAt: new Date().toISOString(),
      paths: entries.map((e) => e.path),
      mtimes,
    };
    persist(cwd, meta, vectors);
    return new SemanticIndex(meta, vectors, cwd);
  }

  /**
   * Compare the supplied entries against the stored mtimes and
   * re-embed only what changed.
   *
   * `descriptorOf(path)` produces the embedding input for files we
   * have to (re)embed — callers usually pass a closure that reads the
   * file again, since they already had to scan the workspace to
   * produce the entry list.
   */
  async refresh(
    entries: ReadonlyArray<ISemanticIndexEntry>,
    options: {
      onProgress?: (done: number, total: number, action: 'add' | 'change') => void;
    } = {},
  ): Promise<ISemanticRefreshReport> {
    const dim = this.meta.dimensions;
    const newPaths = entries.map((e) => e.path);
    const newPathSet = new Set(newPaths);
    const oldIndexByPath = new Map<string, number>();
    for (let i = 0; i < this.meta.paths.length; i += 1) {
      oldIndexByPath.set(this.meta.paths[i]!, i);
    }

    const work: Array<{ entry: ISemanticIndexEntry; action: 'add' | 'change' }> = [];
    const reused: Array<{ path: string; oldIndex: number }> = [];
    for (const entry of entries) {
      const oldIdx = oldIndexByPath.get(entry.path);
      const currentMtime = readMtime(this.cwd, entry.path);
      if (oldIdx === undefined) {
        work.push({ entry, action: 'add' });
      } else if ((this.meta.mtimes[entry.path] ?? 0) !== currentMtime) {
        work.push({ entry, action: 'change' });
      } else {
        reused.push({ path: entry.path, oldIndex: oldIdx });
      }
    }
    const removed = this.meta.paths.filter((p) => !newPathSet.has(p)).length;

    if (work.length === 0 && removed === 0 && reused.length === this.meta.paths.length) {
      return {
        added: 0,
        changed: 0,
        removed: 0,
        unchanged: reused.length,
        totalAfter: this.meta.paths.length,
        rebuilt: false,
      };
    }

    // Build a new vector matrix in the same path order as `entries`.
    const nextVectors = new Float32Array(entries.length * dim);
    const nextMtimes: Record<string, number> = {};
    const reusedByPath = new Map(reused.map((r) => [r.path, r.oldIndex]));
    let done = 0;
    let added = 0;
    let changed = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const reusedFrom = reusedByPath.get(entry.path);
      if (reusedFrom !== undefined) {
        nextVectors.set(
          this.vectors.subarray(reusedFrom * dim, (reusedFrom + 1) * dim),
          i * dim,
        );
        nextMtimes[entry.path] = this.meta.mtimes[entry.path] ?? readMtime(this.cwd, entry.path);
      } else {
        const vec = await this.embed(buildDescriptor(entry));
        nextVectors.set(vec, i * dim);
        nextMtimes[entry.path] = readMtime(this.cwd, entry.path);
        if (oldIndexByPath.has(entry.path)) changed += 1;
        else added += 1;
        done += 1;
        options.onProgress?.(done, work.length, oldIndexByPath.has(entry.path) ? 'change' : 'add');
      }
    }

    this.meta = {
      ...this.meta,
      builtAt: new Date().toISOString(),
      paths: entries.map((e) => e.path),
      mtimes: nextMtimes,
    };
    this.vectors = nextVectors;
    persist(this.cwd, this.meta, this.vectors);
    return {
      added,
      changed,
      removed,
      unchanged: reused.length,
      totalAfter: entries.length,
      rebuilt: false,
    };
  }

  get fileCount(): number {
    return this.meta.paths.length;
  }

  get modelName(): string {
    return this.meta.model;
  }

  get dimensions(): number {
    return this.meta.dimensions;
  }

  /**
   * Cheap freshness audit: reads the persisted meta and compares
   * stored mtimes against the current filesystem. Never loads the
   * embedding pipeline — safe to call from `shrk doctor`.
   *
   * `currentFiles` is the list of paths the workspace currently
   * considers indexable (typically `listIndexableFiles(cwd)`). The
   * report classifies each as fresh / stale / missing / untracked.
   */
  static freshnessReport(
    cwd: string,
    currentFiles: readonly string[],
  ): ISemanticFreshnessReport {
    const dir = nodePath.join(cwd, INDEX_DIR_NAME);
    const metaPath = nodePath.join(dir, META_FILE);
    if (!existsSync(metaPath)) {
      return {
        hasIndex: false,
        model: null,
        indexed: 0,
        fresh: 0,
        stale: 0,
        missing: 0,
        untracked: currentFiles.length,
        stalePaths: [],
        untrackedPaths: [...currentFiles],
        missingPaths: [],
      };
    }
    let meta: IIndexMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as IIndexMeta;
    } catch {
      return {
        hasIndex: true,
        model: null,
        indexed: 0,
        fresh: 0,
        stale: 0,
        missing: 0,
        untracked: 0,
        stalePaths: [],
        untrackedPaths: [],
        missingPaths: [],
        corrupt: true,
      };
    }
    const storedPaths = new Set(meta.paths);
    const currentSet = new Set(currentFiles);
    const stalePaths: string[] = [];
    const missingPaths: string[] = [];
    let fresh = 0;
    for (const p of meta.paths) {
      if (!currentSet.has(p)) {
        missingPaths.push(p);
        continue;
      }
      const onDisk = readMtime(cwd, p);
      const stored = meta.mtimes?.[p] ?? 0;
      if (stored === onDisk) {
        fresh += 1;
      } else {
        stalePaths.push(p);
      }
    }
    const untrackedPaths = currentFiles.filter((p) => !storedPaths.has(p));
    return {
      hasIndex: true,
      model: meta.model,
      indexed: meta.paths.length,
      fresh,
      stale: stalePaths.length,
      missing: missingPaths.length,
      untracked: untrackedPaths.length,
      stalePaths,
      untrackedPaths,
      missingPaths,
    };
  }

  async searchFiles(query: string, k: number): Promise<ISemanticHit[]> {
    if (this.meta.paths.length === 0) return [];
    const qvec = await this.embed(query);
    if (qvec.length !== this.meta.dimensions) return [];
    const hits: ISemanticHit[] = [];
    for (let i = 0; i < this.meta.paths.length; i += 1) {
      const offset = i * this.meta.dimensions;
      let dot = 0;
      for (let j = 0; j < this.meta.dimensions; j += 1) {
        dot += qvec[j]! * this.vectors[offset + j]!;
      }
      hits.push({ path: this.meta.paths[i]!, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  async embed(text: string): Promise<Float32Array> {
    if (SemanticIndex._embedderForTests) {
      return SemanticIndex._embedderForTests(text, this.meta.model);
    }
    const pipeline = await this.getPipeline();
    return embedViaPipeline(pipeline, text);
  }

  private async detectDimensions(): Promise<number> {
    if (SemanticIndex._embedderForTests) {
      const probe = await SemanticIndex._embedderForTests('probe', this.meta.model);
      return probe.length;
    }
    const pipeline = await this.getPipeline();
    const out = await pipeline('probe', { pooling: 'mean', normalize: true });
    return out.dims[out.dims.length - 1] ?? out.data.length;
  }

  private getPipeline(): Promise<IFeatureExtractionPipeline> {
    if (!this.pipelinePromise) this.pipelinePromise = loadPipeline(this.meta.model);
    return this.pipelinePromise;
  }
}

/**
 * Conventional top-level source roots across common project layouts:
 *
 *   - Monorepo workspaces: `packages`, `apps`, `libs`, `services`, `tools`
 *   - SharkCraft itself: `sharkcraft`, `examples`, `docs`, `e2e`
 *   - Next.js / Nuxt / Remix: `app`, `pages`, `components`, `routes`
 *   - Standard single-package: `src`, `lib`
 *
 * If a project uses a layout that isn't covered (e.g. files in repo
 * root), the lister falls back to a depth-1 scan of `cwd` so the
 * index still builds against *something* useful, and users can pass
 * one or more `--root <dir>` flags to pin specific source roots.
 */
const DEFAULT_SOURCE_ROOTS: readonly string[] = [
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'pages',
  'components',
  'services',
  'routes',
  'packages',
  'examples',
  'sharkcraft',
  'docs',
  'e2e',
  'tools',
];

export interface IListIndexableFilesOptions {
  /** Explicit source roots (relative to `cwd`). Skips the defaults when set. */
  roots?: readonly string[];
}

export function listIndexableFiles(
  cwd: string,
  max = 5000,
  options: IListIndexableFilesOptions = {},
): string[] {
  const explicitRoots = options.roots && options.roots.length > 0 ? options.roots : null;
  const out: string[] = [];

  const rootsToTry = explicitRoots ?? DEFAULT_SOURCE_ROOTS;
  for (const rel of rootsToTry) {
    if (out.length >= max) break;
    const abs = nodePath.isAbsolute(rel) ? rel : nodePath.join(cwd, rel);
    if (!existsSync(abs)) continue;
    walk(abs, cwd, out, max);
  }

  // Fallback: when no conventional root yielded files and the caller
  // didn't pin explicit roots, walk `cwd` at depth 1 so projects with
  // an unconventional layout still produce a non-empty index. This
  // pays the directory-listing cost only once and never recurses
  // beyond the immediate children that aren't already a known root
  // (avoids double-scanning when defaults matched something).
  if (out.length === 0 && !explicitRoots) {
    walkShallow(cwd, cwd, out, max);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, max);
}

/**
 * Depth-1 child scan of `cwd`: indexes loose source files in the repo
 * root and recurses into immediate subdirectories that aren't noise.
 * Stops at `walk`'s usual exclusion list (`node_modules`, `dist`, …)
 * so it doesn't accidentally drag in build output.
 */
function walkShallow(dir: string, cwd: string, out: string[], cap: number): void {
  if (out.length >= cap) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'coverage' || entry === 'out') continue;
    const abs = nodePath.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(abs, cwd, out, cap);
    } else if (stat.isFile() && shouldIndex(entry)) {
      out.push(nodePath.relative(cwd, abs).replace(/\\/g, '/'));
    }
  }
}

/** Same as `DEFAULT_SOURCE_ROOTS`; exported for callers that want to render the list. */
export function getDefaultSourceRoots(): readonly string[] {
  return DEFAULT_SOURCE_ROOTS;
}

function walk(dir: string, cwd: string, out: string[], cap: number): void {
  if (out.length >= cap) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const abs = nodePath.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(abs, cwd, out, cap);
    } else if (stat.isFile() && shouldIndex(entry)) {
      out.push(nodePath.relative(cwd, abs).replace(/\\/g, '/'));
    }
  }
}

function shouldIndex(name: string): boolean {
  return /\.(ts|tsx|js|jsx|md)$/.test(name) && !/\.d\.ts$/.test(name);
}

function buildDescriptor(entry: ISemanticIndexEntry): string {
  const parts: string[] = [entry.path];
  if (entry.summary && entry.summary.length > 0) parts.push(entry.summary);
  if (entry.exports && entry.exports.length > 0) parts.push(`exports: ${entry.exports.slice(0, 12).join(', ')}`);
  return parts.join('\n').slice(0, 2000);
}

function readMtime(cwd: string, path: string): number {
  const abs = nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path);
  try {
    return Math.floor(statSync(abs).mtimeMs);
  } catch {
    return 0;
  }
}

function persist(cwd: string, meta: IIndexMeta, vectors: Float32Array): void {
  const dir = nodePath.join(cwd, INDEX_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(nodePath.join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  writeFileSync(
    nodePath.join(dir, VECTORS_FILE),
    Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength),
  );
}

type IFeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

interface IDisposableFeatureExtractionPipeline {
  (
    input: string | string[],
    options?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
  ): Promise<{ data: Float32Array; dims: number[] }>;
  dispose?: () => Promise<void>;
}

let cachedPipelinePromise: Promise<IDisposableFeatureExtractionPipeline> | null = null;
let cachedPipelineModel = '';

async function loadPipeline(model: string): Promise<IFeatureExtractionPipeline> {
  if (cachedPipelinePromise && cachedPipelineModel === model) return cachedPipelinePromise;
  cachedPipelineModel = model;
  cachedPipelinePromise = (async () => {
    const tf = (await import('@huggingface/transformers')) as {
      pipeline: (
        task: string,
        model: string,
        options?: { dtype?: string; device?: string },
      ) => Promise<IDisposableFeatureExtractionPipeline>;
    };
    const dtype = resolveEmbeddingsDtype();
    return tf.pipeline('feature-extraction', model, { dtype });
  })();
  return cachedPipelinePromise;
}

/**
 * Read the embeddings dtype from env, falling back to `q8`. The string
 * is passed through verbatim to transformers.js — invalid values will
 * surface a runtime error from the library, which is more useful than
 * a silent fallback.
 */
function resolveEmbeddingsDtype(): string {
  const raw = (process.env.SHRK_EMBEDDINGS_DTYPE ?? '').trim();
  return raw.length > 0 ? raw : DEFAULT_DTYPE;
}

/**
 * Release the shared ONNX pipeline so the process can exit cleanly.
 *
 * Reason this exists: @huggingface/transformers (3.x) holds onto
 * ONNX-runtime worker threads via a pthread mutex. When the process
 * exits while those workers are still resident, libc++ aborts with
 * `mutex lock failed: Invalid argument` AFTER the CLI command's
 * stdout has already been flushed. The user sees their result but
 * the shell shows `zsh: abort`. Calling `pipeline.dispose()` walks
 * down through the model + ONNX session and releases the workers
 * cleanly, sidestepping the race.
 *
 * Safe to call multiple times. Safe to call when no pipeline was
 * ever loaded — the cached promise is just `null` and this returns
 * immediately. Errors during dispose are swallowed (it's a best-effort
 * teardown, and the alternative is to crash anyway).
 */
export async function disposeSemanticIndexPipeline(): Promise<void> {
  const pending = cachedPipelinePromise;
  cachedPipelinePromise = null;
  cachedPipelineModel = '';
  if (!pending) return;
  try {
    const pipeline = await pending;
    if (typeof pipeline.dispose === 'function') {
      await pipeline.dispose();
    }
  } catch {
    // Teardown failures are non-fatal — we tried our best.
  }
}

async function embedViaPipeline(
  pipeline: IFeatureExtractionPipeline,
  text: string,
): Promise<Float32Array> {
  const out = await pipeline(text, { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}
