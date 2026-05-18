import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

/**
 * Biome bridge. Biome's rule grammar is narrower than ESLint's, so this
 * adapter is intentionally smaller: scaffold a `biome.sharkcraft.json` that
 * ignores any generated paths SharkCraft tracks, and documents which
 * SharkCraft rules Biome cannot express (so the user knows to keep
 * `shrk check boundaries` in CI for those).
 */

const SCAFFOLD_DEFAULT_RELPATH = 'biome.sharkcraft.json';

function renderBiomeSnippet(generatedGlobs: readonly string[]): string {
  const ignored = generatedGlobs.length > 0 ? generatedGlobs : ['**/dist/**', '**/build/**'];
  const config = {
    $schema: 'https://biomejs.dev/schemas/1.9.0/schema.json',
    organizeImports: { enabled: true },
    formatter: { enabled: true },
    linter: {
      enabled: true,
      rules: { recommended: true },
    },
    // Generated paths SharkCraft tracks — Biome should skip them.
    files: { ignore: ignored },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

const BIOME_NOTES = `\
# Biome bridge — limitations

Biome cannot express SharkCraft's cross-layer / cross-package boundary
rules. Keep \`shrk check boundaries\` in CI for those.

Run on every PR:
  $ shrk check boundaries --changed-only --json > boundaries.json
  $ shrk ci scaffold github-actions --quickstart   # one-flag setup
`;

export const biomeScaffoldCommand: ICommandHandler = {
  name: 'scaffold',
  description:
    'Scaffold a minimal Biome config that ignores SharkCraft generated paths. Documents which SharkCraft rules Biome cannot express. Dry-run by default; `--write` persists.',
  usage:
    'shrk biome scaffold [--output <path>] [--preset auto] [--write] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const presetMode = flagString(args, 'preset');
    if (presetMode && presetMode !== 'auto') {
      process.stderr.write(`Unknown --preset value "${presetMode}" (only "auto" is supported).\n`);
      return 2;
    }

    let generatedGlobs: readonly string[] = [];
    try {
      const inspection = await inspectSharkcraft({ cwd });
      const pathList = inspection.pathService.list();
      generatedGlobs = pathList
        .filter((p) => p.tags?.some((t) => /generated|build|dist|output/i.test(t)))
        .map((p) => (typeof p.metadata?.path === 'string' ? p.metadata.path : null))
        .filter((g): g is string => typeof g === 'string' && g.length > 0);
    } catch {
      // best-effort — the scaffold still works without sharkcraft/.
    }

    const body = renderBiomeSnippet(generatedGlobs);
    const outputRel = flagString(args, 'output') ?? SCAFFOLD_DEFAULT_RELPATH;
    const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.join(cwd, outputRel);

    if (flagBool(args, 'json')) {
      const mode = flagBool(args, 'write') ? 'write' : 'dry-run';
      process.stdout.write(asJson({ mode, output: outputAbs, bytes: body.length, body }) + '\n');
      if (mode !== 'write') return 0;
    }

    if (!flagBool(args, 'write')) {
      process.stdout.write(header('Biome scaffold — dry-run'));
      process.stdout.write(`output: ${outputAbs}\n`);
      process.stdout.write(`bytes:  ${body.length}\n\n`);
      process.stdout.write(body);
      process.stdout.write('\n' + BIOME_NOTES);
      process.stdout.write('\nRun with --write to persist.\n');
      return 0;
    }

    if (existsSync(outputAbs) && !flagBool(args, 'force')) {
      process.stderr.write(`Refusing to overwrite existing file: ${outputAbs}. Pass --force.\n`);
      return 1;
    }
    mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
    writeFileSync(outputAbs, body, 'utf8');
    process.stdout.write(`Wrote ${outputAbs}\n${BIOME_NOTES}`);
    return 0;
  },
};

/**
 * `shrk biome report` (boundary-adjacent JSON for Biome-aware
 * consumers). Biome has no official custom-rule plugin surface, so we
 * cannot produce *native* Biome output. We render an adjacent JSON
 * shape that mirrors Biome's diagnostics ergonomics: an array of
 * `{ category, severity, location: { path }, description }`. This is
 * documented as adjacent in `biome explain-limitations`.
 */
interface IBiomeBoundaryViolation {
  source?: string;
  target?: string;
  reason?: string;
  file?: string;
  line?: number;
  column?: number;
}

interface IBiomeReportShape {
  violations?: IBiomeBoundaryViolation[];
}

interface IBiomeAdjacentDiagnostic {
  category: 'sharkcraft/boundary-violation';
  severity: 'error';
  location: { path: string; line?: number; column?: number };
  description: string;
  source: 'sharkcraft';
}

export const biomeReportCommand: ICommandHandler = {
  name: 'report',
  description:
    'Convert `shrk check boundaries --json` output to a Biome-adjacent diagnostics JSON shape. Biome cannot natively consume this, but Biome-result-consuming tooling can.',
  usage: 'shrk biome report [--from <path>] [--output <path>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const from = flagString(args, 'from');
    const fromAbs = from
      ? nodePath.isAbsolute(from)
        ? from
        : nodePath.join(cwd, from)
      : null;
    if (!fromAbs) {
      process.stderr.write(
        'No --from <boundary-report.json> passed. Generate one first:\n' +
          '  $ shrk check boundaries --json > boundaries.json\n' +
          '  $ shrk biome report --from boundaries.json > biome-adjacent.json\n',
      );
      return 2;
    }
    if (!existsSync(fromAbs)) {
      process.stderr.write(`--from file not found: ${fromAbs}\n`);
      return 1;
    }
    let report: IBiomeReportShape;
    try {
      report = JSON.parse(readFileSync(fromAbs, 'utf8')) as IBiomeReportShape;
    } catch (e) {
      process.stderr.write(`Failed to parse boundary report JSON: ${(e as Error).message}\n`);
      return 1;
    }
    const out: IBiomeAdjacentDiagnostic[] = [];
    for (const v of report.violations ?? []) {
      const path = v.file ?? '<unknown>';
      const diag: IBiomeAdjacentDiagnostic = {
        category: 'sharkcraft/boundary-violation',
        severity: 'error',
        location: { path: nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path) },
        description:
          (v.reason ?? 'SharkCraft boundary violation') +
          (v.source && v.target ? ` (${v.source} → ${v.target})` : ''),
        source: 'sharkcraft',
      };
      if (typeof v.line === 'number') diag.location.line = v.line;
      if (typeof v.column === 'number') diag.location.column = v.column;
      out.push(diag);
    }
    const text = asJson({
      schema: 'sharkcraft.biome-adjacent/v1',
      tool: 'sharkcraft',
      generatedAt: new Date().toISOString(),
      diagnostics: out,
      note: 'Adjacent to Biome — not native Biome output. See `shrk biome explain-limitations`.',
    }) + '\n';
    const outputRel = flagString(args, 'output');
    if (outputRel) {
      const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.join(cwd, outputRel);
      mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
      writeFileSync(outputAbs, text, 'utf8');
      process.stdout.write(`Wrote ${outputAbs}\n`);
    } else {
      process.stdout.write(text);
    }
    return out.length > 0 ? 1 : 0;
  },
};

