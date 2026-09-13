import { GraphStore, GraphQueryApi } from '@shrkcrft/graph';
import {
  curatedDeclarationMap,
  rankReuseCandidates,
  resolveCuratedReuse,
  resolveProjectConfig,
  reuseImportLine,
  type IReuseCandidate,
  type IReuseCuratedResolution,
  type IReuseRanking,
  type IReuseSuggestion,
} from '@shrkcrft/inspector';
import {
  MatchConfidenceVerdict,
  ReuseCandidateSource,
  ReuseImportStyle,
  ReuseMatchSource,
  ReuseNameMatch,
  UnfollowedReExportKind,
  type IPublicExportSurface,
  type IReusePrimitive,
  type IUnfollowedReExport,
} from '@shrkcrft/core';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { graphReuseLookup } from '../graph/graph-reuse-lookup.ts';
import { indexBehindHint } from '../graph/index-behind-hint.ts';
import { asJson, header } from '../output/format-output.ts';

/**
 * The did-you-mean ranker. The engine lives in `@shrkcrft/inspector` (pure, so
 * a read-only MCP tool can call it); re-exported here for existing importers.
 */
export { rankReuseSuggestions } from '@shrkcrft/inspector';

const INDEX_RE = /(^|\/)index\.[cm]?[jt]sx?$/;

/** Whether the uncurated public export surface was consulted, and how much of it. */
enum ExportSurfaceStatus {
  /** Every workspace package root was walked in full. */
  Searched = 'searched',
  /**
   * Searched, but part of the surface could not be walked — a package with no
   * resolved entry, or a local re-export the index could not follow. `reason`
   * says which; the unwalked part is listed.
   */
  Partial = 'partial',
  /** Nothing was searched: no graph index, or no package entry to start from. */
  NotSearched = 'not-searched',
  /** `--curated-only`. */
  Disabled = 'disabled',
}

interface IExportSurfaceInfo {
  status: ExportSurfaceStatus;
  reason?: string;
  roots: number;
  packagesWithoutEntry: { package: string; reason: string }[];
  size: number;
  unresolvedReExports?: number;
  /** Each re-export not followed: `unresolved` (local — NOT searched) or `external`. */
  unfollowedReExports?: IUnfollowedReExport[];
}

