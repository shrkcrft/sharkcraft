import { resolveSourceGlobs, type IRegistryDeclaration } from '@shrkcrft/core';
import { globListSelects } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import type { IReadScope } from '../util/read-scope.ts';
import { unreadMatching } from '../util/read-scope-coverage.ts';
import { collectSourceSites, type IWiringFileEntry } from './evaluate-wiring.ts';

export const REGISTRY_SCHEMA = 'sharkcraft.registry-inventory/v1' as const;

/** Where an id was found (project-relative path + 1-based line). */
export interface IRegistrySite {
  readonly file: string;
  readonly line: number;
}

/** One id in a registry: its declaration sites + (optional) consumer/binding sites. */
export interface IRegistryEntry {
  readonly id: string;
  /** Declaration sites (from `source`), sorted by file then line. */
  readonly sites: readonly IRegistrySite[];
  /** Consumer/binding sites (from `consumer`), when the declaration sets one. */
  readonly consumerSites?: readonly IRegistrySite[];
}

/** A scanned registry inventory: every distinct id and where it lives. */
export interface IRegistryInventory {
  readonly schema: typeof REGISTRY_SCHEMA;
  readonly name: string;
  readonly description?: string;
  /** Distinct ids, sorted, each with its sites. */
  readonly entries: readonly IRegistryEntry[];
  /** Misconfiguration messages (bad regex / no capture group / bad source). */
  readonly diagnostics: readonly string[];
  /**
   * The SOURCE side's read scope: declaration files read, and matched ones the
   * reader did not read (over the read cap, or unreadable). With any unread
   * the inventory is incomplete: an absent id, "no duplicates" or an empty
   * inventory proves nothing.
   */
  readonly readScope: IReadScope;
}

export interface IScanRegistryOptions {
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
}

function sortSites(sites: readonly IRegistrySite[]): IRegistrySite[] {
  return [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Scan a declared registry, returning every distinct id and its declaration
 * (and optional consumer) sites. Pure-engine output; the only IO is a single
 * read-only tree walk over the union of the source/consumer globs.
 */
export function scanRegistry(
  projectRoot: string,
  decl: IRegistryDeclaration,
  options: IScanRegistryOptions = {},
): IRegistryInventory {
  const globs = [
    ...new Set([
      ...resolveSourceGlobs(decl.source),
      ...(decl.consumer ? resolveSourceGlobs(decl.consumer) : []),
    ]),
  ];
  const matched = readMatchingFiles(projectRoot, globs, new Set(options.excludeDirs ?? []));
  const entries: IWiringFileEntry[] = [...matched.files.entries()].map(([path, content]) => ({ path, content }));

  const diagnostics: string[] = [];
  // The walk above is the POSITIVE union of both sides; each side selects its
  // own files, so the source's `!` never hides a consumer file (or vice versa).
  const sourceFiles = entries.filter((f) => globListSelects(f.path, resolveSourceGlobs(decl.source)));
  const declared = collectSourceSites(decl.source, sourceFiles);
  if (declared.error) diagnostics.push(`registry "${decl.name}" source: ${declared.error}`);

  const consumerByToken = new Map<string, IRegistrySite[]>();
  if (decl.consumer) {
    const consumerFiles = entries.filter((f) => globListSelects(f.path, resolveSourceGlobs(decl.consumer!)));
    const consumed = collectSourceSites(decl.consumer, consumerFiles);
    if (consumed.error) diagnostics.push(`registry "${decl.name}" consumer: ${consumed.error}`);
    for (const s of consumed.sites) {
      const list = consumerByToken.get(s.token) ?? [];
      list.push({ file: s.file, line: s.line });
      consumerByToken.set(s.token, list);
    }
  }

  const declaredByToken = new Map<string, IRegistrySite[]>();
  for (const s of declared.sites) {
    const list = declaredByToken.get(s.token) ?? [];
    list.push({ file: s.file, line: s.line });
    declaredByToken.set(s.token, list);
  }

  const entriesOut: IRegistryEntry[] = [...declaredByToken.keys()].sort().map((id) => {
    const consumerSites = consumerByToken.get(id);
    return {
      id,
      sites: sortSites(declaredByToken.get(id) ?? []),
      ...(consumerSites && consumerSites.length > 0 ? { consumerSites: sortSites(consumerSites) } : {}),
    };
  });

  return {
    schema: REGISTRY_SCHEMA,
    name: decl.name,
    ...(decl.description ? { description: decl.description } : {}),
    entries: entriesOut,
    diagnostics,
    readScope: {
      read: sourceFiles.length,
      unread: unreadMatching(matched.unread, resolveSourceGlobs(decl.source)),
    },
  };
}

/** True if `id` is declared in the registry (alias-blind exact membership). */
export function registryExists(inventory: IRegistryInventory, id: string): boolean {
  return inventory.entries.some((e) => e.id === id);
}

/** The entry for `id`, or undefined if not declared. */
export function registryWhere(inventory: IRegistryInventory, id: string): IRegistryEntry | undefined {
  return inventory.entries.find((e) => e.id === id);
}

/**
 * Ids declared in more than one place.
 *
 * A latent bug the compiler cannot see: two roots both claiming the same
 * registry id compile fine, and whichever registration wins at runtime is an
 * accident of load order. Reported with EVERY site so the duplicate can be
 * resolved, not just detected.
 */
export function registryDuplicates(inventory: IRegistryInventory): readonly IRegistryEntry[] {
  return inventory.entries.filter((e) => e.sites.length > 1);
}
