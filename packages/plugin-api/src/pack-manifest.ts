/**
 * SharkCraft pack manifest.
 *
 * A "pack" is a third-party npm package that ships SharkCraft assets —
 * knowledge entries, rules, paths, templates, pipelines, MCP-tool registrations,
 * AI-provider adapters, etc.
 *
 * The pack itself is just an npm package whose `package.json` declares a
 * `sharkcraft.manifest` entry pointing at a TS/JS file that default-exports an
 * `ISharkCraftPackManifest`. The discovery scanner (planned for v0.2) finds
 * these manifests in `node_modules/` and registers their contributions.
 *
 * Today this file declares the types and a small validator. The discovery
 * runner is intentionally out of scope for v0.1 — see docs/packs.md.
 */

export interface ISharkCraftPackInfo {
  /** Package name as published (e.g. "@example/sharkcraft-pack"). */
  name: string;
  /** Pack version (typically the package version). */
  version: string;
  /** Short human-readable description. */
  description?: string;
  /** Author / vendor. */
  author?: string;
  /** Homepage / repo URL. */
  homepage?: string;
  /** Free-form license string. */
  license?: string;
}

export interface ISharkCraftPackContributions {
  /** Relative paths (from the pack root) to knowledge files. */
  knowledgeFiles?: readonly string[];
  ruleFiles?: readonly string[];
  pathFiles?: readonly string[];
  templateFiles?: readonly string[];
  pipelineFiles?: readonly string[];
  docsFiles?: readonly string[];
  /** Preset definition files (default export = array of IPreset). */
  presetFiles?: readonly string[];
  /** Boundary rule files (default export = array of IBoundaryRule). */
  boundaryFiles?: readonly string[];
  /** Context regression test files. */
  contextTestFiles?: readonly string[];
  /** Agent contract test files. */
  agentTestFiles?: readonly string[];
  /** Future: MCP tool registrations, AI providers, etc. */
  mcpToolFiles?: readonly string[];
  aiProviderFiles?: readonly string[];
  /** Scaffold pattern files (default export = array of IScaffoldPattern). */
  scaffoldPatternFiles?: readonly string[];
  /** Policy check files (default export = array of IPackPolicyCheck). */
  policyCheckFiles?: readonly string[];
  /** Construct definition files (default export = array of IConstructInput). */
  constructFiles?: readonly string[];
  /** Standalone construct facet files. */
  constructFacetFiles?: readonly string[];
  /** Playbook definition files (default export = array of IPlaybookInput). */
  playbookFiles?: readonly string[];
  /** Search-tuning definition files (default export = array of ISearchTuning). */
  searchTuningFiles?: readonly string[];
  /** Pack-extensible feedback rules (default export = array of IFeedbackRule). */
  feedbackRuleFiles?: readonly string[];
  /** TypeScript-authored decision records (default export = array of IDecision). */
  decisionFiles?: readonly string[];
  /** Pack-extensible path conventions when separate from `pathFiles`. */
  pathConventionFiles?: readonly string[];
  /** Pack-contributed plugin lifecycle profiles. Files default-export `readonly IPluginLifecycleProfile[]`. */
  pluginLifecycleProfileFiles?: readonly string[];
  /** Pack-contributed agent-contract templates. Files default-export `readonly IAgentContractTemplate[]`. */
  contractTemplateFiles?: readonly string[];
  /** Pack-contributed migration readiness profiles. */
  migrationProfileFiles?: readonly string[];
  /** Pack-contributed naming/path/barrel conventions. */
  conventionFiles?: readonly string[];
  /** Pack-contributed helpers. Files default-export `readonly IPackHelper[]`. */
  helperFiles?: readonly string[];
  /** Pack-contributed task routing hints. Files default-export `readonly ITaskRoutingHint[]`. */
  taskRoutingHintFiles?: readonly string[];
  /** Pack-contributed registration hints. Files default-export `readonly IRegistrationHint[]`. */
  registrationHintFiles?: readonly string[];
}