interface IReuseResult {
  symbol: string;
  /** `curated` (a reusePrimitives[] entry) or `export-surface` (uncurated). */
  source: ReuseCandidateSource;
  score: number;
  /** Fraction of distinct query tokens that hit this candidate (0..1). */
  confidence: number;
  /** The distinct query tokens that matched — the evidence behind the score. */
  matched: readonly string[];
  /** Which fields the tokens hit (symbol / role / keyword / description). */
  matchedVia: readonly ReuseMatchSource[];
  /** The NAME-level match, by token equality. `none` = matched only through metadata. */
  nameMatch: ReuseNameMatch;
  description?: string;
  roles: readonly string[];
  /** Uncurated only: the workspace package whose root entry exposes it. */
  package?: string;
  /** Public import specifier — a configured `importPath`, or (uncurated) the exposing package. */
  importPath?: string;
  importLine?: string;
  /** How `importLine` binds the symbol — `default` for a module's default export. */
  importStyle?: ReuseImportStyle;
  /**
   * Curated only, when the graph could check it: does `importPath` export the
   * symbol? `false` = `importLine` would not compile (`shrk reuse coverage`
   * fails on it).
   */
  importPathAgrees?: boolean;
  declaredIn?: string;
  declaredLine?: number;
  /** Uncurated only: barrel files from the package entry to the declaration. */
  via?: readonly string[];
  /** It is its module's DEFAULT export (`importLine` is a default import). */
  isDefault?: boolean;
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

const SOURCE_WORD: Record<ReuseMatchSource, string> = {
  [ReuseMatchSource.Symbol]: 'name',
  [ReuseMatchSource.Role]: 'roles',
  [ReuseMatchSource.Keyword]: 'keywords',
  [ReuseMatchSource.Description]: 'description',
};

const NAME_MATCH_WORDS: Record<ReuseNameMatch, string> = {
  [ReuseNameMatch.Exact]: 'exact name match',
  [ReuseNameMatch.Covers]: 'name covers the intent',
  [ReuseNameMatch.Partial]: 'partial name match',
  [ReuseNameMatch.None]: 'no name match',
};

export const reuseCommand: ICommandHandler = {
  name: 'reuse',
  // The positionals are the free-form intent (`coverage` is a trie child).
  positionals: PositionalMode.Free,
  description:
    'Intent → the canonical primitive to reuse. Ranks configured reusePrimitives[] AND (with a code graph) the uncurated public export surface of every workspace package — an exactly-named exported construct outranks a curated entry that names only part of the intent or matched only through its metadata, and is labelled uncurated. Resolves each answer to its declaration, public import path (a default import for a default export), sibling exports and real consumer files. `shrk reuse coverage` measures curation drift. Deterministic; no AI.',
  usage:
    'shrk reuse "<what I want to build>" [--limit N] [--all] [--curated-only] [--include-types] [--json]   ·   shrk reuse coverage',
  booleanFlags: new Set(['json', 'all', 'curated-only', 'include-types']),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const wantAll = flagBool(args, 'all');
    const curatedOnly = flagBool(args, 'curated-only');
    const includeTypes = flagBool(args, 'include-types');
    // `--limit N` caps both the confident results (historic default 3) and the
    // did-you-mean suggestion list. When omitted, suggestions default to 5 (a
    // couple more than results — the point of a did-you-mean is a short menu).
    const limitFlag = flagNumber(args, 'limit');
    const limit = limitFlag ?? 3;
    const suggestK = limitFlag ?? 5;
    const intent = args.positional.join(' ').trim();
    if (!intent) {
      process.stderr.write(
        'Usage: shrk reuse "<what I want to build>" [--limit N] [--all] [--curated-only] [--include-types] [--json]\n',
      );
      return ExitCode.UsageError;
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

    const store = new GraphStore(cwd);
    const api = store.exists() ? GraphQueryApi.fromStore(cwd) : null;

    // The public surface, whenever a graph exists: the uncurated candidates
    // (unless --curated-only), AND — always — how a curated `importPath`
    // exports its symbol, so the printed import line compiles. Lazy + memoized.
    const fullSurface = api ? api.publicExportSurface() : undefined;
    const lookup = api ? graphReuseLookup(api) : undefined;
    // ONE resolution per curated entry — the record `shrk reuse coverage` judges
    // the entry by: its construct, its import line, whether that compiles.
    const resolutionList = primitives.map((p) => resolveCuratedReuse(p, fullSurface, lookup));
    const resolutions = new Map<IReusePrimitive, IReuseCuratedResolution>(
      primitives.map((p, i) => [p, resolutionList[i]!]),
    );

    // The uncurated export surface — searched whenever a graph exists and has a
    // package root, unless the caller asked for the curated index alone. A
    // skipped (or partial) search is said out loud: "no uncurated match" and
    // "never looked" must not read alike.
    let surface: IPublicExportSurface | undefined;
    let exportSurface: IExportSurfaceInfo;
    if (curatedOnly) {
      exportSurface = { status: ExportSurfaceStatus.Disabled, reason: '--curated-only', roots: 0, packagesWithoutEntry: [], size: 0 };
    } else if (!fullSurface) {
      exportSurface = {
        status: ExportSurfaceStatus.NotSearched,
        reason: 'no graph index — run `shrk graph index`',
        roots: 0,
        packagesWithoutEntry: [],
        size: 0,
      };
    } else if (fullSurface.roots.length === 0) {
      // Zero roots walked is "never looked", never "looked, found nothing".
      exportSurface = {
        status: ExportSurfaceStatus.NotSearched,
        reason:
          fullSurface.packagesWithoutEntry.length > 0
            ? 'no package entry resolves to an indexed file'
            : 'no workspace packages (package.json `workspaces`)',
        roots: 0,
        packagesWithoutEntry: fullSurface.packagesWithoutEntry.map((p) => ({ package: p.package, reason: p.reason })),
        size: 0,
      };
    } else {
      surface = fullSurface;
      const local = fullSurface.unfollowedReExports.filter((u) => u.kind === UnfollowedReExportKind.Unresolved);
      const gaps: string[] = [];
      if (fullSurface.packagesWithoutEntry.length > 0) {
        const total = fullSurface.roots.length + fullSurface.packagesWithoutEntry.length;
        gaps.push(`${fullSurface.packagesWithoutEntry.length} of ${total} package(s) have no resolved entry`);
      }
      if (local.length > 0) gaps.push(`${local.length} re-export(s) the index could not follow`);
      exportSurface = {
        status: gaps.length > 0 ? ExportSurfaceStatus.Partial : ExportSurfaceStatus.Searched,
        ...(gaps.length > 0 ? { reason: gaps.join('; ') } : {}),
        roots: fullSurface.roots.length,
        packagesWithoutEntry: fullSurface.packagesWithoutEntry.map((p) => ({ package: p.package, reason: p.reason })),
        size: fullSurface.exports.length,
        ...(fullSurface.unfollowedReExports.length > 0
          ? {
              unresolvedReExports: fullSurface.unfollowedReExports.length,
              unfollowedReExports: [...fullSurface.unfollowedReExports],
            }
          : {}),
      };
    }

    // The curated constructs, by resolved declaration — exactly the exclusion
    // `shrk reuse coverage` applies (a same-named export of a DIFFERENT
    // construct stays a candidate).
    const curatedDeclaredIn = api ? curatedDeclarationMap(primitives, resolutionList) : undefined;
    const ranking = rankReuseCandidates(primitives, surface, intent, {
      limit,
      suggestLimit: suggestK,
      includeTypes,
      curatedOnly,
      ...(curatedDeclaredIn ? { curatedDeclaredIn } : {}),
    });
    const confidenceJson = {
      confident: ranking.confident,
      verdict: ranking.verdict,
      floor: ranking.floor,
      bestScore: ranking.bestScore,
    };
    // The miss path only (nothing matched by NAME): is the index behind? The
    // freshness walk is not free, so it never runs on a hit.
    const behind = api && !ranking.nameAnswered ? indexBehindHint(cwd) : null;
    const surfaceJson = {
      exportSurface,
      curationGap: ranking.curationGap,
      superseded: ranking.superseded,
      ...(behind ? { indexBehind: behind } : {}),
    };

    const writeSurfaceNotes = (): void => {
      if (exportSurface.status === ExportSurfaceStatus.NotSearched) {
        process.stdout.write(
          api
            ? `  ⚠ uncurated export surface NOT searched (${exportSurface.reason ?? 'no package root'})\n`
            : '  ⚠ uncurated export surface NOT searched (no graph index) — run `shrk graph index`\n',
        );
      }
      const byReason = new Map<string, string[]>();
      for (const p of exportSurface.packagesWithoutEntry) {
        const list = byReason.get(p.reason);
        if (list) list.push(p.package);
        else byReason.set(p.reason, [p.package]);
      }
      for (const [reason, pkgs] of byReason) {
        const shown = pkgs.slice(0, 4).join(', ') + (pkgs.length > 4 ? `, +${pkgs.length - 4} more` : '');
        process.stdout.write(`  ⚠ ${pkgs.length} package(s) not searched — ${reason} (${shown})\n`);
      }
      const unfollowed = exportSurface.unfollowedReExports ?? [];
      const local = unfollowed.filter((u) => u.kind === UnfollowedReExportKind.Unresolved);
      if (local.length > 0) {
        const shown = local.slice(0, 3).map(formatUnfollowed).join(', ') + (local.length > 3 ? `, +${local.length - 3} more` : '');
        process.stdout.write(`  ⚠ ${local.length} re-export(s) not followed — part of the surface NOT searched (${shown})\n`);
      }
      const external = unfollowed.length - local.length;
      if (external > 0) {
        process.stdout.write(`  (${external} re-export(s) of modules outside the workspace not followed)\n`);
      }
      for (const s of ranking.superseded) {
        process.stdout.write(
          `  (superseded: ${s.symbol} from ${s.package} → use ${s.supersededBy.join(' / ')} — per reusePrimitives[].supersedes)\n`,
        );
      }
      if (behind) process.stdout.write(`  ⚠ ${behind}\n`);
    };

    if (ranking.results.length === 0) {
      return writeNoAnswer({
        intent,
        ranking,
        primitivesCount: primitives.length,
        roles: [...new Set(primitives.flatMap((p) => p.roles))].sort(),
        wantJson,
        wantAll,
        extraJson: { ...confidenceJson, ...surfaceJson, ...planeJson },
        writeNotes: () => {
          writePlaneNotes();
          writeSurfaceNotes();
        },
      });
    }

    const results = ranking.results.map((c) =>
      enrichResult(c, api, c.primitive ? resolutions.get(c.primitive) : undefined),
    );

    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.reuse/v1',
          intent,
          graphIndexed: !!api,
          ...confidenceJson,
          results,
          ...surfaceJson,
          ...planeJson,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Reuse: "${intent}"`));
    writePlaneNotes();
    writeSurfaceNotes();
    if (!api) {
      process.stdout.write(
        '  (code graph missing — import path/siblings/consumers limited; run `shrk graph index`)\n',
      );
    }
    let i = 0;
    for (const r of results) {
      i += 1;
      process.stdout.write(`\n${i}. ${r.symbol}  [${resultLabel(r)}]\n`);
      if (r.description) process.stdout.write(`   ${r.description}\n`);
      process.stdout.write(`   match: ${matchLine(r)}\n`);
      if (r.notFound) {
        process.stdout.write(
          '   ⚠ symbol not found in the code graph — verify reusePrimitives[].symbol (typo/rename?) or run `shrk graph index`\n',
        );
      }
      if (r.importLine) {
        process.stdout.write(`   import: ${r.importLine}\n`);
        if (r.importPathAgrees === false) {
          process.stdout.write(
            `   ⚠ '${r.importPath}' does not export ${r.symbol} (per the index) — this import would not compile; see \`shrk reuse coverage\`\n`,
          );
        }
      } else if (r.reExportedVia) {
        process.stdout.write(
          `   re-exported via: ${r.reExportedVia}  (set reusePrimitives[].importPath for a copy-paste import)\n`,
        );
      }
      if (r.declaredIn) {
        process.stdout.write(`   declared in: ${r.declaredIn}${r.declaredLine ? ':' + r.declaredLine : ''}\n`);
      }
      if (r.via && r.via.length > 0) process.stdout.write(`   reached via: ${r.via.join(' → ')}\n`);
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
    if (ranking.curationGap) {
      process.stdout.write(
        '\n  ⚠ Curation gap: an uncurated export matches this intent by NAME, while the best curated\n' +
          '    candidate names only part of it, or matched only through its roles/keywords/description.\n' +
          '    Add the export to reusePrimitives[] — or list it in the curated entry\'s `supersedes` — and\n' +
          '    run `shrk reuse coverage` to see every such gap.\n',
      );
    }
    return 0;
  },
};

