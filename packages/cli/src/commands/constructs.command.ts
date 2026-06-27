import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AdoptionCheckpointStatus,
  buildConstructAdoptionDiff,
  buildConstructAdoptionPlan,
  buildSearchIndex,
  ConstructAdoptionCategory,
  evaluateAdoptionCheckpoint,
  hashDiffBody,
  inferConstructs,
  InferredConstructConfidence,
  inspectSharkcraft,
  loadConstructs,
  loadPlaybooks,
  readAdoptionCheckpoint,
  readConstructAdoptionStatus,
  recordAdoptionCheckpoint,
  renderConstructAdoptionDiff,
  renderConstructAdoptionMarkdown,
  renderConstructDraftsModule,
  searchIndex,
  SearchKind,
  traceConstruct,
  writeConstructAdoption,
  type ConstructAdoptionDiffFormat,
  type ConstructAdoptionIncludes,
  type IConstruct,
} from '@shrkcrft/inspector';
import { GraphQueryApi, GraphStore } from '@shrkcrft/graph';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

async function loadAll(args: ParsedArgs): Promise<{
  constructs: readonly IConstruct[];
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>;
}> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const constructs = await loadConstructs(inspection);
  return { constructs, inspection };
}

/**
 * Graph-derived verification of a construct's HAND-DECLARED inventory.
 *
 * `traceConstruct` echoes the author-typed `files` / `publicApi` / `tokens`
 * arrays verbatim — so a glob in `files` is never expanded and a file's extra
 * symbols are never surfaced (the "lists 4 of 10 tokens" / "Files (0) +
 * unresolved glob" complaints). This enriches the declared inventory against
 * the code-intelligence graph WITHOUT mutating the declared fields (so
 * `constructs impact`'s file-count risk heuristic stays consistent): it expands
 * file globs, flags globs that match nothing, and lists real symbols defined in
 * the construct's files that the construct did not declare.
 */
interface ITraceGraphEnrichment {
  /** Whether the code graph was available. */
  graphState: 'fresh' | 'missing';
  /** Declared file globs/paths resolved to real graph file paths. */
  resolvedFiles: readonly string[];
  /** Declared `files` glob entries that matched zero files in the graph. */
  unresolvedGlobs: readonly string[];
  /** Symbols defined in the resolved files but NOT declared on the construct. */
  undeclaredSymbols: readonly string[];
}

const GLOB_MAGIC = /[*?[\]{}]/;

function globToRegExp(glob: string): RegExp {
  // Compile a minimal file glob (`**`, `*`, `?`) to an anchored RegExp. Mark the
  // wildcards with control-char placeholders BEFORE regex-escaping the rest, so
  // the escape pass and the wildcard expansion can never clobber each other (an
  // earlier space-sentinel version was corrupted by editor whitespace handling).
  const DSTAR_SLASH = '\u0000';
  const DSTAR = '\u0001';
  const STAR = '\u0002';
  const QMARK = '\u0003';
  const marked = glob
    .replace(/\*\*\//g, DSTAR_SLASH)
    .replace(/\*\*/g, DSTAR)
    .replace(/\*/g, STAR)
    .replace(/\?/g, QMARK);
  const pattern = marked
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(DSTAR_SLASH, '(?:.*/)?')
    .replaceAll(DSTAR, '.*')
    .replaceAll(STAR, '[^/]*')
    .replaceAll(QMARK, '[^/]');
  return new RegExp(`^${pattern}$`);
}

function enrichTraceWithGraph(
  declaredFiles: readonly string[],
  declaredNames: ReadonlySet<string>,
  cwd: string,
): ITraceGraphEnrichment {
  if (!new GraphStore(cwd).exists()) {
    return { graphState: 'missing', resolvedFiles: [], unresolvedGlobs: [], undeclaredSymbols: [] };
  }
  const api = GraphQueryApi.fromStore(cwd);
  const allPaths = [...api.allFiles()].map((n) => n.path).filter((p): p is string => !!p);
  const resolved = new Set<string>();
  const unresolvedGlobs: string[] = [];
  for (const entry of declaredFiles) {
    if (GLOB_MAGIC.test(entry)) {
      const re = globToRegExp(entry);
      const matches = allPaths.filter((p) => re.test(p));
      if (matches.length === 0) unresolvedGlobs.push(entry);
      for (const m of matches) resolved.add(m);
    } else if (api.findFile(entry)) {
      resolved.add(entry);
    }
  }
  const undeclared = new Set<string>();
  for (const path of resolved) {
    for (const sym of api.symbolsIn(`file:${path}`)) {
      if (sym.label && !declaredNames.has(sym.label)) undeclared.add(sym.label);
    }
  }
  return {
    graphState: 'fresh',
    resolvedFiles: [...resolved].sort(),
    unresolvedGlobs,
    undeclaredSymbols: [...undeclared].sort(),
  };
}

export const constructsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered constructs.',
  usage: 'shrk constructs list [--type <type>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const { constructs } = await loadAll(args);
    const type = flagString(args, 'type');
    const list = type ? constructs.filter((c) => c.type === type) : constructs;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(list) + '\n');
      return 0;
    }
    process.stdout.write(header(`Constructs (${list.length})`));
    if (list.length === 0) process.stdout.write('  (none)\n');
    for (const c of list) {
      process.stdout.write(
        `  ${c.id.padEnd(40)} ${c.type.padEnd(12)} ${c.title}\n`,
      );
    }
    return 0;
  },
};

