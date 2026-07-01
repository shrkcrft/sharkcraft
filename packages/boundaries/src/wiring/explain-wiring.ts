import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import {
  collectSourceSites,
  evaluateWiring,
  type IWiringFileEntry,
  type IWiringTokenSite,
} from './evaluate-wiring.ts';

export const WIRING_EXPLAIN_SCHEMA = 'sharkcraft.wiring-explain/v1' as const;

/** One side (declared or registered) of a wiring rule, as extracted from the tree. */
export interface IWiringSideExplain {
  /** Every capture site (token + file:line), stable-sorted by (file, line). */
  readonly sites: readonly IWiringTokenSite[];
  /** Distinct membership-key count (mirrors the gate's `declared/registered N`). */
  readonly distinctCount: number;
  /** Files scanned for this side (after glob resolution). */
  readonly filesScanned: number;
  /** Misconfiguration (bad regex / no capture group / bad source), if any. */
  readonly error?: string;
}

/**
 * The full intermediate output of evaluating ONE wiring rule against the live
 * tree: the declared set and the registered set each source extracted (with
 * file:line), plus the set-difference and verdict — the thing {@link
 * evaluateWiring} computes internally but only emits as counts + violations.
 */
export interface IWiringExplain {
  readonly schema: typeof WIRING_EXPLAIN_SCHEMA;
  readonly ruleId: string;
  readonly description?: string;
  readonly mode: 'subset' | 'parity';
  readonly groupBy?: 'dir' | 'package';
  readonly severity: 'error' | 'warning';
  readonly declared: IWiringSideExplain;
  readonly registered: IWiringSideExplain;
  /** Declared tokens absent from the registered set (the `declared-missing` diff). */
  readonly declaredNotRegistered: readonly IWiringTokenSite[];
  /** Registered tokens absent from the declared set (parity-only `registered-missing`). */
  readonly registeredNotDeclared: readonly IWiringTokenSite[];
  readonly verdict: 'pass' | 'errors' | 'warnings';
  /** Rule-level misconfiguration messages (engine degrades gracefully). */
  readonly diagnostics: readonly string[];
}

export interface IExplainWiringOptions {
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
}

function registeredSources(reg: IWiringRule['registered']): readonly IWiringSource[] {
  return Array.isArray(reg) ? (reg as readonly IWiringSource[]) : [reg as IWiringSource];
}

function sortSites(sites: readonly IWiringTokenSite[]): IWiringTokenSite[] {
  return [...sites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.token.localeCompare(b.token),
  );
}

/**
 * Dry-run a single wiring rule against the live tree and return what each side
 * extracted (declared set, registered set, the set-difference, the verdict) —
 * WITHOUT writing config. Powers `wiring explain <ruleId>`, `wiring test
 * <candidate>`, and `check wiring --explain <ruleId>`: the author can SEE the
 * alias-resolved cross-file set-difference the gate computes before committing
 * a rule. The diff/verdict reuse {@link evaluateWiring} so they match the gate
 * exactly (incl. `groupBy` membership); the full per-site lists are extracted
 * with the shared {@link collectSourceSites}. Never throws.
 */
export function explainWiring(
  projectRoot: string,
  rule: IWiringRule,
  options: IExplainWiringOptions = {},
): IWiringExplain {
  const regSources = registeredSources(rule.registered);
  const allGlobs = [
    ...new Set([...rule.declared.files, ...regSources.flatMap((s) => [...s.files])]),
  ];
  const cache = readMatchingFiles(projectRoot, allGlobs, new Set(options.excludeDirs ?? []));
  const entries: IWiringFileEntry[] = [...cache.entries()].map(([path, content]) => ({
    path,
    content,
  }));
  const filesFor = (source: IWiringSource): IWiringFileEntry[] =>
    entries.filter((f) => matchesAny(f.path, source.files));

  // Declared side — full sites.
  const declaredFiles = filesFor(rule.declared);
  const declaredRes = collectSourceSites(rule.declared, declaredFiles);

  // Registered side — union of every source, full sites.
  const registeredFiles = new Set<string>();
  const registeredSites: IWiringTokenSite[] = [];
  let registeredError: string | undefined;
  for (const source of regSources) {
    const files = filesFor(source);
    for (const f of files) registeredFiles.add(f.path);
    const res = collectSourceSites(source, files);
    if (res.error && !registeredError) registeredError = res.error;
    registeredSites.push(...res.sites);
  }

  // Canonical diff + counts + verdict from the gate engine (same groupBy logic).
  const report = evaluateWiring([rule], filesFor);
  const ruleResult = report.rules[0];
  const declaredNotRegistered = sortSites(
    (ruleResult?.violations ?? [])
      .filter((v) => v.direction === 'declared-missing')
      .map((v) => ({ token: v.token, file: v.file, line: v.line })),
  );
  const registeredNotDeclared = sortSites(
    (ruleResult?.violations ?? [])
      .filter((v) => v.direction === 'registered-missing')
      .map((v) => ({ token: v.token, file: v.file, line: v.line })),
  );

  return {
    schema: WIRING_EXPLAIN_SCHEMA,
    ruleId: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    mode: rule.mode === 'parity' ? 'parity' : 'subset',
    ...(rule.groupBy ? { groupBy: rule.groupBy } : {}),
    severity: rule.severity ?? 'error',
    declared: {
      sites: sortSites(declaredRes.sites),
      distinctCount: ruleResult?.declaredCount ?? 0,
      filesScanned: declaredFiles.length,
      ...(declaredRes.error ? { error: declaredRes.error } : {}),
    },
    registered: {
      sites: sortSites(registeredSites),
      distinctCount: ruleResult?.registeredCount ?? 0,
      filesScanned: registeredFiles.size,
      ...(registeredError ? { error: registeredError } : {}),
    },
    declaredNotRegistered,
    registeredNotDeclared,
    verdict: report.verdict,
    diagnostics: report.diagnostics,
  };
}
