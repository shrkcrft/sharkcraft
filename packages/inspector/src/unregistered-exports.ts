/**
 * Entries exported by a GROUP module that the AGGREGATOR registering it never
 * registers — "added an entry to a group file, and it is silently invisible".
 *
 * A contribution file (the aggregator) imports named entries from group
 * modules and lists them in its default array. An entry added to a group and
 * not to that list compiles, ships, and is unknown to every lookup, with no
 * warning. This check diffs, one level deep and deterministically:
 *
 *   - aggregators = the contribution files the inspection's loaders actually
 *     imported cleanly (knowledge / rules / paths / templates — the kinds whose
 *     loader collects entry-shaped exports);
 *   - groups = each aggregator's RELATIVE imports (parsed by the one import
 *     parser, `parseImportStatements`) that resolve to a file under the same
 *     sharkcraft dir / pack root and are not themselves loaded;
 *   - an entry-shaped export of a group (the loader's OWN predicate:
 *     `isLikelyEntry` / `isTemplate`) whose id no registry holds is a finding.
 *
 * No directory globbing, and nothing is flagged for a file the aggregator
 * never references. `export * from './group'` registers the whole group
 * implicitly, so it yields zero findings by construction.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { safeImport } from '@shrkcrft/core';
import { parseImportStatements } from '@shrkcrft/boundaries';
import { isLikelyEntry } from '@shrkcrft/knowledge';
import { isTemplate } from '@shrkcrft/templates';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IUnregisteredExport {
  /** `knowledge` covers knowledge / rule / path entries; `template` covers templates. */
  readonly kind: 'knowledge' | 'template';
  /** Project-relative path of the aggregator (the loaded contribution file). */
  readonly aggregator: string;
  /** Project-relative path of the group module that exports the entry. */
  readonly group: string;
  readonly exportName: string;
  readonly id: string;
  /** 1-based line of the export in the group module (0 when not located). */
  readonly line: number;
  /** Owning pack when the aggregator is a pack contribution. */
  readonly packageName?: string;
  readonly message: string;
}

const PROBES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
const AGGREGATOR_KINDS = new Set(['knowledge', 'rules', 'paths', 'templates']);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = nodePath.resolve(nodePath.dirname(fromFile), specifier);
  const candidates = PROBES.map((ext) => base + ext);
  // TS ESM style: `./group.js` written for `./group.ts`.
  if (/\.m?js$/.test(specifier)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'));
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

function exportLine(content: string, name: string): number {
  const re =
    name === 'default'
      ? /^[ \t]*export[ \t]+default\b/m
      : new RegExp(`^[ \\t]*export[ \\t]+(?:const|let|var|function|class)[ \\t]+${name.replace(/[$]/g, '\\$')}\\b`, 'm');
  const m = re.exec(content);
  if (!m) return 0;
  return content.slice(0, m.index).split('\n').length;
}

/** Every unregistered entry export, sorted by group then line. */
export async function detectUnregisteredExports(
  inspection: ISharkcraftInspection,
): Promise<readonly IUnregisteredExport[]> {
  const out: IUnregisteredExport[] = [];
  const projectRoot = inspection.projectRoot;
  const rel = (abs: string): string => nodePath.relative(projectRoot, abs) || abs;
  const loaded = new Set((inspection.loaderDiagnostics ?? []).map((d) => nodePath.resolve(d.filePath)));
  const packRoots = new Map<string, string>();
  for (const p of inspection.packs.validPacks ?? []) packRoots.set(p.packageName, nodePath.resolve(p.packageRoot));
  // What the registries hold — the same sets `knowledge list` / `templates list` print.
  const registered = {
    knowledge: new Set(inspection.knowledgeEntries.map((e) => e.id)),
    template: new Set(inspection.templateRegistry.list().map((t) => t.id)),
  };
  const seen = new Set<string>();

  const aggregators = (inspection.loaderDiagnostics ?? []).filter(
    (d) => d.status === 'ok' && AGGREGATOR_KINDS.has(d.kind) && /\.(?:[cm]?[jt]s|tsx)$/.test(d.filePath),
  );
  for (const d of aggregators) {
    const aggregator = nodePath.resolve(d.filePath);
    const kind: 'knowledge' | 'template' = d.kind === 'templates' ? 'template' : 'knowledge';
    const root = d.packName ? packRoots.get(d.packName) : inspection.sharkcraftDir ? nodePath.resolve(inspection.sharkcraftDir) : undefined;
    if (!root || !existsSync(aggregator)) continue;
    let content: string;
    try {
      content = readFileSync(aggregator, 'utf8');
    } catch {
      continue;
    }
    for (const imp of parseImportStatements(content)) {
      if (imp.typeOnly || !imp.specifier.startsWith('.')) continue;
      const group = resolveRelativeImport(aggregator, imp.specifier);
      if (!group || !group.startsWith(root + nodePath.sep) || loaded.has(group)) continue;
      const imported = await safeImport(group);
      // A group that cannot be imported breaks its aggregator too — that is the
      // loader's failure to report, not an unregistered export.
      if (!imported.ok) continue;
      let groupContent = '';
      try {
        groupContent = readFileSync(group, 'utf8');
      } catch {
        /* line stays 0 */
      }
      const predicate = kind === 'template' ? isTemplate : isLikelyEntry;
      for (const exportName of Object.keys(imported.module)) {
        let value: unknown;
        try {
          value = (imported.module as Record<string, unknown>)[exportName];
        } catch {
          continue;
        }
        const items = predicate(value) ? [value] : Array.isArray(value) ? value.filter((v) => predicate(v)) : [];
        for (const item of items as readonly { id: string }[]) {
          if (registered[kind].has(item.id)) continue;
          const key = `${kind}\0${group}\0${exportName}\0${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const groupRel = rel(group);
          const aggregatorRel = rel(aggregator);
          out.push({
            kind,
            aggregator: aggregatorRel,
            group: groupRel,
            exportName,
            id: item.id,
            line: exportLine(groupContent, exportName),
            ...(d.packName ? { packageName: d.packName } : {}),
            message:
              `export '${exportName}' (id '${item.id}') in ${groupRel} is not registered by ${aggregatorRel} — ` +
              `add it to the aggregator's array, or re-export the group with \`export * from './${nodePath.basename(group)}'\``,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.line - b.line || a.id.localeCompare(b.id));
}
