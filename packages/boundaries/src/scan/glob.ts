/**
 * Minimal glob matcher tuned for the patterns boundary rules use:
 *   - `**` matches any number of path segments (including zero)
 *   - `*`  matches any chars except `/`
 *   - `?`  matches a single char except `/`
 *   - everything else is literal
 *
 * Patterns are matched against the literal string (file path or import
 * specifier) — no I/O, no resolution. The function is pure and deterministic.
 */
export function globToRegex(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      // ** vs *
      const next = pattern[i + 1];
      if (next === '*') {
        // ** — zero or more segments
        // Also consume a trailing `/` so `a/** /b` matches `a/b`.
        const after = pattern[i + 2];
        if (after === '/') {
          r += '(?:.*/)?';
          i += 2;
        } else {
          r += '.*';
          i += 1;
        }
      } else {
        r += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      r += '[^/]';
      continue;
    }
    // Escape regex special chars.
    if ('.+^$|(){}[]\\'.includes(ch)) {
      r += '\\' + ch;
      continue;
    }
    r += ch;
  }
  return new RegExp('^' + r + '$');
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(value)) return true;
  }
  return false;
}