export const constructsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show construct details.',
  usage: 'shrk constructs get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs get <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(c) + '\n');
      return 0;
    }
    process.stdout.write(header(`Construct: ${c.id}`));
    process.stdout.write(`  type:        ${c.type}\n`);
    process.stdout.write(`  title:       ${c.title}\n`);
    if (c.description) process.stdout.write(`  description: ${c.description}\n`);
    if (c.tags?.length) process.stdout.write(`  tags:        ${c.tags.join(', ')}\n`);
    process.stdout.write(`  source:      ${c.source}${c.packageName ? ' (' + c.packageName + ')' : ''}\n`);
    if (c.files?.length) {
      process.stdout.write(`  files (${c.files.length}):\n`);
      for (const f of c.files.slice(0, 10)) process.stdout.write(`    - ${f}\n`);
    }
    if (c.publicApi?.length) {
      process.stdout.write(`  publicApi:\n`);
      for (const a of c.publicApi) process.stdout.write(`    - ${a}\n`);
    }
    if (c.events?.length) {
      process.stdout.write(`  events:      ${c.events.join(', ')}\n`);
    }
    if (c.tokens?.length) {
      process.stdout.write(`  tokens:      ${c.tokens.join(', ')}\n`);
    }
    if (c.commands?.length) {
      process.stdout.write(`  commands:\n`);
      for (const x of c.commands) process.stdout.write(`    $ ${x}\n`);
    }
    if (c.facets) {
      for (const [kind, list] of Object.entries(c.facets)) {
        process.stdout.write(`  facet ${kind}:\n`);
        for (const f of list) process.stdout.write(`    - ${f.value}${f.description ? ' — ' + f.description : ''}\n`);
      }
    }
    return 0;
  },
};

