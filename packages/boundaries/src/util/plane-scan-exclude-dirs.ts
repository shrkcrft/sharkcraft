import * as nodePath from 'node:path';

/**
 * THE scan scope of every data-defined plane walk: the project-relative
 * directories the walk prunes. Today that is the SharkCraft asset/config dir,
 * when it sits inside the project. Its `.ts` files hold the rule definitions
 * themselves, so a rule would otherwise match (and self-report) its own
 * definition.
 *
 * Every verb and every aggregate that walks a plane reads it here: `policy-lint`,
 * `check wiring`, `wiring explain | unprovided | orphans`, `registry …`,
 * `baseline`, `generated`, `docs references`, `gates check | coverage | try`,
 * `quality`, `finish`, `shrk gate` and MCP. Before round 11 each derived it
 * inline, and several did not derive it at all. So `check wiring` and `gates
 * check` (or `policy-lint` and `shrk gate`) walked different trees for the SAME
 * rule, and one read 1 where the other read 0 ✓.
 */
export function planeScanExcludeDirs(projectRoot: string, sharkcraftDir: string | null | undefined): string[] {
  if (!sharkcraftDir) return [];
  const rel = nodePath.relative(projectRoot, sharkcraftDir).split(nodePath.sep).join('/');
  return rel && !rel.startsWith('..') ? [rel] : [];
}
