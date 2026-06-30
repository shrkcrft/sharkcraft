import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { safeCompile, countCaptureGroups } from '../util/safe-regex.ts';

export const WIRING_SCHEMA = 'sharkcraft.wiring/v1' as const;

/** A file made available to the engine. */
export interface IWiringFileEntry {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A captured token + where it was captured. */
export interface IWiringTokenSite {
  readonly token: string;
  readonly file: string;
  readonly line: number;
}

export interface IWiringViolation {
  readonly ruleId: string;
  /** The token that is missing from the other side. */
  readonly token: string;
  /** Declaring (or registering) file (project-relative) + 1-based line. */
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  /**
   * Which side the token is missing from. `declared-missing` (the subset case):
   * declared but not registered. `registered-missing` (parity only): registered
   * but never declared.
   */
  readonly direction?: 'declared-missing' | 'registered-missing';
  readonly hint?: string;
}

export interface IWiringRuleResult {
  readonly ruleId: string;
  readonly description?: string;
  readonly severity: 'error' | 'warning';
  readonly declaredCount: number;
  readonly registeredCount: number;
  readonly violations: readonly IWiringViolation[];
  /** Set when the rule is misconfigured (bad regex / no capture group / bad source). */
  readonly error?: string;
}

export interface IWiringReport {
  readonly schema: typeof WIRING_SCHEMA;
  readonly rules: readonly IWiringRuleResult[];
  readonly violations: readonly IWiringViolation[];
  /** Rule-level misconfiguration messages (never throws — degrades gracefully). */
  readonly diagnostics: readonly string[];
  /**
   * Count of rules that actually ran a comparison. A rule whose declared+
   * registered globs matched 0 files is NOT evaluated (a silent no-op the gate
   * surfaces as `skipped`). Misconfigured rules count as evaluated so their
   * error is not swallowed.
   */
  readonly evaluated: number;
  readonly verdict: 'pass' | 'errors' | 'warnings';
}

/** Resolves a rule-side's globs to the concrete files (path + content) to scan. */
export type WiringFileResolver = (source: IWiringSource) => readonly IWiringFileEntry[];

/** Normalize the `registered` field (single source or union array) to an array. */
function registeredSources(reg: IWiringRule['registered']): readonly IWiringSource[] {
  return Array.isArray(reg) ? (reg as readonly IWiringSource[]) : [reg as IWiringSource];
}

interface IPreparedSource {
  readonly re?: RegExp;
  readonly arrayProperty?: string;
  readonly error?: string;
}

/**
 * Validate + (for pattern sources) compile one side. Exactly one of
 * `pattern` / `arrayProperty` must be set; `compileSafe` only applies to the
 * pattern side. Never throws — a misconfigured source degrades to an error.
 */
function prepareSource(source: IWiringSource): IPreparedSource {
  const hasPattern = typeof source.pattern === 'string' && source.pattern.length > 0;
  const hasArray = typeof source.arrayProperty === 'string' && source.arrayProperty.length > 0;
  if (hasPattern && hasArray) {
    return { error: 'sets both pattern and arrayProperty — exactly one is allowed' };
  }
  if (!hasPattern && !hasArray) {
    return { error: 'sets neither pattern nor arrayProperty — exactly one is required' };
  }
  if (hasArray) return { arrayProperty: source.arrayProperty };
  const { re, error } = safeCompile(source.pattern!, source.flags);
  if (error) return { error };
  if (countCaptureGroups(re!) < 1) {
    return {
      error: `pattern /${source.pattern}/ has no capture group — group 1 must capture the token`,
    };
  }
  return { re };
}

/**
 * Public: extract every token site from ONE wiring source (regex capture group
 * 1 or `arrayProperty` elements) over the given files. Shared by the wiring
 * evaluator and the registry-inventory engine so both honour the exact same
 * extraction semantics. A misconfigured source returns an `error` and no sites
 * (never throws).
 */
export function collectSourceSites(
  source: IWiringSource,
  files: readonly IWiringFileEntry[],
): { sites: readonly IWiringTokenSite[]; error?: string } {
  const prepared = prepareSource(source);
  if (prepared.error) return { sites: [], error: prepared.error };
  const sites = prepared.re
    ? collectByRegex(prepared.re, files)
    : collectByArrayProperty(prepared.arrayProperty!, files);
  return { sites };
}

/** Collect every capture-group-1 token from a precompiled pattern, with sites. */
function collectByRegex(re: RegExp, files: readonly IWiringFileEntry[]): IWiringTokenSite[] {
  const sites: IWiringTokenSite[] = [];
  for (const f of files) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      // Guard against a zero-width match looping forever.
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const token = m[1];
      if (token === undefined || token === '') continue;
      sites.push({ token, file: f.path, line: lineOf(f.content, m.index) });
    }
  }
  return sites;
}

