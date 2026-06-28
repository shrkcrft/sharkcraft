import { GraphStore, GraphQueryApi } from '@shrkcrft/graph';
import { loadProjectConfig } from '@shrkcrft/config';
import type { IReusePrimitive } from '@shrkcrft/core';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

const STOP: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'with', 'in', 'on', 'into', 'my',
  'add', 'use', 'using', 'create', 'make', 'new', 'build', 'want', 'need', 'how', 'do',
]);

function tokenize(s: string): string[] {
  // Min length 3: 2-char tokens (`ui`, `id`) substring-match unrelated text
  // (`guidance`, `valid`) and produce false-positive primitive matches.
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ];
}

function scorePrimitive(p: IReusePrimitive, tokens: readonly string[]): number {
  // Substring match (so intent "debounce" matches symbol `useDebounce`); the
  // 3-char minimum above keeps it from over-matching on tiny fragments.
  const hay = [p.symbol, ...(p.roles ?? []), ...(p.keywords ?? []), p.description ?? '']
    .join(' ')
    .toLowerCase();
  let s = 0;
  for (const t of tokens) if (hay.includes(t)) s += 1;
  // A role the intent mentions is a strong signal; re-weight role hits.
  for (const role of p.roles ?? []) {
    const rl = role.toLowerCase();
    if (rl.length >= 3 && tokens.some((t) => rl.includes(t))) s += 0.5;
  }
  return s;
}

const INDEX_RE = /(^|\/)index\.[cm]?[jt]sx?$/;

interface IReuseResult {
  symbol: string;
  score: number;
  description?: string;
  roles: readonly string[];
  /** Public import specifier — only set from a configured `importPath`. */
  importPath?: string;
  importLine?: string;
  declaredIn?: string;
  declaredLine?: number;
  /** A barrel that re-exports the declaring file (a hint when importPath is unset). */
  reExportedVia?: string;
  siblings: string[];
  consumers: { path: string; line?: number }[];
  /** Other same-named declarations (the name is ambiguous in this repo). */
  alternates?: string[];
  /** True when the graph is indexed but the configured symbol was not found. */
  notFound?: boolean;
}