export const constructsTraceCommand: ICommandHandler = {
  name: 'trace',
  description:
    'Trace a construct\'s declared files / publicApi / events / tokens, verified against the code graph (expands file globs, flags globs that match nothing, lists undeclared symbols defined in those files). --deep adds related / test pointers.',
  usage: 'shrk constructs trace <id> [--deep] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs trace <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const trace = traceConstruct(c);
    const deep = flagBool(args, 'deep');
    // Verify the hand-declared inventory against the code graph (additive — does
    // not change the declared files/tokens the other subverbs rely on).
    const declaredNames = new Set<string>([...trace.publicApi, ...trace.tokens, ...trace.events]);
    const graph = enrichTraceWithGraph(trace.files, declaredNames, resolveCwd(args));
    const relatedAll = [
      ...(c.relatedKnowledge ?? []),
      ...(c.relatedRules ?? []),
      ...(c.relatedTemplates ?? []),
      ...(c.relatedPipelines ?? []),
      ...(c.relatedPathConventions ?? []),
    ];
    const deepBlock = deep
      ? {
          related: relatedAll,
          tags: c.tags ?? [],
          registryHints: c.tags?.filter((t) => /(registry|barrel)/i.test(t)) ?? [],
        }
      : undefined;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ ...trace, graph, ...(deepBlock ? { deep: deepBlock } : {}) }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Trace: ${id}`));
    process.stdout.write(`Files (${trace.files.length}):\n`);
    for (const f of trace.files) process.stdout.write(`  • ${f}\n`);
    if (trace.publicApi.length > 0) {
      process.stdout.write(`Public API:\n`);
      for (const a of trace.publicApi) process.stdout.write(`  → ${a}\n`);
    }
    if (trace.events.length > 0) {
      process.stdout.write(`Events: ${trace.events.join(', ')}\n`);
    }
    if (trace.tokens.length > 0) {
      process.stdout.write(`Tokens: ${trace.tokens.join(', ')}\n`);
    }
    if (trace.warnings.length > 0) {
      process.stdout.write('Warnings:\n');
      for (const w of trace.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    // Graph-verified view: this is the part that makes the declared inventory
    // trustworthy rather than a hand-typed partial map.
    if (graph.graphState === 'missing') {
      process.stdout.write(
        '\n(declared inventory only — run `shrk graph index` for a graph-verified inventory)\n',
      );
    } else {
      if (graph.unresolvedGlobs.length > 0) {
        process.stdout.write('Unresolved file globs (matched 0 files in the graph):\n');
        for (const g of graph.unresolvedGlobs) process.stdout.write(`  ! ${g}\n`);
      }
      if (graph.undeclaredSymbols.length > 0) {
        process.stdout.write(
          `Graph found ${graph.undeclaredSymbols.length} symbol(s) defined in these files but NOT declared on the construct:\n`,
        );
        for (const s of graph.undeclaredSymbols.slice(0, 30)) process.stdout.write(`  + ${s}\n`);
        if (graph.undeclaredSymbols.length > 30) {
          process.stdout.write(`  … (${graph.undeclaredSymbols.length - 30} more)\n`);
        }
      }
    }
    if (deepBlock) {
      process.stdout.write('\nDeep:\n');
      if (deepBlock.related.length > 0) process.stdout.write(`  related: ${deepBlock.related.join(', ')}\n`);
      if (deepBlock.tags.length > 0) process.stdout.write(`  tags: ${deepBlock.tags.join(', ')}\n`);
      if (deepBlock.registryHints.length > 0)
        process.stdout.write(`  registry hints: ${deepBlock.registryHints.join(', ')}\n`);
    }
    return 0;
  },
};

export const constructsImpactCommand: ICommandHandler = {
  name: 'impact',
  description:
    'Construct impact view: files + publicApi + events + tokens + registries + tests + verification commands + risk level + suggested next commands.',
  usage: 'shrk constructs impact <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs impact <id>\n');
      return 2;
    }
    const { constructs, inspection } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const trace = traceConstruct(c);
    /**
     * Registry touch-points are not inferred — pack-contributed
     * touch-point hints can be added in the future via the convention
     * registry.
     */
    const registryTouchPoints: string[] = [];
    const verificationCommands: string[] = [
      'shrk check boundaries --changed-only',
      'shrk doctor',
      'bun x tsc -p tsconfig.base.json --noEmit',
    ];
    const verCfg = inspection.config?.verificationCommands ?? [];
    for (const v of verCfg.slice(0, 3)) verificationCommands.push(v.command);
    const fileCount = trace.files.length;
    const risk: 'low' | 'medium' | 'high' = fileCount > 12 ? 'high' : fileCount > 4 ? 'medium' : 'low';
    const humanReview = risk !== 'low';
    const report = {
      schema: 'sharkcraft.construct-impact/v1',
      id,
      files: trace.files,
      publicApi: trace.publicApi,
      events: trace.events,
      tokens: trace.tokens,
      registryTouchPoints,
      tests: [] as string[],
      verificationCommands,
      risk,
      humanReviewRequired: humanReview,
      suggestedNextCommands: [
        `shrk constructs trace ${id} --deep`,
        `shrk impact <file>`,
        `shrk check boundaries --changed-only`,
      ],
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`Impact: ${id}`));
    process.stdout.write(`Files (${report.files.length}):\n`);
    for (const f of report.files) process.stdout.write(`  • ${f}\n`);
    if (report.registryTouchPoints.length > 0) {
      process.stdout.write('Registry touch points:\n');
      for (const r of report.registryTouchPoints) process.stdout.write(`  → ${r}\n`);
    }
    process.stdout.write(`risk: ${report.risk}; human review: ${report.humanReviewRequired ? 'yes' : 'no'}\n`);
    process.stdout.write('Verification:\n');
    for (const v of report.verificationCommands) process.stdout.write(`  $ ${v}\n`);
    return 0;
  },
};

export const constructsRelatedCommand: ICommandHandler = {
  name: 'related',
  description: 'Show related constructs (declared via `related` field).',
  usage: 'shrk constructs related <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs related <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const related = [
      ...(c.relatedKnowledge ?? []).map((id) => ({ kind: 'knowledge', id })),
      ...(c.relatedRules ?? []).map((id) => ({ kind: 'rule', id })),
      ...(c.relatedTemplates ?? []).map((id) => ({ kind: 'template', id })),
      ...(c.relatedPipelines ?? []).map((id) => ({ kind: 'pipeline', id })),
      ...(c.relatedPathConventions ?? []).map((id) => ({ kind: 'path', id })),
    ];
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ id, related }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Related: ${id}`));
    if (related.length === 0) {
      process.stdout.write('  (none)\n');
      return 0;
    }
    for (const r of related) process.stdout.write(`  • [${r.kind}] ${r.id}\n`);
    return 0;
  },
};