const BIOME_LIMITATIONS = `\
# Biome bridge — limitations

What the bridge **can** do today:

  • \`shrk biome scaffold\` — emit a minimal biome.json that ignores
    SharkCraft generated paths and lists the SharkCraft rules Biome
    cannot express.
  • \`shrk biome report\` — convert \`shrk check boundaries --json\`
    output to a Biome-adjacent diagnostics shape that Biome-result-
    consuming tooling can ingest. **Not native Biome output** — Biome
    has no public custom-rule plugin surface today.

What the bridge **cannot** express in Biome:

  • All cross-layer / cross-package boundary rules. Biome's lint
    grammar is narrower than ESLint's.
  • Plan safety, pack signatures, knowledge stale-check, template
    drift, self-config doctor. None of these have a Biome analog.
  • Custom SharkCraft rules with action hints.

Recommendation: use Biome for fast file-local linting / formatting;
keep \`shrk doctor\`, \`shrk check boundaries\`, \`shrk safety audit\`
in CI.

If you need a single tool to ingest SharkCraft findings, prefer
\`shrk eslint report\` (native ESLint result format) or
\`shrk checks aggregate\` (universal protocol). The Biome adjacent
report is a fallback for repos that have standardized on Biome and
don't want to add ESLint just for SharkCraft.
`;

/**
 * `shrk biome rules`. Inventory which SharkCraft constructs the
 * Biome bridge can cover, which are adjacent, and which are out of reach.
 * Biome's grammar is narrower than ESLint's, so the bridgeable column is
 * intentionally small — most SharkCraft enforcement stays in `shrk doctor`
 * / `shrk check boundaries` / `shrk packs doctor`.
 */
type BiomeBridgeStatus = 'bridgeable' | 'adjacent' | 'not-bridgeable';

interface IBiomeBridgeRow {
  kind: 'rule' | 'path' | 'boundary' | 'check' | 'safety';
  id: string;
  status: BiomeBridgeStatus;
  notes: string;
}

