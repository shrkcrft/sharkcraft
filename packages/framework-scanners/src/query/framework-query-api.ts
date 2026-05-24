import type { IEdge, INode } from '@shrkcrft/graph';
import { FrameworkStore } from '../store/framework-store.ts';
import type { IFrameworkSnapshot } from '../schema/framework-schema.ts';

export interface IFrameworkListOptions {
  framework?: string;
  subtype?: string;
  /** Filter by project-relative file path. */
  file?: string;
  /** Cap on returned entities. Default 200. */
  limit?: number;
}

/**
 * Read-only query API for the framework snapshot. Merges in-memory
 * with the code-graph snapshot when callers need cross-store joins
 * (e.g. "entities declared in file F"). For the MVP the file
 * relationship is read from the framework store's edges directly.
 */
export class FrameworkQueryApi {
  private readonly entitiesByFile: ReadonlyMap<string, readonly INode[]>;
  private readonly entitiesByKey: ReadonlyMap<string, readonly INode[]>;

  constructor(private readonly snap: IFrameworkSnapshot) {
    const byFile = new Map<string, INode[]>();
    const byKey = new Map<string, INode[]>();
    for (const n of snap.nodes.values()) {
      if (n.path) {
        const list = byFile.get(n.path);
        if (list) list.push(n);
        else byFile.set(n.path, [n]);
      }
      const key = `${n.data?.['framework'] ?? '?'}:${n.data?.['subtype'] ?? '?'}`;
      const klist = byKey.get(key);
      if (klist) klist.push(n);
      else byKey.set(key, [n]);
    }
    this.entitiesByFile = byFile;
    this.entitiesByKey = byKey;
  }

  static fromStore(projectRoot: string): FrameworkQueryApi {
    const s = new FrameworkStore(projectRoot).loadSnapshot();
    return new FrameworkQueryApi(s);
  }

  static missingDescription(projectRoot: string): string | undefined {
    const exists = new FrameworkStore(projectRoot).exists();
    return exists ? undefined : "Framework store missing. Run 'shrk framework index'.";
  }

  manifest(): IFrameworkSnapshot['manifest'] {
    return this.snap.manifest;
  }

  /** Entities declared in a specific file. */
  forFile(filePath: string): readonly INode[] {
    return this.entitiesByFile.get(filePath) ?? [];
  }

  /** List entities, optionally filtered by framework + subtype + file. */
  list(opts: IFrameworkListOptions = {}): readonly INode[] {
    const limit = opts.limit ?? 200;
    if (opts.framework && opts.subtype) {
      const key = `${opts.framework}:${opts.subtype}`;
      const hits = this.entitiesByKey.get(key) ?? [];
      return filterFile(hits, opts.file).slice(0, limit);
    }
    const out: INode[] = [];
    for (const list of this.entitiesByKey.values()) {
      for (const n of list) {
        if (opts.framework && (n.data?.['framework'] as string | undefined) !== opts.framework) continue;
        if (opts.subtype && (n.data?.['subtype'] as string | undefined) !== opts.subtype) continue;
        if (opts.file && n.path !== opts.file) continue;
        out.push(n);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Returns all NestJS routes flattened to `{method, path, handler, file}`. */
  routes(): readonly { method: string; path: string; handler: string; file: string }[] {
    const out: { method: string; path: string; handler: string; file: string }[] = [];
    for (const n of this.snap.nodes.values()) {
      if (n.data?.['framework'] !== 'nestjs') continue;
      if (n.data?.['subtype'] !== 'route') continue;
      out.push({
        method: (n.data['method'] as string | undefined) ?? '?',
        path: (n.data['path'] as string | undefined) ?? '/',
        handler: `${(n.data['className'] as string | undefined) ?? '?'}.${(n.data['handler'] as string | undefined) ?? '?'}`,
        file: n.path ?? '',
      });
    }
    return out.sort((a, b) =>
      a.method.localeCompare(b.method) || a.path.localeCompare(b.path) || a.handler.localeCompare(b.handler),
    );
  }

  /** All framework-scoped edges. */
  edges(): readonly IEdge[] {
    return [...this.snap.edges.values()];
  }
}

function filterFile(nodes: readonly INode[], file: string | undefined): readonly INode[] {
  if (!file) return nodes;
  return nodes.filter((n) => n.path === file);
}