export const constructsFilesCommand: ICommandHandler = {
  name: 'files',
  description: 'Just the files (one per line) belonging to a construct. Read-only.',
  usage: 'shrk constructs files <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs files <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const trace = traceConstruct(c);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ id, files: trace.files }) + '\n');
      return 0;
    }
    for (const f of trace.files) process.stdout.write(`${f}\n`);
    return 0;
  },
};

export const constructsApiCommand: ICommandHandler = {
  name: 'api',
  description: 'Show public-API entries for a construct. --public-only emits the raw list with no header.',
  usage: 'shrk constructs api <id> [--public-only] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs api <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const publicApi = c.publicApi ?? [];
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ id, publicApi }) + '\n');
      return 0;
    }
    if (flagBool(args, 'public-only')) {
      for (const a of publicApi) process.stdout.write(`${a}\n`);
      return 0;
    }
    process.stdout.write(header(`Public API: ${id}`));
    if (publicApi.length === 0) {
      process.stdout.write('  (none declared)\n');
      return 0;
    }
    for (const a of publicApi) process.stdout.write(`  → ${a}\n`);
    return 0;
  },
};

export const constructsEventsCommand: ICommandHandler = {
  name: 'events',
  description: 'List events emitted/consumed by constructs.',
  usage: 'shrk constructs events [<id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    const { constructs } = await loadAll(args);
    const filtered = id ? constructs.filter((c) => c.id === id) : constructs;
    const rows = filtered.flatMap((c) => (c.events ?? []).map((e) => ({ constructId: c.id, event: e })));
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rows) + '\n');
      return 0;
    }
    process.stdout.write(header(`Events (${rows.length})`));
    for (const r of rows) process.stdout.write(`  ${r.constructId.padEnd(30)} ${r.event}\n`);
    return 0;
  },
};

export const constructsTokensCommand: ICommandHandler = {
  name: 'tokens',
  description: 'List tokens contributed by constructs.',
  usage: 'shrk constructs tokens [<id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    const { constructs } = await loadAll(args);
    const filtered = id ? constructs.filter((c) => c.id === id) : constructs;
    const rows = filtered.flatMap((c) => (c.tokens ?? []).map((t) => ({ constructId: c.id, token: t })));
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rows) + '\n');
      return 0;
    }
    process.stdout.write(header(`Tokens (${rows.length})`));
    for (const r of rows) process.stdout.write(`  ${r.constructId.padEnd(30)} ${r.token}\n`);
    return 0;
  },
};

