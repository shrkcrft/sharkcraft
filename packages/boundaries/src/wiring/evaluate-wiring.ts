import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { safeCompile, countCaptureGroups } from '../util/safe-regex.ts';

export const WIRING_SCHEMA = 'sharkcraft.wiring/v1' as const;

/** A file made available to the engine. */
export interface IWiringFileEntry {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A captured token + where it was captured (for declared tokens). */
export interface IWiringTokenSite {
  readonly token: string;
  readonly file: string;
  readonly line: number;
}

export interface IWiringViolation {
  readonly ruleId: string;
  /** The declared token that is not present in the registered set. */
  readonly token: string;
  /** Declaring file (project-relative) + 1-based line. */
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly hint?: string;
}

export interface IWiringRuleResult {
  readonly ruleId: string;
  readonly description?: string;
  readonly severity: 'error' | 'warning';
  readonly declaredCount: number;
  readonly registeredCount: number;
  readonly violations: readonly IWiringViolation[];
  /** Set when the rule is misconfigured (bad regex / no capture group). */
  readonly error?: string;
}

export interface IWiringReport {
  readonly schema: typeof WIRING_SCHEMA;
  readonly rules: readonly IWiringRuleResult[];
  readonly violations: readonly IWiringViolation[];
  /** Rule-level misconfiguration messages (never throws — degrades gracefully). */
  readonly diagnostics: readonly string[];
  readonly verdict: 'pass' | 'errors' | 'warnings';
}

/** Resolves a rule-side's globs to the concrete files (path + content) to scan. */
export type WiringFileResolver = (source: IWiringSource) => readonly IWiringFileEntry[];

/**
 * Compile a rule-side's pattern, never throwing. Returns the regex or a clear
 * error string for an uncompilable pattern / bad flags / missing capture group
 * (group 1 is the token contract). A misconfigured rule must degrade to a
 * diagnostic, not crash the check or the whole gate aggregator.
 */
function compileSafe(source: IWiringSource): { re?: RegExp; error?: string } {
  const { re, error } = safeCompile(source.pattern, source.flags);
  if (error) return { error };
  if (countCaptureGroups(re!) < 1) {
    return {
      error: `pattern /${source.pattern}/ has no capture group — group 1 must capture the token`,
    };
  }
  return { re };
}

/** Collect every capture-group-1 token from a precompiled side, with declaring sites. */
function collectTokens(
  re: RegExp,
  files: readonly IWiringFileEntry[],
): { tokens: Set<string>; sites: IWiringTokenSite[] } {
  const tokens = new Set<string>();
  const sites: IWiringTokenSite[] = [];
  for (const f of files) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      // Guard against a zero-width match looping forever.
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const token = m[1];
      if (token === undefined || token === '') continue;
      tokens.add(token);
      sites.push({ token, file: f.path, line: lineOf(f.content, m.index) });
    }
  }
  return { tokens, sites };
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Pure wiring evaluation. For each rule: every DECLARED token that is not in the
 * REGISTERED set is a violation, reported at its first declaring site. The
 * `resolve` callback supplies the files for a given rule-side (injected so the
 * engine stays pure / testable — see `runWiring` for the fs-backed wiring).
 */
export function evaluateWiring(
  rules: readonly IWiringRule[],
  resolve: WiringFileResolver,
): IWiringReport {
  const ruleResults: IWiringRuleResult[] = [];
  const all: IWiringViolation[] = [];
  const diagnostics: string[] = [];
  let misconfigError = false;
  let misconfigWarn = false;

  for (const rule of rules) {
    const severity: 'error' | 'warning' = rule.severity ?? 'error';

    // Compile both sides defensively — a misconfigured rule becomes a
    // diagnostic, never a thrown exception that would crash the gate.
    const declaredRe = compileSafe(rule.declared);
    const registeredRe = compileSafe(rule.registered);
    if (declaredRe.error || registeredRe.error) {
      const parts = [
        declaredRe.error ? `declared ${declaredRe.error}` : '',
        registeredRe.error ? `registered ${registeredRe.error}` : '',
      ].filter(Boolean);
      const msg = `rule "${rule.id}": ${parts.join('; ')}`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        severity,
        declaredCount: 0,
        registeredCount: 0,
        violations: [],
        error: msg,
      });
      continue;
    }

    const declared = collectTokens(declaredRe.re!, resolve(rule.declared));
    const registered = collectTokens(registeredRe.re!, resolve(rule.registered));

    // First declaring site per token, in stable (file, line) order.
    const firstSite = new Map<string, IWiringTokenSite>();
    for (const s of [...declared.sites].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    )) {
      if (!firstSite.has(s.token)) firstSite.set(s.token, s);
    }

    const violations: IWiringViolation[] = [];
    for (const token of [...declared.tokens].sort()) {
      if (registered.tokens.has(token)) continue;
      const site = firstSite.get(token);
      violations.push({
        ruleId: rule.id,
        token,
        file: site?.file ?? '',
        line: site?.line ?? 0,
        severity,
        ...(rule.hint ? { hint: rule.hint } : {}),
      });
    }

    ruleResults.push({
      ruleId: rule.id,
      ...(rule.description ? { description: rule.description } : {}),
      severity,
      declaredCount: declared.tokens.size,
      registeredCount: registered.tokens.size,
      violations,
    });
    all.push(...violations);
  }

  // A misconfigured rule must not pass as a silent green — it counts toward the
  // verdict at its own severity (default error).
  const hasError = misconfigError || all.some((v) => v.severity === 'error');
  const hasWarn = misconfigWarn || all.some((v) => v.severity === 'warning');
  return {
    schema: WIRING_SCHEMA,
    rules: ruleResults,
    violations: all,
    diagnostics,
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
