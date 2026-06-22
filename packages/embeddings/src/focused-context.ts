import {
  extractDeclarations,
  type IDeclarationBlock,
  type DeclarationKind,
} from './declaration-extractor.ts';
import { SemanticIndex, type ISemanticHit } from './semantic-index.ts';
import { pruneDeletedHits } from './prune-deleted-hits.ts';

export interface IFocusedFile {
  path: string;
  fileSimilarity: number;
  /** Leading JSDoc / `//` comment, if any. */
  summary: string | null;
  blocks: Array<{
    name: string;
    kind: DeclarationKind;
    startLine: number;
    similarity: number;
    snippet: string;
  }>;
}

export interface IFocusedDocHit {
  path: string;
  line: number;
  similarity: number;
  snippet: string;
}

export interface IFocusedContext {
  task: string;
  model: string;
  files: IFocusedFile[];
  docHits: IFocusedDocHit[];
  rules: Array<{ id: string; title: string; summary: string }>;
  verificationCommands: readonly string[];
  approxTokens: number;
}

export interface IFocusedContextOptions {
  cwd: string;
  task: string;
  /** Pre-loaded semantic index. We never load the model here ourselves. */
  index: SemanticIndex;
  /** How many top files to extract declarations from. Default 12. */
  fileCandidates?: number;
  /** Hard cap on total blocks across all files. Default 10. */
  maxBlocks?: number;
  /** Hard cap on blocks per single file. Default 3. */
  maxBlocksPerFile?: number;
  /** Doc-hit candidates to pull from. Default 8. */
  docCandidates?: number;
  /** Final doc hits to keep. Default 3. */
  maxDocHits?: number;
  /** Inputs from the existing packet (rules + verification). Optional. */
  rules?: ReadonlyArray<{ id: string; title: string; summary?: string; content?: string }>;
  verificationCommands?: readonly string[];
  /** Pre-collected doc hits from keyword-grep (used as the candidate pool). */
  docCandidatePool?: ReadonlyArray<{ path: string; line: number; snippet: string }>;
  /**
   * When set, the semantic file search results are post-filtered to
   * only include paths in this allowlist. Used by `--since <git-ref>`
   * so the bundle focuses on files touched in the diff (plus their
   * neighbors, which the caller adds before passing the allowlist).
   */
  pathAllowlist?: readonly string[];
}

/**
 * Build a small, dense, task-specific context bundle using *multiple*
 * BGE embedding cycles. The free tiny model does more work so the
 * expensive generative model receives less noise.
 *
 * Pipeline:
 *   1. Embed the task (one BGE call).
 *   2. Semantic file search → top-N candidate files.
 *   3. For each candidate file, extract top-level declaration blocks
 *      (interface bodies, type aliases, signatures).
 *   4. Embed each declaration's snippet (many BGE calls — free).
 *   5. Re-rank blocks by cosine vs the task, keep the top `maxBlocks`
 *      with a per-file cap.
 *   6. Re-rank doc-grep candidates by cosine vs the task.
 *   7. Take the top-3 packet rules and dedupe.
 *
 * Output is JSON-serializable and intentionally compact (~2 KB typical).
 */
