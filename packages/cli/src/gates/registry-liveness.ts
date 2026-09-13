import type { IRegistryDeclaration, ISettledUnitLiveness } from '@shrkcrft/core';
import { settleGlobLists, sourceLivenessRequest } from '@shrkcrft/boundaries';
import { registryLabeledSources } from './gate-rule-globs.ts';

/**
 * A registry's `source` / `consumer` glob units settled with their
 * `expectEmpty` markers (round 13) — THE per-source request `gates coverage`
 * builds too (`sourceLivenessRequest` over `registryLabeledSources`). The
 * registry verbs (`registry <name> list|exists|where|duplicates`) and `gates
 * check` both decide an empty inventory from it, so they cannot disagree about
 * a registry over a planned directory.
 */
export function registryLiveness(
  cwd: string,
  decl: IRegistryDeclaration,
  excludeDirs: readonly string[],
): ISettledUnitLiveness {
  return settleGlobLists(sourceLivenessRequest(cwd, registryLabeledSources(decl), excludeDirs, decl.name));
}