export const constructsFacetsCommand: ICommandHandler = {
  name: 'facets',
  description: 'List facets of a construct.',
  usage: 'shrk constructs facets <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk constructs facets <id>\n');
      return 2;
    }
    const { constructs } = await loadAll(args);
    const c = constructs.find((x) => x.id === id);
    if (!c) {
      process.stderr.write(`No construct "${id}"\n`);
      return 1;
    }
    const facets = c.facets ?? {};
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ id, facets }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Facets: ${id}`));
    for (const [kind, list] of Object.entries(facets)) {
      process.stdout.write(`${kind}:\n`);
      for (const f of list) process.stdout.write(`  - ${f.value}${f.description ? ' — ' + f.description : ''}\n`);
    }
    return 0;
  },
};

export const constructsSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search constructs and facets.',
  usage: 'shrk constructs search <query> [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional.join(' ').trim();
    if (!query) {
      process.stderr.write('Usage: shrk constructs search <query>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    await loadConstructs(inspection);
    await loadPlaybooks(inspection);
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, {
      query,
      kinds: [SearchKind.Construct, SearchKind.ConstructFacet],
      limit: flagNumber(args, 'limit') ?? 20,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result.hits) + '\n');
      return 0;
    }
    process.stdout.write(header(`Constructs matching "${query}"`));
    for (const h of result.hits) {
      process.stdout.write(`  ${h.score.toString().padStart(6)}  ${h.document.id}  — ${h.document.title}\n`);
    }
    return 0;
  },
};

export const constructsInferCommand: ICommandHandler = {
  name: 'infer',
  description: 'Infer construct candidates from path conventions, filenames, and the import graph.',
  usage:
    'shrk constructs infer [--type X] [--confidence high|medium|low] [--limit N] [--json] [--write-drafts]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    await loadConstructs(inspection);
    const minConfidenceRaw = flagString(args, 'confidence');
    const valid = new Set(Object.values(InferredConstructConfidence) as string[]);
    if (minConfidenceRaw && !valid.has(minConfidenceRaw)) {
      process.stderr.write(`Unknown --confidence "${minConfidenceRaw}"\n`);
      return 2;
    }
    const result = await inferConstructs(inspection, {
      ...(flagString(args, 'type') ? { type: flagString(args, 'type')! } : {}),
      ...(minConfidenceRaw
        ? { minConfidence: minConfidenceRaw as InferredConstructConfidence }
        : {}),
      ...(flagNumber(args, 'limit') ? { limit: flagNumber(args, 'limit')! } : {}),
    });
    if (flagBool(args, 'write-drafts')) {
      const dir = inspection.sharkcraftDir
        ? nodePath.join(inspection.sharkcraftDir, 'construct-drafts')
        : nodePath.join(cwd, 'sharkcraft', 'construct-drafts');
      mkdirSync(dir, { recursive: true });
      const file = nodePath.join(dir, 'constructs.draft.ts');
      writeFileSync(file, renderConstructDraftsModule(result), 'utf8');
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ ...result, draftFile: file }) + '\n');
      } else {
        process.stdout.write(`Wrote draft: ${file}\n`);
        process.stdout.write(`Candidates: ${result.candidates.length}\n`);
      }
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header(`Construct candidates (${result.candidates.length})`));
    for (const c of result.candidates) {
      process.stdout.write(
        `  [${c.confidence.padEnd(6)}] ${c.id.padEnd(40)} ${c.type.padEnd(12)} ${c.title}\n`,
      );
      if (c.evidence.length > 0)
        process.stdout.write(`         evidence: ${c.evidence.slice(0, 2).join('; ')}\n`);
      process.stdout.write(
        `         files: ${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? '…' : ''}\n`,
      );
    }
    if (result.warnings.length > 0) {
      process.stdout.write('\nWarnings:\n');
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    return 0;
  },
};

export const constructsAdoptCommand: ICommandHandler = {
  name: 'adopt',
  description:
    'Build a construct-adoption plan from inferred drafts; classify safe / manual / low-confidence / already-covered / conflict. Never modifies constructs.ts.',
  usage:
    'shrk constructs adopt [--dry-run|--write-patch] [--confidence high|medium|low] [--include facets,publicApi,events,tokens] [--json]\n  shrk constructs adopt status [--json]\n  shrk constructs adopt review [--json]\n  shrk constructs adopt diff [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    await loadConstructs(inspection);
    const sub = args.positional[0];
    if (sub === 'diff') {
      const formatRaw = (flagString(args, 'format') ?? 'text') as ConstructAdoptionDiffFormat;
      const valid = new Set<ConstructAdoptionDiffFormat>(['text', 'markdown', 'html', 'json']);
      if (!valid.has(formatRaw)) {
        process.stderr.write(`Unknown --format "${formatRaw}". Use text|markdown|html|json.\n`);
        return 2;
      }
      const diff = await buildConstructAdoptionDiff(inspection);
      const rendered = renderConstructAdoptionDiff(diff, formatRaw);
      process.stdout.write(rendered);
      if (flagBool(args, 'record-checkpoint')) {
        // Use the JSON form as the canonical diff hash so format choice
        // doesn't change the checkpoint identity.
        const canonical = renderConstructAdoptionDiff(diff, 'json');
        const diffHash = hashDiffBody(canonical);
        const targets = diff.constructsFile
          ? [nodePath.relative(cwd, diff.constructsFile).split(nodePath.sep).join('/')]
          : [];
        const draftsRel = diff.constructsFile
          ? [
              nodePath
                .relative(
                  cwd,
                  nodePath.join(nodePath.dirname(diff.constructsFile), 'construct-drafts/constructs.draft.ts'),
                )
                .split(nodePath.sep)
                .join('/'),
            ]
          : [];
        const checkpoint = recordAdoptionCheckpoint({
          projectRoot: cwd,
          kind: 'construct',
          command: 'shrk constructs adopt diff --record-checkpoint',
          diffHash,
          targets,
          drafts: draftsRel,
        });
        process.stdout.write(
          `\nRecorded checkpoint at ${nodePath.relative(cwd, nodePath.join(cwd, 'sharkcraft/construct-drafts/adoption/adoption-checkpoint.json'))} (diff hash ${checkpoint.diffHash.slice(0, 12)}…)\n`,
        );
      }
      return 0;
    }
    if (sub === 'status') {
      const status = readConstructAdoptionStatus(inspection);
      const checkpointRead = readAdoptionCheckpoint(cwd, 'construct');
      const maxAgeDaysRaw = flagNumber(args, 'max-age-days');
      // If a checkpoint exists, evaluate its freshness vs the current diff.
      let checkpointEval = null as null | ReturnType<typeof evaluateAdoptionCheckpoint>;
      if (checkpointRead.checkpoint) {
        const diff = await buildConstructAdoptionDiff(inspection);
        const canonical = renderConstructAdoptionDiff(diff, 'json');
        checkpointEval = evaluateAdoptionCheckpoint(
          cwd,
          checkpointRead.checkpoint,
          hashDiffBody(canonical),
          maxAgeDaysRaw !== undefined ? { maxAgeDays: maxAgeDaysRaw } : {},
        );
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({
            ...status,
            checkpoint: checkpointRead.checkpoint,
            checkpointStatus: checkpointEval?.status ?? AdoptionCheckpointStatus.Missing,
            checkpointReasons: checkpointEval?.reasons ?? ['no checkpoint'],
          }) + '\n',
        );
        return 0;
      }
      process.stdout.write(header('Construct adoption status'));
      if (!status.exists) {
        process.stdout.write('  (no adoption plan yet — run `shrk constructs adopt --write-patch`)\n');
        return 0;
      }
      process.stdout.write(`  plan: ${status.paths?.planFile}\n`);
      if (status.summary) {
        process.stdout.write(
          `  total=${status.summary.total} safe=${status.summary.safeToAdopt} review=${status.summary.manualReview} low=${status.summary.lowConfidence} covered=${status.summary.alreadyCovered} conflict=${status.summary.conflict}\n`,
        );
      }
      if (status.planAgeMs !== null)
        process.stdout.write(`  ageDays=${Math.round(status.planAgeMs / 86_400_000)}\n`);
      if (checkpointRead.checkpoint && checkpointEval) {
        process.stdout.write(`  checkpoint: ${checkpointEval.status}\n`);
        for (const r of checkpointEval.reasons) process.stdout.write(`    - ${r}\n`);
      } else {
        process.stdout.write('  checkpoint: missing (use `shrk constructs adopt diff --record-checkpoint`)\n');
      }
      return 0;
    }
    if (sub === 'review') {
      const plan = await buildConstructAdoptionPlan(inspection);
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(plan) + '\n');
        return 0;
      }
      process.stdout.write(renderConstructAdoptionMarkdown(plan));
      return 0;
    }

    const confidenceFlag = flagString(args, 'confidence');
    const valid = new Set(Object.values(InferredConstructConfidence) as string[]);
    if (confidenceFlag && !valid.has(confidenceFlag)) {
      process.stderr.write(`Unknown --confidence "${confidenceFlag}".\n`);
      return 2;
    }
    const includeFlag = flagString(args, 'include');
    const includeRaw = (includeFlag ? includeFlag.split(',') : []) as ConstructAdoptionIncludes[];
    const validInclude = new Set<ConstructAdoptionIncludes>(['facets', 'publicApi', 'events', 'tokens']);
    const include = includeRaw.filter((x) => validInclude.has(x));

    const plan = await buildConstructAdoptionPlan(inspection, {
      ...(confidenceFlag ? { minConfidence: confidenceFlag as InferredConstructConfidence } : {}),
      ...(include.length > 0 ? { include } : {}),
    });

    if (flagBool(args, 'write-patch')) {
      const result = writeConstructAdoption(inspection, plan);
      // Auto-record adoption checkpoint so subsequent `adopt status` calls
      // can tell whether anything drifted.
      const diff = await buildConstructAdoptionDiff(inspection);
      const canonical = renderConstructAdoptionDiff(diff, 'json');
      const targets = diff.constructsFile
        ? [nodePath.relative(cwd, diff.constructsFile).split(nodePath.sep).join('/')]
        : [];
      const draftsRel = diff.constructsFile
        ? [
            nodePath
              .relative(
                cwd,
                nodePath.join(nodePath.dirname(diff.constructsFile), 'construct-drafts/constructs.draft.ts'),
              )
              .split(nodePath.sep)
              .join('/'),
          ]
        : [];
      recordAdoptionCheckpoint({
        projectRoot: cwd,
        kind: 'construct',
        command: 'shrk constructs adopt --write-patch',
        diffHash: hashDiffBody(canonical),
        targets,
        drafts: draftsRel,
      });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ ...plan, written: result.files }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Construct adoption (${plan.summary.total})`));
      for (const f of result.files) process.stdout.write(`  + ${f}\n`);
      process.stdout.write(
        `\nsafe=${plan.summary.safeToAdopt} review=${plan.summary.manualReview} low=${plan.summary.lowConfidence} covered=${plan.summary.alreadyCovered} conflict=${plan.summary.conflict}\n`,
      );
      return 0;
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header(`Construct adoption (dry-run, ${plan.summary.total})`));
    for (const e of plan.entries) {
      process.stdout.write(
        `  [${e.category.padEnd(16)}] ${e.id.padEnd(36)} ${e.confidence.padEnd(6)} ${e.title}\n`,
      );
      for (const r of e.reasons.slice(0, 2)) process.stdout.write(`         ${r}\n`);
    }
    if (plan.warnings.length > 0) {
      process.stdout.write('\nWarnings:\n');
      for (const w of plan.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    process.stdout.write('\nPass --write-patch to write the adoption pseudo-patch.\n');
    return 0;
  },
};

void ConstructAdoptionCategory;
void asJson;
