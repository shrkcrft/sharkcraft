import * as nodePath from 'node:path';
import type { IReferencePackOrigin } from './i-reference-pack-origin.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

function origin(inspection: ISharkcraftInspection, packageName: string, packageRoot: string): IReferencePackOrigin {
  const rel = nodePath.relative(inspection.projectRoot, packageRoot).split(nodePath.sep).join('/');
  return { packageName, packageRoot, displayRoot: rel === '' ? '.' : rel };
}

/**
 * The contributing pack of an asset whose provenance names it (`entrySources`
 * / `boundarySources` → `{ type: 'pack', packageName }`), with its package
 * directory from THE discovered pack list (`inspection.packs.validPacks`) —
 * the directory the loaders read the pack's contribution files from. A name
 * no valid pack carries has no directory: `undefined`.
 */
export function packOriginByName(
  inspection: ISharkcraftInspection,
  packageName: string | undefined,
): IReferencePackOrigin | undefined {
  if (!packageName) return undefined;
  const pack = (inspection.packs?.validPacks ?? []).find((p) => p.packageName === packageName);
  return pack ? origin(inspection, pack.packageName, pack.packageRoot) : undefined;
}

/**
 * The contributing pack of an asset known only by its declaring FILE (a
 * pack's policy check): the valid pack whose package directory contains it —
 * the innermost one, so a pack nested in another pack's `node_modules`
 * resolves to itself.
 */
export function packOriginOfFile(
  inspection: ISharkcraftInspection,
  absFile: string | undefined,
): IReferencePackOrigin | undefined {
  if (!absFile) return undefined;
  const file = nodePath.resolve(absFile);
  let best: { packageName: string; packageRoot: string } | undefined;
  for (const p of inspection.packs?.validPacks ?? []) {
    const root = nodePath.resolve(p.packageRoot);
    if (!file.startsWith(root + nodePath.sep)) continue;
    if (!best || root.length > nodePath.resolve(best.packageRoot).length) best = p;
  }
  return best ? origin(inspection, best.packageName, best.packageRoot) : undefined;
}
