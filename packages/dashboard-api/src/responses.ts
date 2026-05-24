/**
 * Versioned response payloads. Each response is wrapped by
 * IDashboardApiEnvelope<T> on the wire; this module defines the inner T shapes.
 *
 * All fields are JSON-serializable. No functions. No circular refs. New
 * optional fields are non-breaking; renaming or removing fields requires a
 * schema-version bump (`sharkcraft.dashboard-api/v2` etc.).
 */
import type {
  IDashboardArtifactRef,
  IDashboardCommandHint,
  IDashboardCount,
  IDashboardSafetyTag,
  IDashboardSection,
} from './common.ts';

export interface IDashboardOverviewResponse {
  readonly readiness: {
    readonly score: number;
    readonly verdict: string;
  };
  readonly sharkcraftPresent: boolean;
  readonly configPresent: boolean;
  readonly summary: {
    readonly rules: number;
    readonly paths: number;
    readonly templates: number;
    readonly pipelines: number;
    readonly presets: number;
    readonly packs: number;
    readonly scaffoldPatterns: number;
    readonly knowledgeEntries: number;
  };
  readonly topRecommendations: readonly string[];
  readonly featureAvailability: Readonly<Record<string, boolean>>;
}

export interface IDashboardDoctorResponse {
  readonly verdict: 'ready' | 'not-ready';
  readonly readinessScore: number;
  readonly checks: readonly {
    readonly id: string;
    readonly label: string;
    readonly level: 'ok' | 'info' | 'warning' | 'error';
    readonly message?: string;
    readonly fix?: string;
  }[];
  readonly summary: {
    readonly ok: number;
    readonly info: number;
    readonly warnings: number;
    readonly errors: number;
  };
}

export interface IDashboardQualityResponse {
  readonly score: number;
  readonly readiness: string;
  readonly gates: readonly {
    readonly id: string;
    readonly status: 'pass' | 'warn' | 'fail' | 'skipped';
    readonly message?: string;
  }[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly artifacts: readonly IDashboardArtifactRef[];
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardSafetyResponse {
  readonly mcpReadOnly: boolean;
  readonly writeCapableCommands: readonly string[];
  readonly shellRunningCommands: readonly string[];
  readonly verificationCommandTrust: 'config-only' | 'pack-untrusted' | 'mixed' | 'unknown';
  readonly packSigning: {
    readonly required: boolean;
    readonly verified: number;
    readonly unsigned: number;
  };
  readonly planSigning: {
    readonly verifySignatureSupported: boolean;
    readonly hmacBased: boolean;
  };
  readonly recommendations: readonly string[];
  readonly safetyTags: readonly IDashboardSafetyTag[];
}

export interface IDashboardCommandsResponse {
  readonly version: string;
  readonly commands: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly safety: IDashboardSafetyTag;
    readonly group?: string;
    readonly examples?: readonly string[];
    readonly relatedCommands?: readonly string[];
  }[];
  readonly groups: readonly { readonly id: string; readonly label: string }[];
}

export interface IDashboardPacksResponse {
  readonly available: boolean;
  readonly packs: readonly {
    readonly id: string;
    readonly name: string;
    readonly version?: string;
    readonly signed: boolean;
    readonly resolvedCounts: Readonly<Record<string, number>>;
    readonly source?: string;
    readonly warnings?: readonly string[];
  }[];
}

export interface IDashboardPresetsResponse {
  readonly available: boolean;
  readonly presets: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly source?: string;
  }[];
}

export interface IDashboardPipelinesResponse {
  readonly available: boolean;
  readonly pipelines: readonly {
    readonly id: string;
    readonly title: string;
    readonly steps: number;
  }[];
}

export interface IDashboardSessionsResponse {
  readonly available: boolean;
  readonly sessions: readonly {
    readonly id: string;
    readonly slug?: string;
    readonly startedAt?: string;
    readonly task?: string;
    readonly status?: string;
    readonly reportPath?: string;
    readonly htmlReportPath?: string;
    readonly liveServerHint?: string;
  }[];
}

