/**
 * THE pack-asset freshness authority — divergence by CONTENT, never age.
 *
 * Three mtime heuristics used to answer "is this pack stale?" (dev-status:
 * signed-file mtime vs `src/assets` +500ms; signature-status and the
 * contributions inventory: `signedAt` vs contribution mtimes +1000ms). They
 * disagreed in both directions on the same pack, and none of them could see
 * the case that actually bites: a compiled `dist/*.js` contribution built from
 * an OLDER `src/*.ts` — shrk serves the previous build while every surface
 * says OK.
 *
 * One question, one answer, from recorded content:
 *
 *   - **signature** — `shrk packs sign` records `sha256` of every contribution
 *     file (and each compiled artifact's mapped source) on the signature
 *     (`contentDigests`). Fresh iff every recorded file still has that content.
 *     A signature with no record for a file is `unrecorded` — NOT verified,
 *     never fresh.
 *   - **build** — for each compiled contribution with a mapped source on disk,
 *     the build-time record is the source map's `sourcesContent` (what the
 *     compiler actually read) or, failing that, the signature's digests of the
 *     artifact + source pair. Stale iff the source's content differs from the
 *     record; `unrecorded` when no record exists.
 *
 * Consumed by `packs signature-status`, `packs dev-status`, the contributions
 * inventory's stale-signature conflict, `packs doctor`, `shrk doctor` and the
 * CLI startup warning — all of them read this function, none recompute it.
 * Computed on read (never cached on the discovery object, whose cache is keyed
 * by the lockfile and would itself go stale).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  CONTRIBUTION_FILE_KEYS,
  FUTURE_CONTRIBUTION_FILE_KEYS,
  type ISharkCraftPackManifest,
} from '@shrkcrft/plugin-api';

export interface IPackAssetFreshness {
  readonly packageName: string;
  readonly packageRoot: string;
  /** Always content digests — this authority never reads an mtime. */
  readonly basis: 'content-digest';
  readonly signature: {
    /**
     * `fresh` — every file the signature recorded still has that content ·
     * `diverged` — a recorded file's content changed (or it was deleted) since
     * signing · `unrecorded` — signed, but no content record for some file, so
     * freshness is NOT verified · `unsigned` — no signature block.
     */
    readonly state: 'fresh' | 'diverged' | 'unrecorded' | 'unsigned';
    readonly signedAt?: string;
    readonly dev: boolean;
    /** Pack-relative files whose content differs from the signed record. */
    readonly diverged: readonly string[];
    /** Pack-relative files the signature holds no content record for. */
    readonly unrecorded: readonly string[];
  };
  readonly build: {
    /**
     * `not-compiled` — no compiled (`.js`/`.mjs`/`.cjs`) contribution ·
     * `no-source` — compiled, but no mapped source on disk (an installed
     * package) · `stale` — a source differs from its build record ·
     * `unrecorded` — a source exists but no build record does · `fresh`.
     */
    readonly state: 'fresh' | 'stale' | 'unrecorded' | 'no-source' | 'not-compiled';
    readonly artifacts: readonly {
      readonly artifact: string;
      readonly source: string | null;
      readonly state: 'fresh' | 'stale' | 'unrecorded' | 'no-source';
      readonly recordedBy?: 'source-map' | 'signature';
    }[];
    /** `npm run build` when the pack declares a build script, else null. */
    readonly rebuildCommand: string | null;
  };
}

const COMPILED_EXT = /\.(?:js|mjs|cjs)$/i;
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out']);