export const reuseCommand: ICommandHandler = {
  name: 'reuse',
  description:
    'Intent → the canonical primitive to reuse. Matches your intent against configured reusePrimitives[], then resolves the symbol in the code graph to its declaration, public import path, sibling exports, and real consumer files to copy. Deterministic; no AI.',
  usage: 'shrk reuse "<what I want to build>" [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const limit = flagNumber(args, 'limit') ?? 3;
    const intent = args.positional.join(' ').trim();
    if (!intent) {
      process.stderr.write('Usage: shrk reuse "<what I want to build>" [--limit N] [--json]\n');
      return 2;
    }

    const loaded = await loadProjectConfig(cwd);
    if (!loaded.ok) {
      const msg = loaded.error.message;
      if (wantJson) {
        process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, error: msg, results: [] }) + '\n');
        return 1;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
      return 1;
    }
    const primitives = loaded.value.config.reusePrimitives ?? [];
    if (primitives.length === 0) {
      if (wantJson) {
        process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, results: [] }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write(
        '  No reuse primitives configured. Declare `reusePrimitives[]` in sharkcraft.config.ts\n' +
          '  to map roles/intents to canonical symbols (see docs/reuse.md).\n',
      );
      return 0;
    }

    const tokens = tokenize(intent);
    const ranked = primitives
      .map((p) => ({ p, score: scorePrimitive(p, tokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.p.symbol.localeCompare(b.p.symbol))
      .slice(0, Math.max(1, limit));

    const store = new GraphStore(cwd);
    const api = store.exists() ? GraphQueryApi.fromStore(cwd) : null;

    if (ranked.length === 0) {
      const roles = [...new Set(primitives.flatMap((p) => p.roles))].sort();
      if (wantJson) {
        process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, results: [], availableRoles: roles }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write('  No primitive matched. Available roles:\n');
      for (const r of roles.slice(0, 40)) process.stdout.write(`    • ${r}\n`);
      return 0;
    }

    const results: IReuseResult[] = ranked.map(({ p, score }) => {
      const r: IReuseResult = { symbol: p.symbol, score, roles: p.roles, siblings: [], consumers: [] };
      if (p.description) r.description = p.description;
      if (p.importPath) r.importPath = p.importPath;
      if (api) {
        // Disambiguate same-named declarations deterministically: prefer
        // exported symbols, then shallowest path; disclose the alternates.
        const candidates = api
          .findSymbol(p.symbol, { exact: true })
          .slice()
          .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
        const exported = candidates.filter((c) => c.data?.['isExported'] === true);
        const pool = exported.length > 0 ? exported : candidates;
        const sym = pool[0];
        if (sym) {
          if (sym.path) r.declaredIn = sym.path;
          if (sym.line) r.declaredLine = sym.line;
          if (sym.path) {
            const fileNode = api.findFile(sym.path);
            if (fileNode) {
              r.siblings = api
                .symbolsIn(fileNode.id)
                .filter((s) => s.data?.['isExported'] === true && s.label && s.label !== p.symbol)
                .map((s) => s.label)
                .slice(0, 8);
              // When no public importPath is configured, surface a re-exporting
              // barrel as a hint (we never fabricate a module specifier from a
              // deep file path — that would be a broken/unusable import).
              if (!r.importPath) {
                const barrel = api.importersOf(fileNode.id).find((n) => n.path && INDEX_RE.test(n.path));
                if (barrel?.path) r.reExportedVia = barrel.path;
              }
            }
          }
          r.consumers = api
            .referenceSitesOf(sym.id)
            .slice(0, 5)
            .map((s) => ({ path: s.node.path ?? s.node.id, ...(s.line ? { line: s.line } : {}) }));
          const alts = pool.slice(1).map((c) => c.path).filter((x): x is string => !!x);
          if (alts.length > 0) r.alternates = alts;
        } else {
          r.notFound = true;
        }
      }
      // The import line is emitted ONLY from a configured importPath (a clean,
      // copy-pasteable specifier). Without it we show declaration + barrel hint.
      if (r.importPath) r.importLine = `import { ${p.symbol} } from '${r.importPath}';`;
      return r;
    });

    if (wantJson) {
      process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, graphIndexed: !!api, results }) + '\n');
      return 0;
    }

    process.stdout.write(header(`Reuse: "${intent}"`));
    if (!api) {
      process.stdout.write(
        '  (code graph missing — import path/siblings/consumers limited; run `shrk graph index`)\n',
      );
    }
    let i = 0;
    for (const r of results) {
      i += 1;
      process.stdout.write(`\n${i}. ${r.symbol}\n`);
      if (r.description) process.stdout.write(`   ${r.description}\n`);
      if (r.notFound) {
        process.stdout.write(
          '   ⚠ symbol not found in the code graph — verify reusePrimitives[].symbol (typo/rename?) or run `shrk graph index`\n',
        );
      }
      if (r.importLine) {
        process.stdout.write(`   import: ${r.importLine}\n`);
      } else if (r.reExportedVia) {
        process.stdout.write(
          `   re-exported via: ${r.reExportedVia}  (set reusePrimitives[].importPath for a copy-paste import)\n`,
        );
      }
      if (r.declaredIn) {
        process.stdout.write(`   declared in: ${r.declaredIn}${r.declaredLine ? ':' + r.declaredLine : ''}\n`);
      }
      if (r.alternates && r.alternates.length > 0) {
        process.stdout.write(`   ⚠ name also declared in: ${r.alternates.join(', ')}\n`);
      }
      if (r.siblings.length > 0) process.stdout.write(`   sibling exports: ${r.siblings.join(', ')}\n`);
      if (r.consumers.length > 0) {
        process.stdout.write('   consumers to copy:\n');
        for (const c of r.consumers) process.stdout.write(`     - ${c.path}${c.line ? ':' + c.line : ''}\n`);
      }
    }
    return 0;
  },
};