export interface IDashboardSessionDetailResponse {
  readonly available: boolean;
  readonly sessionId: string;
  readonly task?: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly artifacts: readonly IDashboardArtifactRef[];
  readonly plans?: readonly { readonly id: string; readonly path: string }[];
  readonly reports?: readonly IDashboardArtifactRef[];
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardArchitectureResponse {
  readonly available: boolean;
  readonly boundaries: IDashboardBoundaryResponse;
  readonly drift: IDashboardDriftResponse;
  readonly coverage: IDashboardCoverageResponse;
}

export interface IDashboardBoundaryResponse {
  readonly available: boolean;
  readonly violations: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly rule: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly message?: string;
  }[];
  readonly ruleCount: number;
}

export interface IDashboardDriftResponse {
  readonly available: boolean;
  readonly items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly message: string;
    readonly severity: 'info' | 'warning' | 'error';
  }[];
}

export interface IDashboardCoverageResponse {
  readonly available: boolean;
  readonly axes: readonly {
    readonly id: string;
    readonly label: string;
    readonly score: number;
    readonly missing: readonly string[];
  }[];
}

export interface IDashboardGraphResponse {
  readonly available: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label?: string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
  }[];
}

export interface IDashboardGraphNodeResponse {
  readonly id: string;
  readonly found: boolean;
  readonly node?: {
    readonly id: string;
    readonly kind: string;
    readonly label?: string;
    readonly tags?: readonly string[];
  };
  readonly inbound: readonly { readonly from: string; readonly kind: string }[];
  readonly outbound: readonly { readonly to: string; readonly kind: string }[];
}

export interface IDashboardGraphPathResponse {
  readonly from: string;
  readonly to: string;
  readonly path?: readonly string[];
  readonly explanation?: string;
  readonly found: boolean;
}

export interface IDashboardOnboardingResponse {
  readonly available: boolean;
  readonly draftsPath?: string;
  readonly hasDrafts: boolean;
  readonly summary?: {
    readonly inferredRules: number;
    readonly inferredPaths: number;
    readonly inferredTemplates: number;
    readonly importedAgents: number;
  };
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardAdoptionResponse {
  readonly available: boolean;
  readonly state?: {
    readonly schema: string;
    readonly patchPath?: string;
    readonly summaryPath?: string;
    readonly reportPath?: string;
    readonly diffFormat?: 'pseudo' | 'unified';
    readonly freshness: {
      readonly status: 'fresh' | 'stale' | 'unknown';
      readonly staleReasons: readonly string[];
      readonly changedTargets: readonly string[];
      readonly changedDrafts: readonly string[];
      readonly missingTargets: readonly string[];
      readonly missingDrafts: readonly string[];
    };
    readonly categories: {
      readonly safeToAdopt: number;
      readonly manualReview: number;
      readonly lowConfidence: number;
      readonly conflicts: number;
      readonly alreadyCovered: number;
      readonly skipped: number;
    };
    readonly threeWayPreview?: readonly {
      readonly target: string;
      readonly status:
        | 'safe'
        | 'probably-safe'
        | 'stale-target'
        | 'stale-draft'
        | 'create-file-safe'
        | 'target-deleted'
        | 'conflict'
        | 'manual-review-needed';
      readonly reason?: string;
    }[];
  };
  readonly nextCommands: readonly IDashboardCommandHint[];
  readonly artifacts: readonly IDashboardArtifactRef[];
}

export interface IDashboardReportsResponse {
  readonly available: boolean;
  readonly reports: readonly {
    readonly id: string;
    readonly title: string;
    readonly availableFormats: readonly ('text' | 'markdown' | 'html' | 'json')[];
    readonly commandHint: string;
    readonly artifacts: readonly IDashboardArtifactRef[];
  }[];
}

export interface IDashboardReviewResponse {
  readonly available: boolean;
  readonly packetPath?: string;
  readonly summary?: string;
  readonly affectedAreas: readonly string[];
  readonly relevantRules: readonly string[];
  readonly suggestedChecks: readonly string[];
  readonly artifacts: readonly IDashboardArtifactRef[];
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardScaffoldsResponse {
  readonly available: boolean;
  readonly patterns: readonly {
    readonly id: string;
    readonly title: string;
    readonly templateId: string;
    readonly source: string;
    readonly confidence: 'low' | 'medium' | 'high';
    readonly matchPaths: readonly string[];
    readonly appliesWhen: readonly string[];
  }[];
  readonly warnings: readonly string[];
}

export interface IDashboardSchemasResponse {
  readonly schemas: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
  }[];
}

export interface IDashboardMcpResponse {
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly readOnly: boolean;
  }[];
  readonly readOnly: true;
  readonly transports: readonly ('stdio' | 'http')[];
}

