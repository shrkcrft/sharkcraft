import type { ContributionFileKey, ISharkCraftPackManifest } from '@shrkcrft/plugin-api';

export interface IDiscoveredPack {
  /** Published package name (from package.json). */
  packageName: string;
  packageVersion: string;
  /** Resolved absolute path to the loaded manifest file. */
  manifestPath: string;
  /** Absolute path to the package's root. */
  packageRoot: string;
  /** Parsed manifest, if it loaded. */
  manifest?: ISharkCraftPackManifest;
  /**
   * Number of contribution **files** of each kind. Zero if not declared.
   *
   * Populated generically from the canonical `CONTRIBUTION_FILE_KEYS`
   * (`@shrkcrft/plugin-api`) so an "extended"-only pack (conventions / helpers /
   * framework extractors / decisions / …) still reports a non-zero declared
   * total. The originally-tracked kinds stay required for back-compat; the
   * extended kinds are optional so older object literals keep type-checking, but
   * `countContributions` fills in every key.
   */
  contributionCounts: {
    knowledgeFiles: number;
    ruleFiles: number;
    pathFiles: number;
    templateFiles: number;
    pipelineFiles: number;
    docsFiles: number;
    presetFiles: number;
    scaffoldPatternFiles: number;
    policyCheckFiles: number;
    constructFiles: number;
    constructFacetFiles: number;
    playbookFiles: number;
    delegateRecipeFiles: number;
  } & Partial<Record<ContributionFileKey, number>>;
  /**
   * Number of **resolved objects** loaded from this pack's contributions, after
   * de-duplication against local entries and inside the pack. Populated by the
   * inspector after pack discovery completes. Zero when discovery ran in
   * isolation (no contribution loading).
   */
  resolvedCounts?: {
    knowledgeEntries: number;
    rules: number;
    pathConventions: number;
    templates: number;
    pipelines: number;
    docs: number;
    presets: number;
    scaffoldPatterns: number;
    policyChecks: number;
  };
  /** Validation issues from validatePackManifest. */
  validationIssues: Array<{ field: string; message: string }>;
  /** Manifest-level load error message, if any. */
  loadError?: string;
  /** True if the manifest loaded and validated cleanly. */
  valid: boolean;
  /** Signature verification status, when applicable. */
  signatureStatus?:
    | 'verified'
    | 'invalid-signature'
    | 'missing-signature'
    | 'missing-secret'
    | 'dev-signature'
    | 'not-checked';
  /** Free-form message accompanying the signature status. */
  signatureMessage?: string;
  /**
   * True when this pack's signature carries `dev: true` — produced by
   * `shrk packs sign --dev` and verified only against the well-known public
   * dev secret. Dev signatures are NOT release-trusted; they verify under
   * `--allow-dev-signature` but otherwise report `signatureStatus:
   * 'dev-signature'`. Populated from the verify result (or, when verification
   * did not run, from the manifest's signature block).
   */
  signatureDev?: boolean;
}

export interface IPackDiscoveryResult {
  projectRoot: string;
  /** node_modules directory scanned. May be missing. */
  nodeModulesPath: string;
  nodeModulesExists: boolean;
  /** Total number of package.json files we inspected. */
  scannedPackageCount: number;
  /** Packs that have a manifest field (valid or not). */
  discoveredPacks: IDiscoveredPack[];
  /** Convenience subsets. */
  validPacks: IDiscoveredPack[];
  invalidPacks: IDiscoveredPack[];
  /** Free-form warnings during discovery. */
  warnings: string[];
}
