import {
  EdgeKind,
  type IGraphSnapshot,
  NodeKind,
} from '@shrkcrft/graph';
import {
  API_SURFACE_SCHEMA,
  type ApiSymbolKind,
  type IApiSurface,
  type IPublicSymbol,
} from '../schema/api-surface.ts';

export interface IExtractSurfaceOptions {
  /** Restrict surface to these package names. */
  packageFilter?: readonly string[];
  /** Include only declared symbols (excludes re-exports). Default true. */
  includeDeclaredOnly?: boolean;
}

/**
 * Walk a graph snapshot and produce a deterministic `IApiSurface`.
 *
 * A "public" symbol is any `symbol:` node whose `data.isExported`
 * is true. The owning file (and its owning package) are resolved via
 * the symbol node id (`symbol:<filePath>#<name>`) and the file's
 * BelongsToPackage edge.
 */
export function extractApiSurface(
  snap: IGraphSnapshot,
  options: IExtractSurfaceOptions = {},
): IApiSurface {
  const filter = options.packageFilter && options.packageFilter.length > 0
    ? new Set(options.packageFilter)
    : undefined;

  // Build file → package map from BelongsToPackage edges.
  const fileToPackage = new Map<string, string>();
  for (const e of snap.edges.values()) {
    if (e.kind !== EdgeKind.BelongsToPackage) continue;
    const fileId = e.from;
    const pkgId = e.to;
    if (!fileId.startsWith('file:') || !pkgId.startsWith('package:')) continue;
    fileToPackage.set(fileId, pkgId.slice('package:'.length));
  }

  const symbols: IPublicSymbol[] = [];
  for (const node of snap.nodes.values()) {
    if (node.kind !== NodeKind.Symbol) continue;
    const exported = (node.data?.['isExported'] ?? false) === true;
    if (!exported) continue;
    const file = node.path;
    if (!file) continue;
    const fileId = `file:${file}`;
    const pkg = fileToPackage.get(fileId);
    if (filter && (!pkg || !filter.has(pkg))) continue;
    const visibility = (node.data?.['visibility'] as string | undefined) ?? '';
    const isDefault = visibility === 'default';
    symbols.push({
      id: node.id,
      name: node.label,
      kind: ((node.data?.['declKind'] as string | undefined) ?? 'unknown') as ApiSymbolKind,
      file,
      ...(pkg ? { package: pkg } : {}),
      isDefault,
    });
  }
  symbols.sort((a, b) => a.id.localeCompare(b.id));
  const counts: Record<string, number> = {};
  for (const s of symbols) {
    const key = s.package ?? '<no-package>';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  // Surface filter entries that matched no known package so callers can fail
  // loudly instead of returning a silent 0-symbol surface.
  const knownPackages = new Set(fileToPackage.values());
  const unmatchedFilters =
    options.packageFilter?.filter((p) => !knownPackages.has(p)) ?? [];
  return {
    schema: API_SURFACE_SCHEMA,
    projectRoot: snap.manifest.projectRoot,
    ...(options.packageFilter && options.packageFilter.length > 0 ? { packageFilter: options.packageFilter } : {}),
    ...(unmatchedFilters.length > 0 ? { unmatchedFilters } : {}),
    symbols,
    countsByPackage: counts,
    total: symbols.length,
  };
}

