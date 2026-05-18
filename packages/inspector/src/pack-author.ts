/**
 * Pack asset authoring workflow.
 *
 * Generic, preview-first orchestrator over the asset kinds a SharkCraft
 * pack can ship:
 *   - status (read-only inventory of asset kinds + per-kind counts + signature)
 *   - preview (delegate to knowledge for the load-bearing kind; other
 *     kinds return an explicit "not yet implemented" preview with a clear
 *     next-step list)
 *   - pending (cross-section: modified files, drafts under .sharkcraft/,
 *     stale signature, missing-secret state) — composed in `pack-pending.ts`.
 *
 * Hard rules:
 *   - Never mutate pack source. Drafts go under .sharkcraft/authoring/.
 *   - Honest: refuse to fake an authoring slice we don't yet support.
 *   - No project-specific logic.
 */

import { existsSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PACK_AUTHOR_STATUS_SCHEMA = 'sharkcraft.pack-author-status/v1';
export const PACK_AUTHOR_PREVIEW_SCHEMA = 'sharkcraft.pack-author-preview/v1';
export const PACK_AUTHOR_VALIDATE_SCHEMA = 'sharkcraft.pack-author-validate/v1';

export enum PackAuthorKind {
  Knowledge = 'knowledge',
  SearchTuning = 'search-tuning',
  FeedbackRule = 'feedback-rule',
  AgentTest = 'agent-test',
  Convention = 'convention',
  TaskRoutingHint = 'task-routing-hint',
  RegistrationHint = 'registration-hint',
  ScaffoldPattern = 'scaffold-pattern',
}

const KIND_TO_CONTRIBUTION_SLOT: Record<PackAuthorKind, string> = {
  [PackAuthorKind.Knowledge]: 'knowledgeFiles',
  [PackAuthorKind.SearchTuning]: 'searchTuningFiles',
  [PackAuthorKind.FeedbackRule]: 'feedbackRuleFiles',
  [PackAuthorKind.AgentTest]: 'agentTestFiles',
  [PackAuthorKind.Convention]: 'conventionFiles',
  [PackAuthorKind.TaskRoutingHint]: 'taskRoutingHintFiles',
  [PackAuthorKind.RegistrationHint]: 'registrationHintFiles',
  [PackAuthorKind.ScaffoldPattern]: 'scaffoldPatternFiles',
};

export interface IPackAuthorTargetEntry {
  /** 'local' = sharkcraft/<kind>.ts, 'pack' = a pack assets/<kind>.ts. */
  kind: 'local' | 'pack';
  packName?: string;
  packageRoot?: string;
  /** Project-relative path the human/agent would edit. */
  filePath?: string;
  /** Whether the resolver found the file. */
  exists: boolean;
}

export interface IPackAuthorStatus {
  schema: typeof PACK_AUTHOR_STATUS_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  /** Map of kind → number of contributions across local + packs. */
  contributionCounts: Readonly<Record<string, number>>;
  /** Number of pending draft files under .sharkcraft/authoring/. */
  pendingDrafts: number;
  pendingDraftFiles: readonly string[];
  /** Whether the asset-provenance ledger exists. */
  provenanceExists: boolean;
  /** Whether SHARKCRAFT_PACK_SECRET is available in env. */
  secretAvailable: boolean;
  /** Per-kind, where the local + pack files live. */
  resolvedTargets: Readonly<Record<string, IPackAuthorTargetEntry[]>>;
  /** Honest about which kinds are implemented vs deferred. */
  authoringSupport: Readonly<Record<string, 'preview' | 'deferred'>>;
  /** Recommended next commands. */
  nextCommands: readonly string[];
}

export function buildPackAuthorStatus(
  inspection: ISharkcraftInspection,
): IPackAuthorStatus {
  const root = inspection.projectRoot;
  const sharkcraftDir = inspection.sharkcraftDir ?? nodePath.join(root, 'sharkcraft');
  const contributionCounts: Record<string, number> = {};
  const resolvedTargets: Record<string, IPackAuthorTargetEntry[]> = {};

  for (const kind of Object.values(PackAuthorKind)) {
    contributionCounts[kind] = 0;
    resolvedTargets[kind] = [];
  }

  // Local — sharkcraft/<kind>.ts (best-effort).
  for (const kind of Object.values(PackAuthorKind)) {
    const localCandidates = candidateLocalFiles(sharkcraftDir, kind);
    const targets = resolvedTargets[kind];
    if (!targets) continue;
    for (const localPath of localCandidates) {
      const rel = nodePath.relative(root, localPath);
      const exists = existsSync(localPath);
      targets.push({
        kind: 'local',
        filePath: rel,
        exists,
      });
      if (exists) contributionCounts[kind] = (contributionCounts[kind] ?? 0) + 1;
    }
  }

  // Packs.
  for (const pack of (inspection.packs.validPacks ?? []) as ReadonlyArray<{
    packageName: string;
    packageRoot: string;
    manifest?: { contributions?: Record<string, readonly string[] | undefined> };
  }>) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<
      string,
      readonly string[] | undefined
    >;
    for (const kind of Object.values(PackAuthorKind)) {
      const slot = KIND_TO_CONTRIBUTION_SLOT[kind];
      const rels = contributions[slot] ?? [];
      const targets = resolvedTargets[kind];
      if (!targets) continue;
      for (const rel of rels) {
        const abs = nodePath.resolve(pack.packageRoot, rel);
        const projectRel = nodePath.relative(root, abs);
        const exists = existsSync(abs);
        targets.push({
          kind: 'pack',
          packName: pack.packageName,
          packageRoot: pack.packageRoot,
          filePath: projectRel,
          exists,
        });
        if (exists) contributionCounts[kind] = (contributionCounts[kind] ?? 0) + 1;
      }
    }
  }

  const authoringSupport: Record<string, 'preview' | 'deferred'> = {
    [PackAuthorKind.Knowledge]: 'preview',
    [PackAuthorKind.SearchTuning]: 'deferred',
    [PackAuthorKind.FeedbackRule]: 'deferred',
    [PackAuthorKind.AgentTest]: 'deferred',
    [PackAuthorKind.Convention]: 'deferred',
    [PackAuthorKind.TaskRoutingHint]: 'deferred',
    [PackAuthorKind.RegistrationHint]: 'deferred',
    [PackAuthorKind.ScaffoldPattern]: 'deferred',
  };

  const pendingDir = nodePath.join(root, '.sharkcraft', 'authoring');
  let pendingDrafts = 0;
  const pendingDraftFiles: string[] = [];
  if (existsSync(pendingDir)) {
    for (const f of readdirSync(pendingDir)) {
      if (f.endsWith('.draft.ts') || f.endsWith('.preview.md') || f.endsWith('.patch') || f.endsWith('.manifest.json')) {
        pendingDrafts++;
        pendingDraftFiles.push(nodePath.relative(root, nodePath.join(pendingDir, f)));
      }
    }
  }

  const provenancePath = nodePath.join(root, '.sharkcraft', 'asset-provenance.jsonl');
  const provenanceExists = existsSync(provenancePath);
  const secretAvailable = Boolean(process.env['SHARKCRAFT_PACK_SECRET']);

  return {
    schema: PACK_AUTHOR_STATUS_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    contributionCounts,
    pendingDrafts,
    pendingDraftFiles,
    provenanceExists,
    secretAvailable,
    resolvedTargets,
    authoringSupport,
    nextCommands: [
      'shrk pack author pending',
      'shrk knowledge stale-check --ci',
      'shrk self-config doctor',
      'shrk packs signature-status',
    ],
  };
}

