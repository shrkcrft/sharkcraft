import * as nodePath from 'node:path';
import { boundaryFileLabel, classifyLocalBoundaryFiles } from './boundary-configuration-status.ts';
import type { IBoundaryRuleInvalidation } from './boundary-rule-invalidation.model.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * The files that DEFINE boundary rules (round 11, closing#d / 6.3) — one list,
 * so the changed-scope filter, finish and the imports gate agree on what a
 * "rule source" is:
 *
 *   - the sharkcraft config (it lists `boundaryFiles`);
 *   - every local `boundaryFiles` entry, resolved under the sharkcraft dir
 *     (listed, whether or not it exists — a deleted rule file is a rule edit);
 *   - every pack-contributed boundary file.
 *
 * Project-relative, `/`-separated, sorted.
 */
export function boundaryRuleSourceFiles(inspection: ISharkcraftInspection): string[] {
  const label = (abs: string): string => boundaryFileLabel(inspection.projectRoot, abs);
  const out = new Set<string>();
  if (inspection.configFile) out.add(label(inspection.configFile));
  if (inspection.sharkcraftDir) {
    for (const l of classifyLocalBoundaryFiles(inspection.sharkcraftDir, inspection.config?.boundaryFiles ?? []).listed) {
      out.add(label(l.abs));
    }
  }
  for (const pack of inspection.packs.validPacks) {
    for (const rel of pack.manifest?.contributions?.boundaryFiles ?? []) {
      out.add(label(nodePath.resolve(pack.packageRoot, rel)));
    }
  }
  for (const src of inspection.boundarySources.values()) {
    if (src.file) out.add(label(src.file));
  }
  return [...out].sort();
}

const TSCONFIG_FILES: ReadonlySet<string> = new Set(['tsconfig.json', 'tsconfig.base.json']);
const ROOT_MANIFEST_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

function normalizeChanged(f: string): string {
  return f.split(/[\\/]/).join('/').replace(/^\.\//, '');
}

/**
 * Which rules a changeset invalidated — see {@link IBoundaryRuleInvalidation}.
 *
 *   - a changed rule-source file escalates the rules it defines;
 *   - a changed sharkcraft config or root tsconfig (the alias map) escalates
 *     EVERY rule;
 *   - a changed root package.json / lockfile, or any file inside a pack's root,
 *     escalates the pack-contributed rules it could have changed.
 *
 * `ruleIds` narrows the rule set considered (default: the whole registry).
 */
export function resolveBoundaryRuleInvalidation(
  changedFiles: readonly string[],
  inspection: ISharkcraftInspection,
  ruleIds?: readonly string[],
): IBoundaryRuleInvalidation {
  const all = ruleIds ?? inspection.boundaryRegistry.list().map((r) => r.id);
  const label = (abs: string): string => boundaryFileLabel(inspection.projectRoot, abs);
  const changed = new Set(changedFiles.map(normalizeChanged));
  const escalated = new Set<string>();
  const reasons: IBoundaryRuleInvalidation['reasons'][number][] = [];
  const add = (file: string, kind: IBoundaryRuleInvalidation['reasons'][number]['kind'], ids: readonly string[]): void => {
    if (ids.length === 0) return;
    reasons.push({ file, kind, ruleIds: [...ids] });
    for (const id of ids) escalated.add(id);
  };

  const bySource = new Map<string, string[]>();
  for (const id of all) {
    const src = inspection.boundarySources.get(id);
    if (!src?.file) continue;
    const file = label(src.file);
    const list = bySource.get(file);
    if (list) list.push(id);
    else bySource.set(file, [id]);
  }
  for (const [file, ids] of bySource) if (changed.has(file)) add(file, 'rule-source', ids);

  if (inspection.configFile) {
    const cfg = label(inspection.configFile);
    if (changed.has(cfg)) add(cfg, 'config', all);
  }
  for (const f of changed) if (TSCONFIG_FILES.has(f)) add(f, 'tsconfig', all);

  const packRuleIds = all.filter((id) => inspection.boundarySources.get(id)?.type === 'pack');
  for (const f of changed) if (ROOT_MANIFEST_FILES.has(f)) add(f, 'manifest', packRuleIds);
  for (const pack of inspection.packs.validPacks) {
    const root = label(pack.packageRoot);
    if (nodePath.isAbsolute(root)) continue; // outside the project — never in a changeset
    const touched = [...changed].find((f) => f.startsWith(`${root}/`) && !bySource.has(f));
    if (!touched) continue;
    add(
      touched,
      'manifest',
      all.filter((id) => inspection.boundarySources.get(id)?.packageName === pack.packageName),
    );
  }
  return { escalatedRuleIds: all.filter((id) => escalated.has(id)), reasons };
}
