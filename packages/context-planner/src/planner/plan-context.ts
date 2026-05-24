import {
  GraphQueryApi,
  GraphStore,
} from '@shrkcrft/graph';
import { BridgeStore, RuleGraphQueryApi } from '@shrkcrft/rule-graph';
import {
  CONTEXT_PACK_SCHEMA,
  type IContextPack,
  type IPathHit,
  type IRankedFile,
  type IRiskHit,
  type IRuleHit,
  type ITemplateHit,
} from '../schema/context-pack.ts';
import { classifyIntent } from '../intent/classify-intent.ts';
import { scoreFiles, type IScoredFile } from '../ranker/score-files.ts';

export interface IPlanContextOptions {
  projectRoot: string;
  /** Free-text task description. */
  task: string;
  /** Hard token budget. Default 8000. */
  budgetTokens?: number;
  /** Pre-selected file hints (will be boosted in ranking). */
  hintedFiles?: readonly string[];
  /** Pre-selected package hints (path prefix `packages/<x>`). */
  hintedPackages?: readonly string[];
  /** Cap on returned files. Default 30 (after budget pruning). */
  maxFiles?: number;
  /**
   * If true and the bridge isn't built, fall back to no rule/path/template
   * info (still produces a useful pack). Default true.
   */
  tolerateMissingBridge?: boolean;
}

/**
 * Produce a deterministic context pack for an AI coding agent.
 *
 * Inputs are graph + bridge + free-text task. Output fits the requested
 * token budget within a small tolerance. The same task on the same repo
 * returns the same pack — a property that lets agents share / replay
 * context.
 */
export function planContext(options: IPlanContextOptions): IContextPack {
  const diagnostics: string[] = [];
  const budgetTokens = options.budgetTokens ?? 8000;
  const maxFiles = options.maxFiles ?? 30;
  const tolerate = options.tolerateMissingBridge ?? true;

  const graphStore = new GraphStore(options.projectRoot);
  if (!graphStore.exists()) {
    diagnostics.push("code-graph store missing — run `shrk graph index`");
    return emptyPack(options.task, budgetTokens, diagnostics);
  }
  const api = GraphQueryApi.fromStore(options.projectRoot);
  const intent = classifyIntent(options.task);

  // 1. Rank.
  const scored = scoreFiles(api, {
    task: options.task,
    intent,
    ...(options.hintedFiles ? { hintedFiles: options.hintedFiles } : {}),
    ...(options.hintedPackages ? { hintedPackages: options.hintedPackages } : {}),
  });

  // 2. Estimate tokens (deterministic, BPE-ish approximation).
  const ranked: IRankedFile[] = scored
    .slice(0, maxFiles * 3) // start with a generous pre-pool before budget pruning
    .map((s) => toRankedFile(s, api));

  // 3. Token-budget pruning. Greedy include in score order until budget filled.
  const accepted: IRankedFile[] = [];
  let used = 0;
  let truncated = false;
  for (const f of ranked) {
    if (accepted.length >= maxFiles) break;
    if (used + f.estimatedTokens > budgetTokens) {
      truncated = true;
      continue;
    }
    accepted.push(f);
    used += f.estimatedTokens;
  }
  if (scored.length > accepted.length) truncated = true;

  // 4. Bridge lookups for the selected file set.
  let rules: IRuleHit[] = [];
  let paths: IPathHit[] = [];
  let templates: ITemplateHit[] = [];
  const bridgeStore = new BridgeStore(options.projectRoot);
  if (bridgeStore.exists()) {
    const bridgeApi = RuleGraphQueryApi.fromStores(options.projectRoot);
    const seenRule = new Set<string>();
    const seenPath = new Set<string>();
    const seenTpl = new Set<string>();
    for (const f of accepted) {
      const view = bridgeApi.forFile(f.path);
      if (!view) continue;
      for (const h of view.rules) {
        if (seenRule.has(h.target.id)) continue;
        seenRule.add(h.target.id);
        rules.push({
          id: h.target.id,
          label: h.target.label,
          severity: (h.edge.data?.['severity'] as string | undefined) ?? undefined,
        });
      }
      for (const h of view.paths) {
        if (seenPath.has(h.target.id)) continue;
        seenPath.add(h.target.id);
        paths.push({ id: h.target.id, label: h.target.label });
      }
      for (const h of view.templates) {
        if (seenTpl.has(h.target.id)) continue;
        seenTpl.add(h.target.id);
        templates.push({ id: h.target.id, label: h.target.label });
      }
    }
  } else if (tolerate) {
    diagnostics.push("bridge store missing — rules/paths/templates omitted (run `shrk rule-graph index`)");
  } else {
    diagnostics.push("bridge store missing");
  }

  // 5. Likely tests for the selected file set (importers + co-located).
  const tests = collectTests(api, accepted);

  // 6. Surface risks: cross-package edges, public-API touches, cycles in the selected set.
  const risks = collectRisks(api, accepted);

  // 7. Do-not-touch zones — generated files, vendored, dist, lock.
  const doNotTouch = computeDoNotTouch(accepted);

  return {
    schema: CONTEXT_PACK_SCHEMA,
    intent,
    task: options.task,
    files: accepted,
    rules,
    paths,
    templates,
    tests,
    risks,
    doNotTouch,
    budget: { requested: budgetTokens, used, truncated },
    diagnostics,
  };
}

