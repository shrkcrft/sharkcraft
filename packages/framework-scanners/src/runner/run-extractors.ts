import { readFileSync } from 'node:fs';
import { GraphQueryApi, GraphStore, type IEdge, type INode } from '@shrkcrft/graph';
import { FrameworkExtractorRegistry } from '../extractor-api/extractor-registry.ts';
import type { IFrameworkExtractor } from '../extractor-api/framework-extractor.ts';
import { angularExtractor } from '../extractors/angular-extractor.ts';
import { astroExtractor } from '../extractors/astro-extractor.ts';
import { djangoExtractor } from '../extractors/django-extractor.ts';
import { expressExtractor } from '../extractors/express-extractor.ts';
import { fastapiExtractor } from '../extractors/fastapi-extractor.ts';
import { fastifyExtractor } from '../extractors/fastify-extractor.ts';
import { flaskExtractor } from '../extractors/flask-extractor.ts';
import { graphqlExtractor } from '../extractors/graphql-extractor.ts';
import { flutterExtractor } from '../extractors/flutter-extractor.ts';
import { laravelExtractor } from '../extractors/laravel-extractor.ts';
import { nestjsExtractor } from '../extractors/nestjs-extractor.ts';
import { nextjsExtractor } from '../extractors/nextjs-extractor.ts';
import { reactExtractor } from '../extractors/react-extractor.ts';
import { phoenixExtractor } from '../extractors/phoenix-extractor.ts';
import { railsExtractor } from '../extractors/rails-extractor.ts';
import { solidExtractor } from '../extractors/solid-extractor.ts';
import { springExtractor } from '../extractors/spring-extractor.ts';
import { svelteExtractor } from '../extractors/svelte-extractor.ts';
import { vueExtractor } from '../extractors/vue-extractor.ts';
import {
  type IFrameworkManifest,
} from '../schema/framework-schema.ts';
import { FrameworkStore } from '../store/framework-store.ts';
import * as nodePath from 'node:path';

export interface IRunExtractorsOptions {
  projectRoot: string;
  /** Custom registry (e.g. with pack-contributed extractors). Default: built-ins. */
  registry?: FrameworkExtractorRegistry;
  /** Restrict to a subset of frameworks (by name). */
  only?: readonly string[];
  /** Cap on files scanned (for tests). 0 = no cap. */
  maxFiles?: number;
}

export interface IRunExtractorsResult {
  manifest: IFrameworkManifest;
  durationMs: number;
  filesScanned: number;
  diagnostics: readonly string[];
}

/** Built-in registry pre-populated with the bundled extractors. */
export function defaultRegistry(): FrameworkExtractorRegistry {
  const r = new FrameworkExtractorRegistry();
  r.register(nestjsExtractor);
  r.register(reactExtractor);
  r.register(expressExtractor);
  r.register(nextjsExtractor);
  r.register(angularExtractor);
  r.register(vueExtractor);
  r.register(svelteExtractor);
  r.register(fastifyExtractor);
  r.register(fastapiExtractor);
  r.register(solidExtractor);
  r.register(astroExtractor);
  r.register(djangoExtractor);
  r.register(flaskExtractor);
  r.register(springExtractor);
  r.register(railsExtractor);
  r.register(phoenixExtractor);
  r.register(graphqlExtractor);
  r.register(laravelExtractor);
  r.register(flutterExtractor);
  return r;
}

/**
 * Walk the project's source files (via the code graph snapshot) and
 * run every applicable framework extractor. Writes results to the
 * framework store.
 *
 * The code graph must already exist — frameworks are *enriched* views
 * over the graph, not a from-scratch index.
 */
export function runExtractors(options: IRunExtractorsOptions): IRunExtractorsResult {
  const start = Date.now();
  const diagnostics: string[] = [];
  const graphStore = new GraphStore(options.projectRoot);
  if (!graphStore.exists()) {
    throw new Error("code-graph store missing. Run 'shrk graph index' before 'shrk framework index'.");
  }
  const api = GraphQueryApi.fromStore(options.projectRoot);
  const registry = options.registry ?? defaultRegistry();
  const enabled = filterEnabled(registry, options.only);

  const aggregateNodes: INode[] = [];
  const aggregateEdges: IEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  let filesScanned = 0;

  for (const file of api.allFiles()) {
    if (options.maxFiles && options.maxFiles > 0 && filesScanned >= options.maxFiles) break;
    if (!file.path) continue;
    filesScanned += 1;
    let content: string;
    try {
      content = readFileSync(nodePath.resolve(options.projectRoot, file.path), 'utf8');
    } catch {
      continue;
    }
    for (const ex of enabled) {
      if (!safeMatches(ex, file.path, content, diagnostics)) continue;
      try {
        const result = ex.extract({ filePath: file.path, content, fileNodeId: file.id });
        for (const n of result.nodes) {
          if (seenNodeIds.has(n.id)) continue;
          seenNodeIds.add(n.id);
          aggregateNodes.push(n);
        }
        for (const e of result.edges) {
          if (seenEdgeIds.has(e.id)) continue;
          seenEdgeIds.add(e.id);
          aggregateEdges.push(e);
        }
      } catch (err) {
        diagnostics.push(`${ex.framework}: ${file.path}: ${(err as Error).message}`);
      }
    }
  }

  const countsByFramework: Record<string, number> = {};
  const countsBySubtype: Record<string, number> = {};
  for (const n of aggregateNodes) {
    const framework = String((n.data?.['framework'] as string | undefined) ?? 'unknown');
    const subtype = String((n.data?.['subtype'] as string | undefined) ?? 'unknown');
    countsByFramework[framework] = (countsByFramework[framework] ?? 0) + 1;
    const key = `${framework}:${subtype}`;
    countsBySubtype[key] = (countsBySubtype[key] ?? 0) + 1;
  }
  const frameworks = [...new Set(enabled.map((e) => e.framework))].sort();

  const store = new FrameworkStore(options.projectRoot);
  const manifest = store.writeSnapshot(aggregateNodes, aggregateEdges, {
    projectRoot: options.projectRoot,
    lastBuiltAt: new Date().toISOString(),
    lastBuildDurationMs: Date.now() - start,
    countsByFramework,
    countsBySubtype,
    frameworks,
  });
  return { manifest, durationMs: Date.now() - start, filesScanned, diagnostics };
}

function filterEnabled(
  registry: FrameworkExtractorRegistry,
  only: readonly string[] | undefined,
): readonly IFrameworkExtractor[] {
  const all = registry.list();
  if (!only || only.length === 0) return all;
  const set = new Set(only);
  return all.filter((e) => set.has(e.framework));
}

function safeMatches(
  ex: IFrameworkExtractor,
  path: string,
  content: string,
  diagnostics: string[],
): boolean {
  try {
    return ex.fileMatches({ path, content });
  } catch (e) {
    diagnostics.push(`${ex.framework}: fileMatches threw on ${path}: ${(e as Error).message}`);
    return false;
  }
}