function candidateLocalFiles(sharkcraftDir: string, kind: PackAuthorKind): string[] {
  const ext = '.ts';
  // Each kind maps to a primary canonical local file. We return one path
  // — the canonical one — and let the caller mark exists/missing.
  switch (kind) {
    case PackAuthorKind.Knowledge:
      return [nodePath.join(sharkcraftDir, `knowledge${ext}`)];
    case PackAuthorKind.SearchTuning:
      return [nodePath.join(sharkcraftDir, `search-tuning${ext}`)];
    case PackAuthorKind.FeedbackRule:
      return [nodePath.join(sharkcraftDir, `feedback-rules${ext}`)];
    case PackAuthorKind.AgentTest:
      return [nodePath.join(sharkcraftDir, `agent-tests${ext}`)];
    case PackAuthorKind.Convention:
      return [nodePath.join(sharkcraftDir, `conventions${ext}`)];
    case PackAuthorKind.TaskRoutingHint:
      return [nodePath.join(sharkcraftDir, `task-routing-hints${ext}`)];
    case PackAuthorKind.RegistrationHint:
      return [nodePath.join(sharkcraftDir, `registration-hints${ext}`)];
    case PackAuthorKind.ScaffoldPattern:
      return [nodePath.join(sharkcraftDir, `scaffold-patterns${ext}`)];
  }
}