/** No confident answer: a weak did-you-mean, or a plain "nothing shares a term". */
function writeNoAnswer(o: {
  intent: string;
  ranking: IReuseRanking;
  primitivesCount: number;
  roles: string[];
  wantJson: boolean;
  wantAll: boolean;
  extraJson: Record<string, unknown>;
  writeNotes: () => void;
}): number {
  const { ranking, wantAll } = o;
  const suggestions = ranking.suggestions;
  const weak = ranking.verdict === MatchConfidenceVerdict.NoConfidentMatch;
  if (o.wantJson) {
    process.stdout.write(
      asJson({
        schema: 'sharkcraft.reuse/v1',
        intent: o.intent,
        results: [],
        suggestions,
        // The legacy alias, kept on the weak branch where it always lived.
        ...(weak ? { didYouMean: suggestions } : {}),
        ...(wantAll ? { availableRoles: o.roles } : {}),
        ...o.extraJson,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Reuse: "${o.intent}"`));
  if (o.primitivesCount === 0) {
    process.stdout.write(
      '  No reuse primitives configured. Declare `reusePrimitives[]` in sharkcraft.config.ts\n' +
        '  to map roles/intents to canonical symbols (see docs/reuse.md).\n',
    );
  }
  if (weak) {
    // Weak overlap only (a single generic keyword collision on an unrelated
    // entry, or an export sharing only part of the name): below the confidence
    // floor. A miss must look like a miss — never the nearest collision as an answer.
    process.stdout.write(
      '  No confident match — the intent only weakly overlaps existing candidates.\n' +
        '  Did you mean (weak, verify before reusing):\n',
    );
    for (const s of suggestions) process.stdout.write(`    • ${suggestionLine(s)}\n`);
    if (wantAll) {
      process.stdout.write('  Full catalog (all declared roles):\n');
      for (const r of o.roles.slice(0, 40)) process.stdout.write(`    • ${r}\n`);
    }
  } else if (o.primitivesCount > 0) {
    // Zero overlap: rather than dump the whole catalog, the alphabetized
    // nearest top-K (every score is 0 here), stated as such. The full catalog
    // is available only behind an explicit `--all`.
    if (wantAll) {
      process.stdout.write('  No primitive matched — no candidate shares any term — showing full catalog:\n');
      for (const r of o.roles.slice(0, 40)) process.stdout.write(`    • ${r}\n`);
    } else {
      process.stdout.write(
        '  No strong match — no candidate shares any term with the intent.\n' +
          '  Nearest primitives (pass --all for the full catalog):\n',
      );
      for (const s of suggestions) {
        process.stdout.write(`    • ${s.symbol}  (score ${s.score}; roles: ${s.roles.join(', ') || '—'})\n`);
      }
    }
  }
  o.writeNotes();
  return 0;
}

/**
 * Resolve one ranked candidate through the code graph (declaration, import,
 * siblings, consumers). A curated row is printed from its
 * `IReuseCuratedResolution` — the SAME record `shrk reuse coverage` judges the
 * entry by — so the declaration shown and the import line printed are the ones
 * the coverage verdict checked.
 */
function enrichResult(
  c: IReuseCandidate,
  api: GraphQueryApi | null,
  res: IReuseCuratedResolution | undefined,
): IReuseResult {
  const r: IReuseResult = {
    symbol: c.symbol,
    source: c.source,
    score: c.score,
    confidence: c.confidence,
    matched: c.matched,
    matchedVia: c.matchedVia,
    nameMatch: c.nameMatch,
    roles: c.primitive?.roles ?? [],
    siblings: [],
    consumers: [],
  };
  const p = c.primitive;
  if (p) {
    if (p.description) r.description = p.description;
    if (p.importPath) {
      r.importPath = p.importPath;
      // The import line is emitted ONLY from a real specifier (the configured
      // importPath), bound the way its module exports the symbol.
      const style = res?.importStyle ?? ReuseImportStyle.Named;
      r.importLine = res?.importLine ?? reuseImportLine(p.symbol, p.importPath, style);
      r.importStyle = style;
      if (style === ReuseImportStyle.Default) r.isDefault = true;
    }
    if (res?.importPathAgrees !== undefined) r.importPathAgrees = res.importPathAgrees;
    if (api) {
      const d = res?.declaration;
      if (d) {
        r.declaredIn = d.path;
        if (d.line) r.declaredLine = d.line;
        const fileNode = api.findFile(d.path);
        if (fileNode) {
          r.siblings = exportedSiblings(api, fileNode.id, d.symbolId);
          // When no public importPath is configured, surface a re-exporting
          // barrel as a hint (we never fabricate a module specifier from a
          // deep file path — that would be a broken/unusable import).
          if (!r.importPath) {
            const barrel = api.importersOf(fileNode.id).find((n) => n.path && INDEX_RE.test(n.path));
            if (barrel?.path) r.reExportedVia = barrel.path;
          }
        }
        setConsumers(r, api, d.symbolId);
        if (res && res.alternates.length > 0) r.alternates = [...res.alternates];
      } else {
        r.notFound = true;
      }
    }
  } else if (c.export) {
    // Uncurated: the package name IS a real, copy-pasteable specifier — the
    // construct is reachable from that package's root entry, which is exactly
    // the file `import … from '<pkg>'` resolves to. Nothing is fabricated.
    const e = c.export;
    r.package = e.package;
    r.importPath = e.package;
    r.declaredIn = e.declaredIn;
    if (e.line) r.declaredLine = e.line;
    r.via = e.via;
    const style = e.isDefault === true ? ReuseImportStyle.Default : ReuseImportStyle.Named;
    if (e.isDefault) r.isDefault = true;
    r.importStyle = style;
    r.importLine = reuseImportLine(c.symbol, e.package, style);
    if (api) {
      const fileNode = api.findFile(e.declaredIn);
      if (fileNode) r.siblings = exportedSiblings(api, fileNode.id, e.symbolId);
      setConsumers(r, api, e.symbolId);
    }
  }
  return r;
}

function exportedSiblings(api: GraphQueryApi, fileNodeId: string, selfId: string): string[] {
  return api
    .symbolsIn(fileNodeId)
    .filter((s) => s.data?.['isExported'] === true && s.label && s.id !== selfId)
    .map((s) => s.label)
    .slice(0, 8);
}

function setConsumers(r: IReuseResult, api: GraphQueryApi, symbolId: string): void {
  const sites = api.referenceSitesOf(symbolId);
  r.consumerTotal = sites.length;
  r.consumers = sites
    .slice(0, 5)
    .map((s) => ({ path: s.node.path ?? s.node.id, ...(s.line ? { line: s.line } : {}) }));
}

function formatUnfollowed(u: IUnfollowedReExport): string {
  return `${u.file} → '${u.specifier}'${u.name === '*' ? '' : ` { ${u.name} }`}`;
}

/** `[uncurated · exported by @demo/ui · exact name match]` / `[curated · via keywords — not its name]`. */
function resultLabel(r: IReuseResult): string {
  if (r.source === ReuseCandidateSource.ExportSurface) {
    return `uncurated · exported by ${r.package ?? '?'} · ${NAME_MATCH_WORDS[r.nameMatch]}`;
  }
  if (r.nameMatch === ReuseNameMatch.None) return `curated · via ${metadataVia(r)} — not its name`;
  return `curated · ${NAME_MATCH_WORDS[r.nameMatch]}`;
}

function matchLine(r: IReuseResult): string {
  const pct = Math.round(r.confidence * 100);
  const matched = r.matched.join(', ') || '—';
  if (r.source === ReuseCandidateSource.Curated && r.nameMatch === ReuseNameMatch.None) {
    // The honesty qualifier: a high percentage earned only through metadata
    // must not read like a name match.
    return `score ${r.score} (${pct}% of intent — via ${metadataVia(r)}; not its name; matched: ${matched})`;
  }
  return `score ${r.score} (${pct}% of intent; matched: ${matched})`;
}

function metadataVia(r: { matchedVia: readonly ReuseMatchSource[] }): string {
  const words = r.matchedVia.filter((v) => v !== ReuseMatchSource.Symbol).map((v) => SOURCE_WORD[v]);
  return words.length > 0 ? words.join(', ') : 'metadata';
}

function suggestionLine(s: IReuseSuggestion): string {
  const pct = Math.round(s.confidence * 100);
  const matched = s.matched.join(', ') || '—';
  if (s.source === ReuseCandidateSource.ExportSurface) {
    return `${s.symbol}  (uncurated · exported by ${s.package ?? '?'} · ${NAME_MATCH_WORDS[s.nameMatch]}; score ${s.score}, ${pct}% of intent; matched: ${matched})`;
  }
  const via = s.nameMatch === ReuseNameMatch.None ? ` — via ${metadataVia(s)}, not its name` : '';
  return `${s.symbol}  (score ${s.score}, ${pct}% of intent; matched: ${matched}${via})`;
}