function buildBiomeBridgeInventory(
  rules: readonly { id: string; tags?: readonly string[] }[],
  paths: readonly { id: string; tags?: readonly string[] }[],
): IBiomeBridgeRow[] {
  const rows: IBiomeBridgeRow[] = [];
  for (const r of rules) {
    const tagText = (r.tags ?? []).join(' ').toLowerCase();
    let status: BiomeBridgeStatus = 'not-bridgeable';
    let notes = 'No Biome analog — keep in `shrk doctor` / `shrk check boundaries`.';
    if (tagText.includes('format') || tagText.includes('style') || tagText.includes('naming')) {
      status = 'bridgeable';
      notes = "Likely covered by Biome's built-in linter/formatter recommended rules.";
    } else if (tagText.includes('import') || tagText.includes('boundary') || tagText.includes('layer')) {
      status = 'adjacent';
      notes = 'Adjacent — `shrk biome report` re-emits boundary findings; Biome itself cannot enforce.';
    } else if (tagText.includes('safety') || tagText.includes('signing') || tagText.includes('plan') || tagText.includes('pack')) {
      status = 'not-bridgeable';
      notes = 'Plan / pack / signing semantics — Biome has no concept.';
    }
    rows.push({ kind: 'rule', id: r.id, status, notes });
  }
  for (const p of paths) {
    const tagText = (p.tags ?? []).join(' ').toLowerCase();
    const isGenerated = /generated|build|dist|output/.test(tagText);
    rows.push({
      kind: 'path',
      id: p.id,
      status: isGenerated ? 'bridgeable' : 'adjacent',
      notes: isGenerated
        ? "Goes in biome.json `files.ignore`."
        : 'Adjacent: SharkCraft surfaces for context; not directly enforceable.',
    });
  }
  rows.push({
    kind: 'boundary',
    id: 'check-boundaries',
    status: 'adjacent',
    notes: '`shrk biome report` emits Biome-adjacent diagnostics; Biome cannot enforce.',
  });
  rows.push({
    kind: 'safety',
    id: 'plan-signing / pack-signatures / knowledge-stale / template-drift / self-config',
    status: 'not-bridgeable',
    notes: 'CI gate only — Biome has no semantic for any of these.',
  });
  return rows;
}

export const biomeRulesCommand: ICommandHandler = {
  name: 'rules',
  description:
    'Inventory which SharkCraft constructs can be bridged to Biome (bridgeable / adjacent / not-bridgeable). Read-only.',
  usage: 'shrk biome rules [--json] [--filter bridgeable|adjacent|not-bridgeable]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    let rules: { id: string; tags?: readonly string[] }[] = [];
    let paths: { id: string; tags?: readonly string[] }[] = [];
    try {
      const inspection = await inspectSharkcraft({ cwd });
      rules = inspection.ruleService.list().map((r) => ({ id: r.id, tags: r.tags ?? [] }));
      paths = inspection.pathService.list().map((p) => ({ id: p.id, tags: p.tags ?? [] }));
    } catch {
      // best-effort
    }
    const inventory = buildBiomeBridgeInventory(rules, paths);
    const filter = flagString(args, 'filter');
    const filtered = filter ? inventory.filter((r) => r.status === filter) : inventory;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ total: inventory.length, rows: filtered }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Biome bridge inventory (${filtered.length} of ${inventory.length})`));
    const buckets: Record<BiomeBridgeStatus, IBiomeBridgeRow[]> = {
      bridgeable: [],
      adjacent: [],
      'not-bridgeable': [],
    };
    for (const r of filtered) buckets[r.status].push(r);
    for (const status of ['bridgeable', 'adjacent', 'not-bridgeable'] as BiomeBridgeStatus[]) {
      const rows = buckets[status];
      if (!rows.length) continue;
      process.stdout.write(`\n[${status}] ${rows.length}\n`);
      for (const r of rows) {
        process.stdout.write(`  ${r.kind.padEnd(9)} ${r.id}\n`);
        process.stdout.write(`            ${r.notes}\n`);
      }
    }
    process.stdout.write(
      '\nKeep in CI: `shrk check boundaries`, `shrk safety audit`, `shrk packs doctor`, `shrk knowledge stale-check`, `shrk templates drift`.\n',
    );
    return 0;
  },
};

export const biomeExplainLimitationsCommand: ICommandHandler = {
  name: 'explain-limitations',
  description:
    'Print the honest list of what cannot be bridged from SharkCraft to Biome and what to keep in CI.',
  usage: 'shrk biome explain-limitations [--json]',
  async run(args: ParsedArgs): Promise<number> {
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          bridgeable: [
            'generated path ignores',
            'formatter / organizeImports defaults',
          ],
          adjacent: [
            'shrk check boundaries (via `shrk biome report`, non-native shape)',
          ],
          notBridgeable: [
            'cross-layer boundary rules',
            'plan signing',
            'pack signatures',
            'knowledge stale-check',
            'template drift',
            'self-config doctor',
            'custom SharkCraft rules with action hints',
          ],
          keepInCi: [
            'shrk doctor',
            'shrk check boundaries',
            'shrk safety audit',
            'shrk packs doctor',
            'shrk knowledge stale-check',
            'shrk templates drift',
          ],
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(BIOME_LIMITATIONS);
    return 0;
  },
};

export const biomeCommand: ICommandHandler = {
  name: 'biome',
  description:
    'Biome bridge. `scaffold` emits a minimal biome.json that ignores SharkCraft generated paths; `report` converts boundary JSON to a Biome-adjacent diagnostics shape; `rules` inventories what can be bridged; `explain-limitations` documents what cannot. `config` is an alias for `scaffold`.',
  usage: 'shrk biome <scaffold|config|report|rules|explain-limitations> [...flags]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0];
    if (verb === 'scaffold' || verb === 'config') {
      return biomeScaffoldCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (verb === 'report') {
      return biomeReportCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (verb === 'rules') {
      return biomeRulesCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (verb === 'explain-limitations') {
      return biomeExplainLimitationsCommand.run({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    process.stderr.write('Usage: shrk biome <scaffold|config|report|rules|explain-limitations> [...flags]\n');
    return 2;
  },
};