export interface IDashboardHealthResponse {
  readonly ok: true;
  readonly readOnly: true;
  readonly apiVersion: string;
  readonly schemaId: string;
  readonly uptimeSeconds: number;
  readonly capabilitiesUrl: string;
}

export interface IDashboardCapabilitiesResponse {
  readonly readOnly: true;
  readonly supportsSessions: boolean;
  readonly supportsQuality: boolean;
  readonly supportsSafety: boolean;
  readonly supportsAdoption: boolean;
  readonly supportsScaffolds: boolean;
  readonly supportsReports: boolean;
  readonly supportsGraph: boolean;
  readonly supportsReview: boolean;
  readonly supportsPacks: boolean;
  readonly supportsPresets: boolean;
  readonly supportsPipelines: boolean;
  readonly supportsMcpSummary: boolean;
  readonly supportsLiveSessionEvents: boolean;
  readonly writeEndpoints: readonly [];
  readonly dangerousActions: readonly [];
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardStatsLanguage {
  readonly language: string;
  readonly extensions: readonly string[];
  readonly files: number;
  readonly bytes: number;
  readonly totalLines: number;
  readonly codeLines: number;
  readonly commentLines: number;
  readonly blankLines: number;
  readonly averageFileBytes: number;
  readonly averageFileLines: number;
  readonly largestFile: {
    readonly path: string;
    readonly bytes: number;
    readonly lines: number;
  } | null;
}

export interface IDashboardStatsTopFile {
  readonly path: string;
  readonly language: string;
  readonly bytes: number;
  readonly lines: number;
}

export interface IDashboardStatsResponse {
  readonly schema: 'sharkcraft.repository-stats/v1';
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly totals: {
    readonly files: number;
    readonly bytes: number;
    readonly totalLines: number;
    readonly codeLines: number;
    readonly commentLines: number;
    readonly blankLines: number;
  };
  readonly byLanguage: readonly IDashboardStatsLanguage[];
  readonly topFiles: readonly IDashboardStatsTopFile[];
  readonly ignoredDirectories: readonly string[];
  readonly truncated: boolean;
  readonly commandHints: readonly IDashboardCommandHint[];
}

/**
 * Code intelligence overview: aggregated counts across the on-disk
 * stores plus the architecture-guard checks. Surfaces the new code-
 * intelligence layer in the dashboard without requiring a deep dive
 * into each store.
 */
export interface IDashboardCodeIntelligenceResponse {
  readonly schema: 'sharkcraft.dashboard-code-intelligence/v1';
  readonly available: boolean;
  readonly graph: {
    readonly available: boolean;
    readonly fileCount?: number;
    readonly nodeCount?: number;
    readonly edgeCount?: number;
    readonly workspacePackages?: number;
    readonly lastIndexedAt?: string;
    readonly nodesByKind?: Readonly<Record<string, number>>;
    readonly edgesByKind?: Readonly<Record<string, number>>;
    readonly hint?: string;
  };
  readonly bridge: {
    readonly available: boolean;
    readonly lastBuiltAt?: string;
    readonly nodesByKind?: Readonly<Record<string, number>>;
    readonly edgesByKind?: Readonly<Record<string, number>>;
    readonly sourceCounts?: Readonly<Record<string, number>>;
    readonly hint?: string;
  };
  readonly framework: {
    readonly available: boolean;
    readonly lastBuiltAt?: string;
    readonly frameworks?: readonly string[];
    readonly countsByFramework?: Readonly<Record<string, number>>;
    readonly countsBySubtype?: Readonly<Record<string, number>>;
    readonly hint?: string;
  };
  readonly architecture: {
    readonly available: boolean;
    readonly errors: number;
    readonly warnings: number;
    readonly violationsByKind?: Readonly<Record<string, number>>;
    readonly hint?: string;
  };
  readonly commandHints: readonly IDashboardCommandHint[];
}

/**
 * Flattened cross-framework route table. Aggregates HTTP routes
 * detected by every framework extractor (NestJS, Express, Fastify,
 * FastAPI, Flask, Next.js, Astro). One row per (method, path, handler,
 * file) tuple. Lets the dashboard answer "where is my service exposed?"
 * in one panel.
 */
export interface IDashboardRouteRow {
  readonly framework: string;
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly file: string;
}

export interface IDashboardRoutesResponse {
  readonly schema: 'sharkcraft.dashboard-routes/v1';
  readonly available: boolean;
  readonly total: number;
  readonly byFramework: Readonly<Record<string, number>>;
  readonly routes: readonly IDashboardRouteRow[];
  readonly commandHints: readonly IDashboardCommandHint[];
  readonly hint?: string;
}

/**
 * Migration run state as persisted by `@shrkcrft/migrate` at
 * `.sharkcraft/migrations/<id>.state.json`. One row per saved
 * migration; the runner writes a fresh checkpoint after every step,
 * so the dashboard always reflects the latest known progress even if
 * a runner crashed mid-flow.
 */
export interface IDashboardMigrationStep {
  readonly index: number;
  readonly id: string;
  readonly kind: 'structural-rewrite' | 'shell' | 'check';
  readonly status: 'pending' | 'planned' | 'applied' | 'failed' | 'skipped';
  readonly message: string;
  readonly durationMs: number;
}

export interface IDashboardMigrationRow {
  readonly id: string;
  readonly title: string;
  readonly overall: 'pass' | 'fail' | 'skipped';
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly totalDurationMs: number;
  readonly steps: readonly IDashboardMigrationStep[];
  /** Step index where `resumeMigration` would pick up; undefined when complete. */
  readonly resumePoint?: number;
}

export interface IDashboardMigrationsResponse {
  readonly schema: 'sharkcraft.dashboard-migrations/v1';
  readonly available: boolean;
  readonly total: number;
  readonly migrations: readonly IDashboardMigrationRow[];
  readonly commandHints: readonly IDashboardCommandHint[];
  readonly hint?: string;
}

/**
 * Quality-gate report shaped for the dashboard. Computed on request
 * by running `runQualityGates` against the current project.
 */
export interface IDashboardQualityGate {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'warn' | 'skipped';
  readonly message: string;
  readonly durationMs: number;
  readonly nextCommands?: readonly string[];
}

export interface IDashboardQualityGatesResponse {
  readonly schema: 'sharkcraft.dashboard-quality-gates/v1';
  readonly overall: 'pass' | 'fail' | 'warn' | 'skipped';
  readonly totalDurationMs: number;
  readonly startedAt: string;
  readonly counts: Readonly<Record<'pass' | 'fail' | 'warn' | 'skipped', number>>;
  readonly gates: readonly IDashboardQualityGate[];
  readonly commandHints: readonly IDashboardCommandHint[];
}

export interface IDashboardErrorResponse {
  readonly error: string;
  readonly code:
    | 'not-found'
    | 'method-not-allowed'
    | 'bad-request'
    | 'internal'
    | 'unavailable';
  readonly hint?: string;
}

/** Re-exports for convenience. */
export type { IDashboardSection, IDashboardCount, IDashboardArtifactRef };
