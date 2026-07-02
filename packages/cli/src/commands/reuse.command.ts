import { GraphStore, GraphQueryApi } from '@shrkcrft/graph';
import { resolveProjectConfig } from '@shrkcrft/inspector';
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

interface IMatchDetail {
  /** Raw score: +1 per distinct query token that hits the haystack, +0.5 per role hit. */
  score: number;
  /** The distinct query tokens that matched — the evidence behind the score. */
  matched: string[];
  /** True when a query token matched the symbol name itself (the strongest signal). */
  symbolHit: boolean;
}

function scorePrimitive(p: IReusePrimitive, tokens: readonly string[]): IMatchDetail {
  // Substring match (so intent "debounce" matches symbol `useDebounce`); the
  // 3-char minimum above keeps it from over-matching on tiny fragments.
  const symbolLower = p.symbol.toLowerCase();
  const hay = [p.symbol, ...(p.roles ?? []), ...(p.keywords ?? []), p.description ?? '']
    .join(' ')
    .toLowerCase();
  let s = 0;
  const matched: string[] = [];
  let symbolHit = false;
  for (const t of tokens) {
    if (hay.includes(t)) {
      s += 1;
      matched.push(t);
      if (symbolLower.includes(t)) symbolHit = true;
    }
  }
  // A role the intent mentions is a strong signal; re-weight role hits.
  for (const role of p.roles ?? []) {
    const rl = role.toLowerCase();
    if (rl.length >= 3 && tokens.some((t) => rl.includes(t))) s += 0.5;
  }
  return { score: s, matched, symbolHit };
}

/**
 * Confidence floor: a keyword collision is not a match. A hit is only "confident"
 * when it matched the symbol name itself, OR matched ≥2 distinct query tokens, OR
 * the query was a single token and that token hit. A single generic keyword hit on
 * a multi-token intent (the "nearest collision on an unrelated entry" failure mode)
 * is a weak match — surfaced as a did-you-mean, never as a confident answer.
 */
function isConfidentMatch(detail: IMatchDetail, queryTokenCount: number): boolean {
  if (detail.matched.length === 0) return false;
  if (detail.symbolHit) return true;
  if (detail.matched.length >= 2) return true;
  return queryTokenCount <= 1;
}

const INDEX_RE = /(^|\/)index\.[cm]?[jt]sx?$/;

interface IReuseResult {
  symbol: string;
  score: number;
  /** Fraction of distinct query tokens that hit this primitive (0..1). */
  confidence: number;
  /** The distinct query tokens that matched — the evidence behind the score. */
  matched: readonly string[];
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
  /** Total real consumer sites in the graph (the denominator for the shown `consumers`). */
  consumerTotal?: number;
  /** Other same-named declarations (the name is ambiguous in this repo). */
  alternates?: string[];
  /** True when the graph is indexed but the configured symbol was not found. */
  notFound?: boolean;
}

/** A weak (below-confidence) candidate offered as a did-you-mean, never as an answer. */
interface IReuseSuggestion {
  symbol: string;
  score: number;
  confidence: number;
  matched: readonly string[];
  roles: readonly string[];
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

