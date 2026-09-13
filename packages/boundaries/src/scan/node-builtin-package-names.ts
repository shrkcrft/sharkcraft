import { builtinModules } from 'node:module';

let cached: readonly string[] | undefined;

/**
 * Every module the running runtime ships built in, as an import specifier:
 * each bare name and its `node:` spelling (a name that already carries a
 * scheme — `node:test`, `bun:ffi` — as listed).
 *
 * THE list the boundary plane treats as always-known packages (round 13): the
 * orchestrator's known-package set (`collectKnownPackages`, which the dead-unit
 * judge reads) and the load-time marker refusal (`importPatternNeverJudgedDead`)
 * both read it, so the judge and the refusal can never disagree about whether a
 * builtin-named pattern could ever be judged dead.
 */
export function nodeBuiltinPackageNames(): readonly string[] {
  if (cached === undefined) {
    const out = new Set<string>();
    for (const m of builtinModules) {
      out.add(m);
      if (!m.includes(':')) out.add(`node:${m}`);
    }
    cached = [...out];
  }
  return cached;
}