/**
 * Collect element tokens from every `<name> = [ … ]` or `<name>: [ … ]` array
 * literal in each file. Element tokens are identifiers (leading identifier of
 * the element) or quoted-string contents. Bracket-depth aware and string-aware,
 * so commas/brackets inside nested literals or strings don't mis-split.
 */
function collectByArrayProperty(name: string, files: readonly IWiringFileEntry[]): IWiringTokenSite[] {
  const sites: IWiringTokenSite[] = [];
  const head = new RegExp(`(?<![\\w$])${escapeRegex(name)}\\s*[:=]\\s*\\[`, 'g');
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const open = m.index + m[0].length - 1; // index of the `[`
      const { elements, end } = scanArray(f.content, open);
      for (const el of elements) {
        const token = elementToken(el.text);
        if (token === undefined || token === '') continue;
        sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** Scan a `[ … ]` block from its opening bracket, splitting top-level elements. */
function scanArray(
  content: string,
  openIndex: number,
): { elements: { text: string; index: number }[]; end: number } {
  const elements: { text: string; index: number }[] = [];
  let depth = 0;
  let elemStart = openIndex + 1;
  for (let i = openIndex; i < content.length; i += 1) {
    const c = content[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(content, i);
      continue;
    }
    if (c === '[' || c === '(' || c === '{') {
      depth += 1;
    } else if (c === ']' || c === ')' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        pushElement(elements, content, elemStart, i);
        return { elements, end: i };
      }
    } else if (c === ',' && depth === 1) {
      pushElement(elements, content, elemStart, i);
      elemStart = i + 1;
    }
  }
  pushElement(elements, content, elemStart, content.length);
  return { elements, end: content.length - 1 };
}

/** Index of the closing quote (handles escapes); end-of-content if unterminated. */
function skipString(content: string, start: number): number {
  const quote = content[start];
  for (let i = start + 1; i < content.length; i += 1) {
    if (content[i] === '\\') {
      i += 1;
      continue;
    }
    if (content[i] === quote) return i;
  }
  return content.length - 1;
}

function pushElement(
  elements: { text: string; index: number }[],
  content: string,
  start: number,
  end: number,
): void {
  const raw = content.slice(start, end);
  const text = raw.trim();
  if (text === '') return;
  elements.push({ text, index: start + (raw.length - raw.trimStart().length) });
}

/** Leading identifier or quoted-string contents of one array element. */
function elementToken(text: string): string | undefined {
  const first = text[0];
  if (first === '"' || first === "'" || first === '`') {
    const close = text.indexOf(first, 1);
    return close > 0 ? text.slice(1, close) : undefined;
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(text);
  return m ? m[0] : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** Group key for a token site under `groupBy` (dir = dirname; package = first two segments). */
function groupKeyOf(path: string, groupBy: 'dir' | 'package'): string {
  if (groupBy === 'package') return path.split('/').slice(0, 2).join('/');
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '.';
}

/** Membership key combining the group (empty = global) and the token. */
function keyOf(site: IWiringTokenSite, groupBy?: 'dir' | 'package'): string {
  const g = groupBy ? groupKeyOf(site.file, groupBy) : '';
  return `${g} ${site.token}`;
}

/** First site per membership key, in stable (file, line) order. */
function firstSites(
  sites: readonly IWiringTokenSite[],
  groupBy?: 'dir' | 'package',
): Map<string, IWiringTokenSite> {
  const map = new Map<string, IWiringTokenSite>();
  for (const s of [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const k = keyOf(s, groupBy);
    if (!map.has(k)) map.set(k, s);
  }
  return map;
}

/**
 * Pure wiring evaluation. For each rule: the DECLARED token set is checked
 * against the UNION of the REGISTERED sources. Every declared token absent from
 * the registered set is a `declared-missing` violation; in `parity` mode every
 * registered token absent from the declared set is also a `registered-missing`
 * violation. With `groupBy`, membership is checked within the same dir/package.
 * The `resolve` callback supplies the files for a given rule-side (injected so
 * the engine stays pure / testable — see `runWiring` for the fs-backed wiring).
 */
export function evaluateWiring(
  rules: readonly IWiringRule[],
  resolve: WiringFileResolver,
): IWiringReport {
  const ruleResults: IWiringRuleResult[] = [];
  const all: IWiringViolation[] = [];
  const diagnostics: string[] = [];
  let evaluated = 0;
  let misconfigError = false;
  let misconfigWarn = false;

  for (const rule of rules) {
    const severity: 'error' | 'warning' = rule.severity ?? 'error';
    const groupBy = rule.groupBy;
    const regSources = registeredSources(rule.registered);

    // Validate + compile defensively — a misconfigured rule becomes a
    // diagnostic, never a thrown exception that would crash the gate.
    const declaredP = prepareSource(rule.declared);
    const registeredP = regSources.map(prepareSource);
    const regErr = registeredP.find((p) => p.error)?.error;
    if (declaredP.error || regErr) {
      const parts = [
        declaredP.error ? `declared ${declaredP.error}` : '',
        regErr ? `registered ${regErr}` : '',
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
      // A misconfigured rule attempted to run — count it so its error isn't
      // swallowed by the gate's `evaluated === 0` skip path.
      evaluated += 1;
      continue;
    }

    const declaredFiles = resolve(rule.declared);
    const declaredSites = declaredP.re
      ? collectByRegex(declaredP.re, declaredFiles)
      : collectByArrayProperty(declaredP.arrayProperty!, declaredFiles);

    const registeredSites: IWiringTokenSite[] = [];
    let registeredFileCount = 0;
    for (let i = 0; i < regSources.length; i += 1) {
      const files = resolve(regSources[i]!);
      registeredFileCount += files.length;
      const prep = registeredP[i]!;
      const sites = prep.re
        ? collectByRegex(prep.re, files)
        : collectByArrayProperty(prep.arrayProperty!, files);
      registeredSites.push(...sites);
    }

    const declaredKeys = firstSites(declaredSites, groupBy);
    const registeredKeys = firstSites(registeredSites, groupBy);

    const declaredHint = rule.hintDeclaredMissing ?? rule.hint;
    const violations: IWiringViolation[] = [];
    for (const k of [...declaredKeys.keys()].sort()) {
      if (registeredKeys.has(k)) continue;
      const site = declaredKeys.get(k)!;
      violations.push({
        ruleId: rule.id,
        token: site.token,
        file: site.file,
        line: site.line,
        severity,
        direction: 'declared-missing',
        ...(declaredHint ? { hint: declaredHint } : {}),
      });
    }
    if (rule.mode === 'parity') {
      const registeredHint = rule.hintRegisteredMissing ?? rule.hint;
      for (const k of [...registeredKeys.keys()].sort()) {
        if (declaredKeys.has(k)) continue;
        const site = registeredKeys.get(k)!;
        violations.push({
          ruleId: rule.id,
          token: site.token,
          file: site.file,
          line: site.line,
          severity,
          direction: 'registered-missing',
          ...(registeredHint ? { hint: registeredHint } : {}),
        });
      }
    }

    ruleResults.push({
      ruleId: rule.id,
      ...(rule.description ? { description: rule.description } : {}),
      severity,
      declaredCount: declaredKeys.size,
      registeredCount: registeredKeys.size,
      violations,
    });
    all.push(...violations);
    if (declaredFiles.length + registeredFileCount > 0) evaluated += 1;
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
    evaluated,
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
