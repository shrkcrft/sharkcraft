/**
 * `IContractFileRule` lets contracts express precise scope: glob,
 * path-prefix, exact, contains. The legacy `forbiddenFiles: string[]`
 * field is kept and treated as `kind: 'contains'` for back-compat.
 */

export enum ContractFileRuleKind {
  Glob = 'glob',
  PathPrefix = 'path-prefix',
  Exact = 'exact',
  Contains = 'contains',
}

export enum ContractFileRuleSeverity {
  Error = 'error',
  Warning = 'warning',
}

export interface IContractFileRule {
  pattern: string;
  kind: ContractFileRuleKind;
  reason?: string;
  severity?: ContractFileRuleSeverity;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$(){}|\\[\]]/g, '\\$&');
}

/**
 * Translate a deterministic POSIX-style glob to a regex anchored at both ends.
 * Case-sensitive by itself — `matchContractFileRule` lowercases its inputs for
 * the contract use-case, but security-sensitive callers (the delegate guardrail)
 * use this directly to keep file-path case significant.
 */
export function globToRegex(pattern: string): RegExp {
  const p = toPosix(pattern);
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      // `**` matches across path separators, `*` matches within a segment.
      if (p[i + 1] === '*') {
        // Optional trailing `/`: treat `**/` and `/**` and bare `**` uniformly.
        re += '.*';
        i += 2;
        if (p[i] === '/') i += 1; // consume one separator after `**`
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += escapeRegex(c);
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

/** Pure matcher — returns true when `file` is covered by `rule`. */
export function matchContractFileRule(rule: IContractFileRule, file: string): boolean {
  const f = toPosix(file).toLowerCase();
  const p = toPosix(rule.pattern).toLowerCase();
  switch (rule.kind) {
    case ContractFileRuleKind.Exact:
      return f === p;
    case ContractFileRuleKind.PathPrefix:
      return f === p || f.startsWith(p.endsWith('/') ? p : p + '/');
    case ContractFileRuleKind.Contains:
      return p.length > 0 && f.includes(p);
    case ContractFileRuleKind.Glob:
      return globToRegex(p).test(f);
  }
}

export interface IContractFileRuleMatch {
  file: string;
  rule: IContractFileRule;
}

/** Returns every (file, rule) pair where the rule covers the file. */
export function matchContractFileRules(
  rules: readonly IContractFileRule[],
  files: readonly string[],
): readonly IContractFileRuleMatch[] {
  const out: IContractFileRuleMatch[] = [];
  for (const file of files) {
    for (const rule of rules) {
      if (matchContractFileRule(rule, file)) out.push({ file, rule });
    }
  }
  return out;
}

/**
 * Compatibility helper: legacy `forbiddenFiles: string[]` is wrapped as
 * `kind: 'contains'` rules so the two pathways evaluate identically.
 */
export function rulesFromLegacyStrings(
  patterns: readonly string[],
): readonly IContractFileRule[] {
  return patterns.map((p) => ({ pattern: p, kind: ContractFileRuleKind.Contains }));
}

/** Detect intended `kind` for a free-text legacy pattern. */
export function inferContractFileRule(pattern: string): IContractFileRule {
  const p = toPosix(pattern);
  if (p.includes('*') || p.includes('?')) return { pattern: p, kind: ContractFileRuleKind.Glob };
  if (p.endsWith('/')) return { pattern: p, kind: ContractFileRuleKind.PathPrefix };
  if (/\.[a-z0-9]+$/i.test(p) && !p.includes('/')) {
    return { pattern: p, kind: ContractFileRuleKind.Contains };
  }
  return { pattern: p, kind: ContractFileRuleKind.Contains };
}
