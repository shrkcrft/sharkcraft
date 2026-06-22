import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { GraphQueryApi, GraphStore } from '@shrkcrft/graph';
import { flagBool, type ICommandHandler, type ParsedArgs, resolveCwd } from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

interface IImportRewrite {
  file: string;
  fromImport: string;
  toImport: string;
  reason: string;
}

interface IExportUpdate {
  file: string;
  action: 'edit' | 'review-manually';
  reason: string;
}

interface IStep {
  order: number;
  title: string;
  details: string;
}

interface IMoveReport {
  schema: 'sharkcraft.move-plan/v1';
  source: { path: string; package: string | null };
  target: { path: string; package: string | null };
  crossesPackages: boolean;
  movePlan: IStep[];
  importsToRewrite: IImportRewrite[];
  exportsToUpdate: IExportUpdate[];
  affectedPackages: string[];
  risks: string[];
  rollbackPlan: IStep[];
  validationCommands: string[];
  handoffForClaude: string;
}

/**
 * `shrk move-plan <source> <target>` — emit a structured plan for
 * moving a source file to a new location. Read-only: NEVER moves
 * anything itself, never rewrites imports. The agent (or a human)
 * uses the plan to do the actual work.
 *
 * Covers:
 *   - graph-traced importer rewrites (relative + package-name imports)
 *   - exports to revisit if the source was re-exported from an index
 *   - cross-package warnings (layer-order risks)
 *   - a rollback plan that's the literal reverse of the move
 *   - validation commands to run after applying
 *
 * Limitations:
 *   - single-file only. Directory moves can be approximated by
 *     listing the directory and running this command per file, or
 *     wait for a `--folder` follow-up.
 *   - `from '@shrkcrft/pkg/sub'` deep-import rewrites are best-effort;
 *     ambiguous cases get reported as `review-manually`.
 */