    const loaded = await resolveProjectConfig(cwd);
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
    const planeDiagnostics = loaded.value.planeDiagnostics;
    // reuse has no pre-existing diagnostics surface; expose pack-plane merge
    // notes (missing/invalid pack primitive files, dropped collisions) so a
    // pack contribution that failed to load isn't silently invisible.
    const planeJson = planeDiagnostics.length > 0 ? { planeDiagnostics } : {};
    const writePlaneNotes = (): void => {
      for (const d of planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    };
    if (primitives.length === 0) {
      if (wantJson) {
        process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, results: [], ...planeJson }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write(
        '  No reuse primitives configured. Declare `reusePrimitives[]` in sharkcraft.config.ts\n' +
          '  to map roles/intents to canonical symbols (see docs/reuse.md).\n',
      );
      writePlaneNotes();
      return 0;
    }

    const tokens = tokenize(intent);
    const confidenceOf = (matched: number): number =>
      tokens.length === 0 ? 0 : matched / tokens.length;
    const scored = primitives
      .map((p) => ({ p, detail: scorePrimitive(p, tokens) }))
      .filter((x) => x.detail.score > 0)
      .sort((a, b) => b.detail.score - a.detail.score || a.p.symbol.localeCompare(b.p.symbol));
    const confident = scored.filter((x) => isConfidentMatch(x.detail, tokens.length));
    const ranked = confident.slice(0, Math.max(1, limit));

    const store = new GraphStore(cwd);
    const api = store.exists() ? GraphQueryApi.fromStore(cwd) : null;

    // Zero keyword overlap: nothing matched at all → surface available roles.
    if (scored.length === 0) {
      const roles = [...new Set(primitives.flatMap((p) => p.roles))].sort();
      if (wantJson) {
        process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, results: [], availableRoles: roles, ...planeJson }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write('  No primitive matched. Available roles:\n');
      for (const r of roles.slice(0, 40)) process.stdout.write(`    • ${r}\n`);
      writePlaneNotes();
      return 0;
    }

    // Weak overlap only (a single generic keyword collision on an unrelated
    // entry): below the confidence floor. A miss must look like a miss — never
    // return the nearest collision as a confident answer. Offer did-you-mean.
    if (ranked.length === 0) {
      const didYouMean: IReuseSuggestion[] = scored.slice(0, 5).map((x) => ({
        symbol: x.p.symbol,
        score: x.detail.score,
        confidence: confidenceOf(x.detail.matched.length),
        matched: x.detail.matched,
        roles: x.p.roles,
      }));
      if (wantJson) {
        process.stdout.write(
          asJson({ schema: 'sharkcraft.reuse/v1', intent, confident: false, results: [], didYouMean, ...planeJson }) + '\n',
        );
        return 0;
      }
      process.stdout.write(header(`Reuse: "${intent}"`));
      process.stdout.write(
        '  No confident match — the intent only weakly overlaps existing primitives.\n' +
          '  Did you mean (weak, verify before reusing):\n',
      );
      for (const s of didYouMean) {
        process.stdout.write(
          `    • ${s.symbol}  (score ${s.score}, ${Math.round(s.confidence * 100)}% of intent; matched: ${s.matched.join(', ') || '—'})\n`,
        );
      }
      writePlaneNotes();
      return 0;
    }

    const results: IReuseResult[] = ranked.map(({ p, detail }) => {
      const score = detail.score;
      const r: IReuseResult = {
        symbol: p.symbol,
        score,
        confidence: confidenceOf(detail.matched.length),
        matched: detail.matched,
        roles: p.roles,
        siblings: [],
        consumers: [],
      };
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
          const sites = api.referenceSitesOf(sym.id);
          r.consumerTotal = sites.length;
          r.consumers = sites
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
      process.stdout.write(asJson({ schema: 'sharkcraft.reuse/v1', intent, graphIndexed: !!api, results, ...planeJson }) + '\n');
      return 0;
    }

    process.stdout.write(header(`Reuse: "${intent}"`));
    writePlaneNotes();
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
      process.stdout.write(
        `   match: score ${r.score} (${Math.round(r.confidence * 100)}% of intent; matched: ${r.matched.join(', ') || '—'})\n`,
      );
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
        const total = r.consumerTotal ?? r.consumers.length;
        const label =
          total > r.consumers.length
            ? `   consumers to copy (${total} total, showing ${r.consumers.length}):\n`
            : `   consumers to copy (${total} total):\n`;
        process.stdout.write(label);
        for (const c of r.consumers) process.stdout.write(`     - ${c.path}${c.line ? ':' + c.line : ''}\n`);
      }
    }
    return 0;
  },
};