/** `sha256:<hex>` of a file's bytes (or of a string's UTF-8 bytes). */
export function packContentDigest(content: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function toPosix(p: string): string {
  return p.split(nodePath.sep).join('/');
}

function relToPack(packageRoot: string, abs: string): string {
  return toPosix(nodePath.relative(packageRoot, abs));
}

function digestFile(abs: string): string | null {
  try {
    return packContentDigest(readFileSync(abs));
  } catch {
    return null;
  }
}

function readJsonTolerant(file: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every declared contribution file that exists, pack-relative, deduped, sorted. */
function contributionFiles(packageRoot: string, manifest: ISharkCraftPackManifest | undefined): string[] {
  const out = new Set<string>();
  const contributions = (manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
  for (const key of [...CONTRIBUTION_FILE_KEYS, ...FUTURE_CONTRIBUTION_FILE_KEYS]) {
    for (const rel of contributions[key] ?? []) {
      if (typeof rel !== 'string' || rel.length === 0) continue;
      const abs = nodePath.resolve(packageRoot, rel);
      if (existsSync(abs)) out.add(relToPack(packageRoot, abs));
    }
  }
  return [...out].sort();
}

function sourceExtensionsFor(artifactExt: string): readonly string[] {
  if (artifactExt === '.mjs') return ['.mts', '.ts'];
  if (artifactExt === '.cjs') return ['.cts', '.ts'];
  return ['.ts', '.tsx'];
}

/**
 * The source a compiled artifact was built from: tsconfig `outDir` → `rootDir`
 * (or `src` / `.` when `rootDir` is unset), else the `dist|build|lib|out` →
 * `src` convention. `null` when no candidate exists on disk.
 */
function mapCompiledSource(packageRoot: string, artifactRel: string): string | null {
  const ext = nodePath.extname(artifactRel).toLowerCase();
  const stem = artifactRel.slice(0, -ext.length);
  const candidates: string[] = [];
  const tsconfig = readJsonTolerant(nodePath.join(packageRoot, 'tsconfig.json'));
  const co = (tsconfig?.['compilerOptions'] ?? {}) as { outDir?: unknown; rootDir?: unknown };
  if (typeof co.outDir === 'string') {
    const outDir = toPosix(nodePath.normalize(co.outDir)).replace(/^\.\//, '').replace(/\/$/, '');
    if (stem.startsWith(outDir + '/')) {
      const rest = stem.slice(outDir.length + 1);
      const roots =
        typeof co.rootDir === 'string'
          ? [toPosix(nodePath.normalize(co.rootDir)).replace(/^\.\//, '').replace(/\/$/, '')]
          : ['src', '.'];
      for (const r of roots) candidates.push(r === '.' || r === '' ? rest : `${r}/${rest}`);
    }
  }
  const [first, ...rest] = stem.split('/');
  if (first && BUILD_DIRS.has(first) && rest.length > 0) candidates.push(`src/${rest.join('/')}`);
  for (const c of candidates) {
    for (const e of sourceExtensionsFor(ext)) {
      const rel = c + e;
      if (existsSync(nodePath.join(packageRoot, rel))) return rel;
    }
  }
  return null;
}

/** The compiled contributions of a pack and their mapped sources. */
function compiledArtifacts(
  packageRoot: string,
  files: readonly string[],
): { artifact: string; source: string | null }[] {
  return files
    .filter((f) => COMPILED_EXT.test(f))
    .map((artifact) => ({ artifact, source: mapCompiledSource(packageRoot, artifact) }));
}

/**
 * The digest the artifact's source map recorded for `sourceRel` at build time
 * (`sourcesContent`), or null when there is no map or it carries no content.
 */
function sourceMapRecordedDigest(packageRoot: string, artifactRel: string, sourceRel: string): string | null {
  const artifactAbs = nodePath.join(packageRoot, artifactRel);
  let text: string;
  try {
    text = readFileSync(artifactAbs, 'utf8');
  } catch {
    return null;
  }
  let map: { sources?: unknown; sourcesContent?: unknown; sourceRoot?: unknown } | null = null;
  let mapDir = nodePath.dirname(artifactAbs);
  const urlMatch = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(text.slice(-4096));
  const url = urlMatch?.[1];
  try {
    if (url && url.startsWith('data:')) {
      const b64 = url.slice(url.indexOf(',') + 1);
      map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else {
      const mapAbs = url ? nodePath.resolve(mapDir, url) : `${artifactAbs}.map`;
      if (existsSync(mapAbs)) {
        map = JSON.parse(readFileSync(mapAbs, 'utf8'));
        mapDir = nodePath.dirname(mapAbs);
      }
    }
  } catch {
    map = null;
  }
  if (!map || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) return null;
  const sourceAbs = nodePath.join(packageRoot, sourceRel);
  const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  for (let i = 0; i < map.sources.length; i += 1) {
    const s = map.sources[i];
    const content = (map.sourcesContent as unknown[])[i];
    if (typeof s !== 'string' || typeof content !== 'string') continue;
    const cleaned = s.replace(/^(?:file|webpack):\/+/, s.startsWith('file://') ? '/' : '');
    if (nodePath.resolve(mapDir, root, cleaned) === sourceAbs) return packContentDigest(content);
  }
  return null;
}

/**
 * The content record `shrk packs sign` stores on the signature: every
 * contribution file plus each compiled artifact's mapped source. The SAME
 * enumeration {@link detectPackAssetFreshness} compares against — one function
 * records, the other reads, so they cannot disagree about which files count.
 */
export function computePackContentDigests(
  packageRoot: string,
  manifest: ISharkCraftPackManifest | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const files = contributionFiles(packageRoot, manifest);
  const tracked = new Set(files);
  for (const a of compiledArtifacts(packageRoot, files)) if (a.source) tracked.add(a.source);
  for (const rel of [...tracked].sort()) {
    const d = digestFile(nodePath.join(packageRoot, rel));
    if (d) out[rel] = d;
  }
  return out;
}

/** True when any contribution is a compiled `.js`/`.mjs`/`.cjs` file (cheap; no hashing). */
export function packHasCompiledContributions(manifest: ISharkCraftPackManifest | undefined): boolean {
  const contributions = (manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
  for (const key of [...CONTRIBUTION_FILE_KEYS, ...FUTURE_CONTRIBUTION_FILE_KEYS]) {
    if ((contributions[key] ?? []).some((rel) => typeof rel === 'string' && COMPILED_EXT.test(rel))) return true;
  }
  return false;
}

function rebuildCommandFor(packageRoot: string): string | null {
  const pkg = readJsonTolerant(nodePath.join(packageRoot, 'package.json'));
  const scripts = (pkg?.['scripts'] ?? {}) as Record<string, unknown>;
  return typeof scripts['build'] === 'string' ? 'npm run build' : null;
}

/** Detect one pack's signature + build freshness from recorded content. */
export function detectPackAssetFreshness(pack: {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly manifest?: ISharkCraftPackManifest;
}): IPackAssetFreshness {
  const { packageRoot, manifest } = pack;
  const files = contributionFiles(packageRoot, manifest);
  const artifacts = compiledArtifacts(packageRoot, files);
  const current = new Map<string, string | null>();
  const digestOf = (rel: string): string | null => {
    if (!current.has(rel)) current.set(rel, digestFile(nodePath.join(packageRoot, rel)));
    return current.get(rel) ?? null;
  };

  // ── signature ──
  const sig = manifest?.signature;
  const recorded = sig?.contentDigests ?? {};
  const diverged: string[] = [];
  const unrecorded: string[] = [];
  let signatureState: IPackAssetFreshness['signature']['state'] = 'unsigned';
  if (sig) {
    const checked = new Set<string>([...files, ...artifacts.flatMap((a) => (a.source ? [a.source] : []))]);
    for (const rel of [...checked].sort()) {
      const was = recorded[rel];
      if (was === undefined) unrecorded.push(rel);
      else if (digestOf(rel) !== was) diverged.push(rel);
    }
    // A recorded file that no longer exists diverged too (deleted since signing).
    for (const rel of Object.keys(recorded).sort()) {
      if (!checked.has(rel) && !existsSync(nodePath.join(packageRoot, rel))) diverged.push(rel);
    }
    signatureState = diverged.length > 0 ? 'diverged' : unrecorded.length > 0 ? 'unrecorded' : 'fresh';
  }

  // ── build ──
  const artifactStates = artifacts.map((a) => {
    if (!a.source) return { artifact: a.artifact, source: null, state: 'no-source' as const };
    const sourceNow = digestOf(a.source);
    const mapRecord = sourceMapRecordedDigest(packageRoot, a.artifact, a.source);
    if (mapRecord) {
      return {
        artifact: a.artifact,
        source: a.source,
        state: mapRecord === sourceNow ? ('fresh' as const) : ('stale' as const),
        recordedBy: 'source-map' as const,
      };
    }
    const recArtifact = recorded[a.artifact];
    const recSource = recorded[a.source];
    if (recArtifact !== undefined && recSource !== undefined && digestOf(a.artifact) === recArtifact) {
      // The artifact is exactly the signed build; its source must still be the signed source.
      return {
        artifact: a.artifact,
        source: a.source,
        state: sourceNow === recSource ? ('fresh' as const) : ('stale' as const),
        recordedBy: 'signature' as const,
      };
    }
    return { artifact: a.artifact, source: a.source, state: 'unrecorded' as const };
  });
  const buildState: IPackAssetFreshness['build']['state'] =
    artifactStates.length === 0
      ? 'not-compiled'
      : artifactStates.some((a) => a.state === 'stale')
        ? 'stale'
        : artifactStates.some((a) => a.state === 'unrecorded')
          ? 'unrecorded'
          : artifactStates.every((a) => a.state === 'no-source')
            ? 'no-source'
            : 'fresh';

  return {
    packageName: pack.packageName,
    packageRoot,
    basis: 'content-digest',
    signature: {
      state: signatureState,
      ...(sig?.signedAt ? { signedAt: sig.signedAt } : {}),
      dev: sig?.dev === true,
      diverged,
      unrecorded,
    },
    build: {
      state: buildState,
      artifacts: artifactStates,
      rebuildCommand: artifactStates.length > 0 ? rebuildCommandFor(packageRoot) : null,
    },
  };
}

function firstWith(
  f: IPackAssetFreshness,
  state: 'stale' | 'unrecorded',
): { artifact: string; source: string | null } | undefined {
  return f.build.artifacts.find((a) => a.state === state);
}

/**
 * THE wording of a pack's freshness — every surface prints these sentences
 * rather than composing its own. `undefined` when there is nothing to say.
 */
export function describePackAssetFreshness(f: IPackAssetFreshness): {
  readonly build?: string;
  readonly signature?: string;
} {
  const out: { build?: string; signature?: string } = {};
  const where = f.build.rebuildCommand ? ` — run \`${f.build.rebuildCommand}\` in ${f.packageRoot}` : '';
  if (f.build.state === 'stale') {
    const n = f.build.artifacts.filter((a) => a.state === 'stale').length;
    const eg = firstWith(f, 'stale');
    out.build =
      `pack ${f.packageName}: ${n} compiled artifact(s) differ from their source` +
      (eg ? ` (e.g. ${eg.artifact} was built from an older ${eg.source})` : '') +
      ` — shrk is serving the previous build${where || '; rebuild the pack'}`;
  } else if (f.build.state === 'unrecorded') {
    const n = f.build.artifacts.filter((a) => a.state === 'unrecorded').length;
    const eg = firstWith(f, 'unrecorded');
    out.build =
      `pack ${f.packageName}: ${n} compiled artifact(s)` +
      (eg ? ` (e.g. ${eg.artifact})` : '') +
      ` have no build record, so shrk cannot tell whether they match ${eg?.source ?? 'their source'} — NOT VERIFIED. ` +
      'Emit source maps with sourcesContent ("sourceMap": true, "inlineSources": true) or record one with `shrk packs sign`.';
  }
  if (f.signature.state === 'diverged') {
    const first = f.signature.diverged[0]!;
    const more = f.signature.diverged.length > 1 ? ` (+${f.signature.diverged.length - 1} more)` : '';
    out.signature =
      `pack ${f.packageName}: signature is stale — "${first}"${more} changed since it was signed` +
      (f.signature.signedAt ? ` (${f.signature.signedAt})` : '');
  } else if (f.signature.state === 'unrecorded') {
    const first = f.signature.unrecorded[0]!;
    const more = f.signature.unrecorded.length > 1 ? ` (+${f.signature.unrecorded.length - 1} more)` : '';
    out.signature =
      `pack ${f.packageName}: signature freshness NOT verified — it records no content digest for "${first}"${more} ` +
      '(signed before content digests existed, or the file was added since); re-sign to record one';
  }
  return out;
}