export const movePlanCommand: ICommandHandler = {
  name: 'move-plan',
  description:
    'Plan a file move: graph-traced importer rewrites, export touch-ups, cross-package warnings. Read-only.',
  usage: 'shrk move-plan <source-file> <target-file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sourceArg = args.positional[0]?.trim();
    const targetArg = args.positional[1]?.trim();
    if (!sourceArg || !targetArg) {
      process.stderr.write('Usage: shrk move-plan <source-file> <target-file> [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');

    const sourceRel = relativize(cwd, sourceArg);
    const targetRel = relativize(cwd, targetArg);

    if (!existsSync(nodePath.join(cwd, sourceRel))) {
      process.stderr.write(`Source file does not exist: ${sourceRel}\n`);
      return 1;
    }
    if (existsSync(nodePath.join(cwd, targetRel))) {
      process.stderr.write(`Target already exists (won't propose moving on top of it): ${targetRel}\n`);
      return 1;
    }

    const store = new GraphStore(cwd);
    if (!store.exists()) {
      process.stderr.write('No SharkCraft graph found. Run `shrk graph index` so move-plan can trace importers.\n');
      return 1;
    }
    const api = GraphQueryApi.fromStore(cwd);

    const sourcePackage = resolveOwningPackage(cwd, sourceRel);
    const targetPackage = resolveOwningPackage(cwd, targetRel);
    const crossesPackages = sourcePackage?.name !== targetPackage?.name;

    const importerNodes = (() => {
      const fileNode = api.findFile(sourceRel);
      if (!fileNode) return [];
      return api.importersOf(fileNode.id)
        .map((n) => n.path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
    })();

    const importsToRewrite: IImportRewrite[] = [];
    const exportsToUpdate: IExportUpdate[] = [];
    for (const importerPath of importerNodes) {
      const abs = nodePath.join(cwd, importerPath);
      if (!existsSync(abs)) continue;
      let body: string;
      try {
        body = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const rewrites = computeRewritesForFile({
        importerPath,
        importerBody: body,
        sourceRel,
        targetRel,
        sourcePackage,
        targetPackage,
      });
      importsToRewrite.push(...rewrites);
      // If the importer is `<pkg>/src/index.ts` and re-exports the source,
      // it likely needs to drop / move that export.
      if (/(^|\/)index\.[jt]sx?$/.test(importerPath) && body.includes(sourceBaseSpecifier(sourceRel))) {
        exportsToUpdate.push({
          file: importerPath,
          action: 'review-manually',
          reason: `index file re-exports something from "${sourceRel}"; relocate the re-export to point at "${targetRel}" or drop it.`,
        });
      }
    }

    // Also check if the source file itself is referenced from its own
    // package's index.ts.
    if (sourcePackage) {
      const sourceIndex = nodePath.join(cwd, sourcePackage.dir, 'src/index.ts');
      const sourceIndexRel = nodePath.relative(cwd, sourceIndex);
      const alreadyFlagged = exportsToUpdate.some((e) => e.file === sourceIndexRel);
      if (!alreadyFlagged && existsSync(sourceIndex)) {
        try {
          const body = readFileSync(sourceIndex, 'utf8');
          if (body.includes(sourceBaseSpecifier(sourceRel))) {
            exportsToUpdate.push({
              file: sourceIndexRel,
              action: 'edit',
              reason:
                crossesPackages
                  ? `index re-exports the moved file; drop the export (the file now lives in another package) or replace with a forwarding re-export.`
                  : `index re-exports the moved file; update the relative path to point at the new location.`,
            });
          }
        } catch {
          /* ignore */
        }
      }
    }

    const affectedPackages = unique(
      [
        ...importerNodes.map((p) => resolveOwningPackage(cwd, p)?.name ?? null),
        sourcePackage?.name ?? null,
        targetPackage?.name ?? null,
      ].filter((n): n is string => typeof n === 'string'),
    );

    const risks: string[] = [];
    if (crossesPackages) {
      risks.push(
        `Cross-package move: ${sourcePackage?.name ?? '(no package)'} → ${targetPackage?.name ?? '(no package)'}. Run \`shrk check boundaries\` after the move to confirm the new home is layered correctly.`,
      );
    }
    if (importerNodes.length > 30) {
      risks.push(
        `${importerNodes.length} importer(s) — large blast radius. Consider scripting the rewrites or moving in smaller chunks.`,
      );
    }
    if (exportsToUpdate.some((e) => e.action === 'review-manually')) {
      risks.push('Some index re-exports were flagged for manual review — automatic rewriting could lose intent.');
    }

    const movePlan: IStep[] = [
      {
        order: 1,
        title: 'Move the file',
        details: `git mv "${sourceRel}" "${targetRel}"  (then verify content unchanged)`,
      },
      ...importsToRewrite.map((rw, i) => ({
        order: 2 + i,
        title: `Rewrite import in ${rw.file}`,
        details: `Replace \`from '${rw.fromImport}'\` with \`from '${rw.toImport}'\`. Reason: ${rw.reason}`,
      })),
      ...(exportsToUpdate.length > 0
        ? [
            {
              order: 2 + importsToRewrite.length,
              title: 'Reconcile index re-exports',
              details: exportsToUpdate
                .map((e) => `${e.file} (${e.action}): ${e.reason}`)
                .join('  ||  '),
            },
          ]
        : []),
    ];

    const rollbackPlan: IStep[] = [
      { order: 1, title: 'Restore file', details: `git mv "${targetRel}" "${sourceRel}"` },
      {
        order: 2,
        title: 'Revert import rewrites',
        details:
          importsToRewrite.length === 0
            ? 'No importers to revert.'
            : `git restore ${unique(importsToRewrite.map((r) => r.file)).join(' ')}`,
      },
    ];

    const validationCommands = [
      'bun x tsc -p tsconfig.base.json --noEmit',
      'shrk check boundaries',
      'shrk check imports',
      'bun test',
    ];

    const status =
      importsToRewrite.length === 0 && exportsToUpdate.length === 0
        ? 'no-importers'
        : crossesPackages
          ? 'cross-package'
          : 'in-package';

    const handoff =
      status === 'no-importers'
        ? `Move is trivial — no importers reference "${sourceRel}". Just run the file move + validation.`
        : status === 'cross-package'
          ? `Move crosses packages. Apply each importsToRewrite[] edit, then revisit exportsToUpdate[], then run validationCommands. Re-run \`shrk check boundaries\` to confirm layering.`
          : `In-package move with ${importsToRewrite.length} importer rewrite(s). Safe but worth applying mechanically.`;

    const report: IMoveReport = {
      schema: 'sharkcraft.move-plan/v1',
      source: { path: sourceRel, package: sourcePackage?.name ?? null },
      target: { path: targetRel, package: targetPackage?.name ?? null },
      crossesPackages,
      movePlan,
      importsToRewrite,
      exportsToUpdate,
      affectedPackages,
      risks,
      rollbackPlan,
      validationCommands,
      handoffForClaude: handoff,
    };

    if (json) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    renderText(report);
    return 0;
  },
};

function relativize(cwd: string, raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (nodePath.isAbsolute(cleaned)) {
    return nodePath.relative(cwd, cleaned).replace(/\\/g, '/');
  }
  return cleaned;
}

interface IPackageInfo {
  name: string;
  dir: string;
}

const PACKAGE_CACHE = new Map<string, IPackageInfo[]>();

function listPackages(cwd: string): IPackageInfo[] {
  const cached = PACKAGE_CACHE.get(cwd);
  if (cached) return cached;
  const out: IPackageInfo[] = [];
  for (const root of ['packages', 'libs', 'apps']) {
    const rootAbs = nodePath.join(cwd, root);
    if (!existsSync(rootAbs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(rootAbs);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = nodePath.join(root, entry);
      const pkgJson = nodePath.join(cwd, dir, 'package.json');
      if (!existsSync(pkgJson)) continue;
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
        if (parsed.name) out.push({ name: parsed.name, dir });
      } catch {
        // skip
      }
    }
  }
  PACKAGE_CACHE.set(cwd, out);
  return out;
}

function resolveOwningPackage(cwd: string, fileRel: string): IPackageInfo | null {
  const packages = listPackages(cwd);
  let best: IPackageInfo | null = null;
  for (const p of packages) {
    const dirSlash = p.dir.replace(/\\/g, '/') + '/';
    if (fileRel.startsWith(dirSlash)) {
      if (!best || p.dir.length > best.dir.length) best = p;
    }
  }
  return best;
}

function sourceBaseSpecifier(sourceRel: string): string {
  // The plain basename without extension — usable as a fuzzy substring
  // match against `from '../foo'` re-exports.
  const ext = nodePath.extname(sourceRel);
  return nodePath.basename(sourceRel, ext);
}

function computeRewritesForFile(input: {
  importerPath: string;
  importerBody: string;
  sourceRel: string;
  targetRel: string;
  sourcePackage: IPackageInfo | null;
  targetPackage: IPackageInfo | null;
}): IImportRewrite[] {
  const out: IImportRewrite[] = [];
  const seen = new Set<string>();

  const importerDir = nodePath.dirname(input.importerPath);
  const expectedRelativeBefore = toRelativeSpecifier(importerDir, input.sourceRel);
  const expectedRelativeAfter = toRelativeSpecifier(importerDir, input.targetRel);

  // Pattern 1: relative imports that resolve to the source file.
  // Try both with-extension and without-extension forms.
  const candidates = [expectedRelativeBefore, stripJsTsExt(expectedRelativeBefore)];
  for (const cand of candidates) {
    if (cand.length === 0) continue;
    if (!input.importerBody.includes(`'${cand}'`) && !input.importerBody.includes(`"${cand}"`)) continue;
    const targetCand = stripJsTsExt(expectedRelativeAfter);
    const key = `rel:${cand}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file: input.importerPath,
      fromImport: cand,
      toImport: targetCand,
      reason: 'relative-path rewrite (importer-relative)',
    });
  }

  // Pattern 2: package-name imports `@shrkcrft/xxx` when the source is
  // inside that package and the target is in a different one.
  if (input.sourcePackage && input.targetPackage && input.sourcePackage.name !== input.targetPackage.name) {
    const fromSpec = input.sourcePackage.name;
    const toSpec = input.targetPackage.name;
    if (
      (input.importerBody.includes(`'${fromSpec}'`) || input.importerBody.includes(`"${fromSpec}"`)) &&
      // and the package-name import is actually exposing the moved symbol
      // (we can't know for sure without re-resolving — flag as review).
      input.importerPath !== fromIndexPath(input.sourcePackage)
    ) {
      const key = `pkg:${fromSpec}->${toSpec}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          file: input.importerPath,
          fromImport: fromSpec,
          toImport: toSpec,
          reason:
            'package-name import: importer likely consumes the symbol via the old package. Verify the target package re-exports the symbol from its public index before applying.',
        });
      }
    }
  }

  return out;
}

