import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IRegistrationIdiom, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles, walkMatching } from '../util/walk-files.ts';
import { collectSourceSites, type IWiringFileEntry } from './evaluate-wiring.ts';

export const REGISTRATION_GRAPH_SCHEMA = 'sharkcraft.registration-graph/v1' as const;

/** A token role-site: which idiom + file:line it was found at. */
export interface IRegistrationSite {
  readonly idiom: string;
  readonly file: string;
  readonly line: number;
}

/** One token in the registration graph and the three roles it plays. */
export interface IRegistrationNode {
  readonly token: string;
  /** Sites where the token is DECLARED (token/provider definition). */
  readonly declared: readonly IRegistrationSite[];
  /** Sites where the token is PROVIDED / REGISTERED into a composition. */
  readonly provided: readonly IRegistrationSite[];
  /** Sites where the token is CONSUMED / INJECTED. */
  readonly consumed: readonly IRegistrationSite[];
}

/**
 * The registration / DI graph: a peer to the import graph extracted from the
 * declared idiom shapes, keyed by token. Distinct edge kinds (declared /
 * provided / consumed) so the runtime-wiring questions imports can't answer
 * become deterministic queries.
 */
export interface IRegistrationGraph {
  readonly schema: typeof REGISTRATION_GRAPH_SCHEMA;
  /** Idiom names that contributed to this graph. */
  readonly idioms: readonly string[];
  /** Every distinct token, sorted, with its role-sites. */
  readonly tokens: readonly IRegistrationNode[];
  /** Misconfiguration messages (bad regex / no capture group / bad source). */
  readonly diagnostics: readonly string[];
}

export interface IBuildRegistrationGraphOptions {
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
}

function sortSites(sites: readonly IRegistrationSite[]): IRegistrationSite[] {
  return [...sites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.idiom.localeCompare(b.idiom),
  );
}

/** Union (deduped) of every glob any role of any idiom references. */
function registrationGlobs(idioms: readonly IRegistrationIdiom[]): string[] {
  return [
    ...new Set(
      idioms.flatMap((i) => [...i.declared.files, ...i.provided.files, ...i.consumed.files]),
    ),
  ];
}

/**
 * Build the registration/DI graph from the declared idioms. For each idiom the
 * three roles (declared / provided / consumed) are extracted with the shared
 * alias-aware {@link collectSourceSites}, then bucketed by token across every
 * idiom. Pure-engine output; the only IO is a single read-only tree walk over
 * the union of all idiom globs. Never throws — a misconfigured source becomes a
 * diagnostic.
 */
export function buildRegistrationGraph(
  projectRoot: string,
  idioms: readonly IRegistrationIdiom[],
  options: IBuildRegistrationGraphOptions = {},
): IRegistrationGraph {
  const cache = readMatchingFiles(
    projectRoot,
    registrationGlobs(idioms),
    new Set(options.excludeDirs ?? []),
  );
  const entries: IWiringFileEntry[] = [...cache.entries()].map(([path, content]) => ({
    path,
    content,
  }));
  const filesFor = (source: IWiringSource): IWiringFileEntry[] =>
    entries.filter((f) => matchesAny(f.path, source.files));

  const declared = new Map<string, IRegistrationSite[]>();
  const provided = new Map<string, IRegistrationSite[]>();
  const consumed = new Map<string, IRegistrationSite[]>();
  const diagnostics: string[] = [];

  const harvest = (
    idiom: string,
    role: 'declared' | 'provided' | 'consumed',
    source: IWiringSource,
    into: Map<string, IRegistrationSite[]>,
  ): void => {
    const res = collectSourceSites(source, filesFor(source));
    if (res.error) diagnostics.push(`idiom "${idiom}" ${role}: ${res.error}`);
    for (const s of res.sites) {
      const list = into.get(s.token) ?? [];
      list.push({ idiom, file: s.file, line: s.line });
      into.set(s.token, list);
    }
  };

  for (const idiom of idioms) {
    harvest(idiom.name, 'declared', idiom.declared, declared);
    harvest(idiom.name, 'provided', idiom.provided, provided);
    harvest(idiom.name, 'consumed', idiom.consumed, consumed);
  }

  const tokenSet = new Set<string>([...declared.keys(), ...provided.keys(), ...consumed.keys()]);
  const tokens: IRegistrationNode[] = [...tokenSet].sort().map((token) => ({
    token,
    declared: sortSites(declared.get(token) ?? []),
    provided: sortSites(provided.get(token) ?? []),
    consumed: sortSites(consumed.get(token) ?? []),
  }));

  return {
    schema: REGISTRATION_GRAPH_SCHEMA,
    idioms: idioms.map((i) => i.name),
    tokens,
    diagnostics,
  };
}