function toRankedFile(s: IScoredFile, api: GraphQueryApi): IRankedFile {
  const node = s.node;
  // Token estimate: 1 token ≈ 4 chars, plus a small fixed overhead.
  const sizeBytes = (node.data?.['sizeBytes'] as number | undefined) ?? 2000;
  const estimatedTokens = Math.max(40, Math.ceil(sizeBytes / 4));
  // Bound the score to [0, 1].
  const bounded = Math.max(0, Math.min(1, s.score / 3));
  void api;
  return {
    path: node.path!,
    nodeId: node.id,
    score: Math.round(bounded * 100) / 100,
    estimatedTokens,
    reasons: s.reasons,
  };
}

function collectTests(api: GraphQueryApi, files: readonly IRankedFile[]): readonly string[] {
  const out = new Set<string>();
  for (const f of files) {
    // Co-located: `__tests__/<name>.test.ts` or `<base>.test.ts`.
    const candidates = guessTestPaths(f.path);
    for (const c of candidates) {
      const t = api.findFile(c);
      if (t) out.add(t.path!);
    }
    // Importer tests: any file tagged `test` that imports this one.
    for (const importer of api.importersOf(f.nodeId)) {
      if (!(importer.tags ?? []).includes('test')) continue;
      if (importer.path) out.add(importer.path);
    }
  }
  return [...out].sort().slice(0, 50);
}

function guessTestPaths(path: string): readonly string[] {
  // `packages/foo/src/bar.ts` → check `__tests__/bar.test.ts`, `bar.test.ts`, etc.
  const out: string[] = [];
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '.';
  const base = (lastSlash >= 0 ? path.slice(lastSlash + 1) : path).replace(/\.[tj]sx?$/, '');
  for (const ext of ['.test.ts', '.test.tsx', '.spec.ts']) {
    out.push(`${dir}/__tests__/${base}${ext}`);
    out.push(`${dir}/${base}${ext}`);
  }
  return out;
}

function collectRisks(api: GraphQueryApi, files: readonly IRankedFile[]): readonly IRiskHit[] {
  const out: IRiskHit[] = [];
  let publicApiCount = 0;
  let crossPackageCount = 0;
  for (const f of files) {
    if (/\/index\.ts$/.test(f.path) || /^index\.ts$/.test(f.path) || f.path.endsWith('.d.ts')) {
      publicApiCount += 1;
    }
    for (const importer of api.importersOf(f.nodeId)) {
      const pkgImporter = importer.path?.split('/').slice(0, 2).join('/');
      const pkgFile = f.path.split('/').slice(0, 2).join('/');
      if (pkgImporter && pkgFile && pkgImporter !== pkgFile) crossPackageCount += 1;
    }
  }
  if (publicApiCount > 0) {
    out.push({
      kind: 'public-api',
      label: `${publicApiCount} selected file(s) are public-API entrypoints — changes ripple to consumers`,
    });
  }
  if (crossPackageCount >= 5) {
    out.push({
      kind: 'cross-package',
      label: `${crossPackageCount} cross-package importers of selected files`,
    });
  }
  return out;
}

function computeDoNotTouch(files: readonly IRankedFile[]): readonly string[] {
  const out: string[] = [];
  for (const f of files) {
    if (/\bdist\b|\bbuild\b|\.generated\.|\.lock$/.test(f.path)) {
      out.push(f.path);
    }
  }
  return out;
}

function emptyPack(task: string, budget: number, diagnostics: readonly string[]): IContextPack {
  return {
    schema: CONTEXT_PACK_SCHEMA,
    intent: classifyIntent(task),
    task,
    files: [],
    rules: [],
    paths: [],
    templates: [],
    tests: [],
    risks: [],
    doNotTouch: [],
    budget: { requested: budget, used: 0, truncated: false },
    diagnostics,
  };
}