function fromIndexPath(pkg: IPackageInfo): string {
  return nodePath.join(pkg.dir, 'src/index.ts');
}

function toRelativeSpecifier(fromDir: string, toRel: string): string {
  const rel = nodePath.relative(fromDir, toRel).replace(/\\/g, '/');
  if (!rel.startsWith('.')) return `./${rel}`;
  return rel;
}

function stripJsTsExt(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function renderText(r: IMoveReport): void {
  process.stdout.write(
    header(
      `move-plan: ${r.source.path} → ${r.target.path}${r.crossesPackages ? ' (cross-package)' : ''}`,
    ),
  );
  process.stdout.write(`affected packages: ${r.affectedPackages.join(', ') || '(none)'}\n\n`);
  process.stdout.write(`move plan (${r.movePlan.length} step(s)):\n`);
  for (const s of r.movePlan) {
    process.stdout.write(`  ${s.order}. ${s.title} — ${s.details}\n`);
  }
  if (r.importsToRewrite.length > 0) {
    process.stdout.write(`\nimport rewrites (${r.importsToRewrite.length}):\n`);
    for (const rw of r.importsToRewrite) {
      process.stdout.write(`  ${rw.file}\n    from '${rw.fromImport}' → to '${rw.toImport}'\n    (${rw.reason})\n`);
    }
  }
  if (r.exportsToUpdate.length > 0) {
    process.stdout.write('\nexports to update:\n');
    for (const e of r.exportsToUpdate) {
      process.stdout.write(`  ${e.file} [${e.action}] — ${e.reason}\n`);
    }
  }
  if (r.risks.length > 0) {
    process.stdout.write('\nrisks:\n');
    for (const r2 of r.risks) process.stdout.write(`  - ${r2}\n`);
  }
  process.stdout.write('\nvalidation commands:\n');
  for (const c of r.validationCommands) process.stdout.write(`  $ ${c}\n`);
  process.stdout.write(`\nhandoff: ${r.handoffForClaude}\n`);
}