/**
 * A cheap content-signature of the exact files {@link buildRegistrationGraph}
 * would read for these idioms: the sorted `relpath:mtimeMs:size` of every matched
 * file, hashed. Because it reflects the graph's ACTUAL data source (a live tree
 * walk) rather than the unrelated code-graph index, it is the correct key for any
 * persisted registration-graph cache — a source edit shifts the signature even
 * when no reindex has run, so a stale wiring verdict is impossible. Walk-and-stat
 * only (no file reads), so it stays far cheaper than a full build. Never throws.
 */
export function registrationGraphSignature(
  projectRoot: string,
  idioms: readonly IRegistrationIdiom[],
  options: IBuildRegistrationGraphOptions = {},
): string {
  const files = walkMatching(
    projectRoot,
    registrationGlobs(idioms),
    new Set(options.excludeDirs ?? []),
  ).sort();
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const st = statSync(nodePath.join(projectRoot, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Unreadable / racing delete — omit; a real content change still shifts
      // the hash via the surviving entries (and via this file's disappearance).
    }
  }
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** A token's full registration chain, with role presence flags. */
export interface IRegistrationChain extends IRegistrationNode {
  readonly isDeclared: boolean;
  readonly isProvided: boolean;
  readonly isConsumed: boolean;
}

/**
 * `wiring chain <token>` — the declared → provided → consumed hops of one token
 * with file:line at each, or `undefined` if the token is unknown to the graph.
 */
export function registrationChain(
  graph: IRegistrationGraph,
  token: string,
): IRegistrationChain | undefined {
  const node = graph.tokens.find((t) => t.token === token);
  if (!node) return undefined;
  return {
    ...node,
    isDeclared: node.declared.length > 0,
    isProvided: node.provided.length > 0,
    isConsumed: node.consumed.length > 0,
  };
}

/** A token declared or injected but never provided — silently absent at runtime. */
export interface IUnprovidedToken {
  readonly token: string;
  readonly declared: readonly IRegistrationSite[];
  readonly consumed: readonly IRegistrationSite[];
}

/**
 * `wiring unprovided` — tokens that are DECLARED or CONSUMED but have ZERO
 * provided sites. This is the silent-at-runtime class: typecheck/AOT-green, but
 * the provider is never registered (or the injected token has no provider
 * anywhere), so it resolves to undefined at runtime. The thing imports can't see.
 */
export function registrationUnprovided(graph: IRegistrationGraph): readonly IUnprovidedToken[] {
  return graph.tokens
    .filter((t) => t.provided.length === 0 && (t.declared.length > 0 || t.consumed.length > 0))
    .map((t) => ({ token: t.token, declared: t.declared, consumed: t.consumed }));
}

/** A token provided/registered that nothing consumes — a dead registration. */
export interface IOrphanRegistration {
  readonly token: string;
  readonly provided: readonly IRegistrationSite[];
}

/**
 * `wiring orphans` — tokens that ARE provided/registered but have ZERO consumed
 * sites: a provider/registration nothing injects (a build-clean no-op, or a
 * sign the consumer was renamed/removed).
 */
export function registrationOrphans(graph: IRegistrationGraph): readonly IOrphanRegistration[] {
  return graph.tokens
    .filter((t) => t.provided.length > 0 && t.consumed.length === 0)
    .map((t) => ({ token: t.token, provided: t.provided }));
}