export async function buildFocusedContext(opts: IFocusedContextOptions): Promise<IFocusedContext> {
  const fileCandidates = opts.fileCandidates ?? 12;
  const maxBlocks = opts.maxBlocks ?? 10;
  const maxBlocksPerFile = opts.maxBlocksPerFile ?? 3;
  const maxDocHits = opts.maxDocHits ?? 3;

  const taskVec = await opts.index.embed(opts.task);
  // When --since is in play we ask for a wider initial pool so the
  // allowlist post-filter has more material to work with.
  const initialPool = opts.pathAllowlist ? fileCandidates * 8 : fileCandidates;
  // Drop deleted-file hits BEFORE extracting declarations — a stale index must
  // not surface a file that no longer exists.
  let fileHits = pruneDeletedHits(await opts.index.searchFiles(opts.task, initialPool), opts.cwd).hits;
  if (opts.pathAllowlist) {
    const allow = new Set(opts.pathAllowlist);
    fileHits = fileHits.filter((h) => allow.has(h.path)).slice(0, fileCandidates);
  }

  // Step 1: pull declaration blocks per candidate file. Skip non-code files.
  const perFile: IFocusedFile[] = [];
  for (const hit of fileHits) {
    if (!/\.(ts|tsx|js|jsx)$/.test(hit.path)) {
      perFile.push({
        path: hit.path,
        fileSimilarity: hit.score,
        summary: null,
        blocks: [],
      });
      continue;
    }
    const blocks = extractDeclarations(opts.cwd, hit.path);
    perFile.push({
      path: hit.path,
      fileSimilarity: hit.score,
      summary: null,
      blocks: blocks.map((b) => ({
        name: b.name,
        kind: b.kind,
        startLine: b.startLine,
        similarity: 0, // filled in below
        snippet: b.snippet,
      })),
    });
  }

  // Step 2: re-embed every block we extracted, rank by cosine vs task.
  // This is the "tiny AI does more cycles" win — many cheap calls.
  for (const file of perFile) {
    for (const block of file.blocks) {
      const vec = await opts.index.embed(prepareBlockForEmbedding(file.path, block.name, block.snippet));
      let dot = 0;
      for (let i = 0; i < vec.length; i += 1) dot += vec[i]! * taskVec[i]!;
      block.similarity = dot;
    }
  }

  // Step 3: flatten and pick the top `maxBlocks` blocks across all files,
  // enforcing `maxBlocksPerFile` so one giant file can't crowd out others.
  const allBlocks = perFile.flatMap((file) =>
    file.blocks.map((b) => ({ file, block: b })),
  );
  allBlocks.sort((a, b) => b.block.similarity - a.block.similarity);
  const perFileCount = new Map<string, number>();
  const keptBlocks = new Set<IFocusedFile['blocks'][number]>();
  for (const { file, block } of allBlocks) {
    if (keptBlocks.size >= maxBlocks) break;
    const used = perFileCount.get(file.path) ?? 0;
    if (used >= maxBlocksPerFile) continue;
    perFileCount.set(file.path, used + 1);
    keptBlocks.add(block);
  }

  // Step 4: prune each file to its kept blocks. Drop files with no kept
  // blocks (they contributed nothing on closer inspection).
  const prunedFiles: IFocusedFile[] = [];
  for (const file of perFile) {
    const blocks = file.blocks.filter((b) => keptBlocks.has(b));
    if (blocks.length === 0) continue;
    blocks.sort((a, b) => b.similarity - a.similarity);
    prunedFiles.push({ ...file, blocks });
  }
  // Keep file order by best-block similarity descending.
  prunedFiles.sort((a, b) => (b.blocks[0]?.similarity ?? 0) - (a.blocks[0]?.similarity ?? 0));

  // Step 5: re-rank doc-grep candidates by cosine vs task.
  const docHits: IFocusedDocHit[] = [];
  for (const candidate of opts.docCandidatePool ?? []) {
    const vec = await opts.index.embed(`${candidate.path}\n${candidate.snippet}`);
    let dot = 0;
    for (let i = 0; i < vec.length; i += 1) dot += vec[i]! * taskVec[i]!;
    docHits.push({
      path: candidate.path,
      line: candidate.line,
      snippet: candidate.snippet,
      similarity: dot,
    });
  }
  docHits.sort((a, b) => b.similarity - a.similarity);

  // Step 6: rules — take the top 3 packet-ranked rules and trim their bodies.
  const rules = (opts.rules ?? []).slice(0, 3).map((r) => ({
    id: r.id,
    title: r.title,
    summary: ruleSummary(r),
  }));

  const verification = (opts.verificationCommands ?? []).slice(0, 5);

  const result: IFocusedContext = {
    task: opts.task,
    model: opts.index.modelName,
    files: prunedFiles,
    docHits: docHits.slice(0, maxDocHits),
    rules,
    verificationCommands: verification,
    approxTokens: 0,
  };
  result.approxTokens = approxTokenCount(renderFocusedContextForPrompt(result));
  return result;
}

function prepareBlockForEmbedding(path: string, name: string, snippet: string): string {
  // Keep the inputs short (the BGE model has a 512-token window). The
  // embed-time descriptor is path + name + first ~10 lines of the block.
  const head = snippet.split(/\r?\n/).slice(0, 10).join('\n');
  return `${path}::${name}\n${head}`.slice(0, 1200);
}

function ruleSummary(rule: { summary?: string; content?: string }): string {
  if (rule.summary && rule.summary.trim().length > 0) return rule.summary.trim();
  if (rule.content && rule.content.trim().length > 0) {
    return rule.content.trim().split(/\n\n/, 1)[0]!.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function approxTokenCount(text: string): number {
  // Rough heuristic: 4 chars per token (good enough for budgeting).
  return Math.ceil(text.length / 4);
}

/**
 * Render the focused context as a compact Markdown block suitable for
 * inclusion in an LLM prompt. The same renderer powers `--tiny-only`
 * and the `--focused` prompt path so the two views stay aligned.
 */
export function renderFocusedContextForPrompt(ctx: IFocusedContext): string {
  const lines: string[] = [];
  lines.push(`# TASK`);
  lines.push(ctx.task);
  lines.push('');
  if (ctx.files.length > 0) {
    lines.push('# Most relevant code (semantically ranked vs task)');
    for (const file of ctx.files) {
      lines.push(`## \`${file.path}\` (file-sim ${file.fileSimilarity.toFixed(3)})`);
      for (const block of file.blocks) {
        lines.push(`### \`${block.name}\` — ${block.kind} (sim ${block.similarity.toFixed(3)}, L${block.startLine})`);
        lines.push('```ts');
        lines.push(block.snippet);
        lines.push('```');
      }
    }
    lines.push('');
  }
  if (ctx.rules.length > 0) {
    lines.push('# Rules to respect (cite by id verbatim)');
    for (const r of ctx.rules) {
      lines.push(`- \`${r.id}\` — ${r.title}`);
      if (r.summary) lines.push(`  ${r.summary}`);
    }
    lines.push('');
  }
  if (ctx.docHits.length > 0) {
    lines.push('# Related docs (semantic + keyword)');
    for (const h of ctx.docHits) {
      lines.push(`- \`${h.path}\`:${h.line} (sim ${h.similarity.toFixed(3)}) — ${h.snippet}`);
    }
    lines.push('');
  }
  if (ctx.verificationCommands.length > 0) {
    lines.push('# Validation commands (run after change)');
    for (const c of ctx.verificationCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }
  return lines.join('\n');
}