export interface ISharkCraftPackSignature {
  /** Algorithm marker (HMAC-SHA256). */
  algo: 'sha256';
  /** Hex-encoded HMAC over canonical-JSON(info + contributions + postInstallNotes). */
  hmac: string;
  /** ISO timestamp of when the manifest was signed. */
  signedAt: string;
  /**
   * Identifier (opaque) of the key used to produce the signature. Lets consumers
   * keep a registry of trusted key ids — see docs/pack-signing.md.
   */
  keyId?: string;
  /**
   * When `true`, this signature was produced by the dev/local signing
   * flow (`shrk packs sign --dev`) and is NOT release-trusted. Apply paths
   * that require release-level signing must reject dev signatures unless
   * the caller opts in with `--allow-dev-signature`.
   *
   * Dev signatures use a well-known dev secret so any developer can produce
   * them mid-session without holding the release secret. They are honest
   * about being dev-only — they do not prove publisher identity.
   */
  dev?: boolean;
}

export interface ISharkCraftPackManifest {
  /** Schema marker; reserved for forward compatibility. */
  schema: 'sharkcraft.pack/v1';
  info: ISharkCraftPackInfo;
  contributions: ISharkCraftPackContributions;
  /** Optional human-readable post-install notes. */
  postInstallNotes?: readonly string[];
  /**
   * Optional HMAC signature over the manifest content. When present, consumers
   * can verify the manifest hasn't been tampered with by an attacker who
   * substituted the npm tarball. See {@link signPackManifest}.
   */
  signature?: ISharkCraftPackSignature;
}

export interface IPackManifestValidationIssue {
  field: string;
  message: string;
}

export interface IPackManifestValidationResult {
  valid: boolean;
  issues: IPackManifestValidationIssue[];
}

/**
 * Lightweight runtime validation of a pack manifest. We do not use zod here
 * because plugin-api should remain dependency-light; consumers can layer zod
 * on top if they want.
 */
export function validatePackManifest(value: unknown): IPackManifestValidationResult {
  const issues: IPackManifestValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'manifest must be an object' }] };
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema !== 'sharkcraft.pack/v1') {
    issues.push({ field: 'schema', message: 'schema must be "sharkcraft.pack/v1"' });
  }
  const info = obj.info as Record<string, unknown> | undefined;
  if (!info || typeof info !== 'object') {
    issues.push({ field: 'info', message: 'info is required' });
  } else {
    if (typeof info.name !== 'string' || info.name.length === 0) {
      issues.push({ field: 'info.name', message: 'info.name must be a non-empty string' });
    }
    if (typeof info.version !== 'string' || info.version.length === 0) {
      issues.push({ field: 'info.version', message: 'info.version must be a non-empty string' });
    }
  }
  const contributions = obj.contributions as Record<string, unknown> | undefined;
  if (!contributions || typeof contributions !== 'object') {
    issues.push({ field: 'contributions', message: 'contributions is required' });
  } else {
    for (const key of [
      'knowledgeFiles',
      'ruleFiles',
      'pathFiles',
      'templateFiles',
      'pipelineFiles',
      'docsFiles',
      'presetFiles',
      'boundaryFiles',
      'contextTestFiles',
      'agentTestFiles',
      'mcpToolFiles',
      'aiProviderFiles',
      'scaffoldPatternFiles',
      'policyCheckFiles',
      'constructFiles',
      'constructFacetFiles',
      'playbookFiles',
      'searchTuningFiles',
      'feedbackRuleFiles',
      'decisionFiles',
      'pathConventionFiles',
      'pluginLifecycleProfileFiles',
      'contractTemplateFiles',
      'migrationProfileFiles',
      'conventionFiles',
      'helperFiles',
      'taskRoutingHintFiles',
      'registrationHintFiles',
    ] as const) {
      const v = contributions[key];
      if (v === undefined) continue;
      if (
        !Array.isArray(v) ||
        v.some((entry) => typeof entry !== 'string' || entry.length === 0)
      ) {
        issues.push({
          field: `contributions.${key}`,
          message: 'must be an array of non-empty strings',
        });
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Convenience for pack authors to write a manifest with type help.
 */
export function definePackManifest(input: ISharkCraftPackManifest): ISharkCraftPackManifest {
  return input;
}