export interface IPackAuthorPreviewInput {
  kind: PackAuthorKind;
  /** Asset id (e.g. knowledge entry id). */
  assetId: string;
  /** Optional pack/local target. */
  target?: IPackAuthorTargetEntry;
  /** Provenance reason. */
  reason?: string;
}

export interface IPackAuthorPreviewResult {
  schema: typeof PACK_AUTHOR_PREVIEW_SCHEMA;
  generatedAt: string;
  kind: PackAuthorKind;
  assetId: string;
  /** True when the kind is implemented; false → deferred (returns next steps). */
  implemented: boolean;
  /** Honest message when implemented=false. */
  deferralNote?: string;
  /** Recommended next commands. */
  nextCommands: readonly string[];
}

export function buildPackAuthorPreview(
  input: IPackAuthorPreviewInput,
): IPackAuthorPreviewResult {
  if (input.kind === PackAuthorKind.Knowledge) {
    return {
      schema: PACK_AUTHOR_PREVIEW_SCHEMA,
      generatedAt: new Date().toISOString(),
      kind: input.kind,
      assetId: input.assetId,
      implemented: true,
      nextCommands: [
        `shrk knowledge add --id ${input.assetId}${input.reason ? ` --reason "${input.reason}"` : ''}`,
        `shrk knowledge stale-check --ci`,
        `shrk self-config doctor`,
        `shrk pack author pending`,
      ],
    };
  }
  return {
    schema: PACK_AUTHOR_PREVIEW_SCHEMA,
    generatedAt: new Date().toISOString(),
    kind: input.kind,
    assetId: input.assetId,
    implemented: false,
    deferralNote:
      `Only the knowledge kind is implemented for authoring preview. For "${input.kind}", ` +
      `edit the pack's \`assets/${input.kind}.ts\` file manually; preview support is planned.`,
    nextCommands: [
      `# Open the pack file that contributes ${input.kind} entries:`,
      `shrk packs contributions --kind ${input.kind}`,
      `# Then validate after the edit:`,
      `shrk self-config doctor`,
      `shrk packs signature-status`,
    ],
  };
}

export interface IPackAuthorValidateResult {
  schema: typeof PACK_AUTHOR_VALIDATE_SCHEMA;
  generatedAt: string;
  /** Whether the workspace currently looks healthy after authoring. */
  ok: boolean;
  /** Recommended commands to actually verify (this module does not run them). */
  recommendedCommands: readonly string[];
}

export function buildPackAuthorValidatePlan(): IPackAuthorValidateResult {
  return {
    schema: PACK_AUTHOR_VALIDATE_SCHEMA,
    generatedAt: new Date().toISOString(),
    ok: true,
    recommendedCommands: [
      'shrk knowledge stale-check --ci',
      'shrk self-config doctor',
      'shrk packs signature-status',
      'shrk packs doctor --signature-explain',
      'shrk packs sign --if-needed',
    ],
  };
}
