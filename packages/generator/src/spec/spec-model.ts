/**
 * `sharkcraft.spec/v1` model + structural validation.
 *
 * The spec frontmatter is the authoritative source of truth; the markdown
 * body is inert documentation. `spec.json` is the canonical machine-
 * readable view, derived deterministically (see `spec-derive.ts`).
 *
 * Structural validation lives here so the generator package can validate
 * a spec without pulling in the inspector. Cross-registry validation
 * (rule / knowledge / template / verification command resolution) lives
 * in `@shrkcrft/inspector`.
 */

export const SPEC_SCHEMA_V1 = 'sharkcraft.spec/v1';
export const SPEC_EVENTS_SCHEMA_V1 = 'sharkcraft.spec-events/v1';

export enum SpecStatus {
  Draft = 'draft',
  Review = 'review',
  Implementing = 'implementing',
  Implemented = 'implemented',
  Verified = 'verified',
  Abandoned = 'abandoned',
}

export const SPEC_STATUS_VALUES: readonly SpecStatus[] = Object.freeze([
  SpecStatus.Draft,
  SpecStatus.Review,
  SpecStatus.Implementing,
  SpecStatus.Implemented,
  SpecStatus.Verified,
  SpecStatus.Abandoned,
]);

export interface ISpecAcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly verifiedBy: readonly string[];
}

export interface ISpecAffectedAreas {
  readonly files: readonly string[];
  readonly packages: readonly string[];
  readonly layers: readonly string[];
}

export interface ISpecProposedTemplate {
  readonly templateId: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly note?: string;
}

export interface ISpecRisk {
  readonly id: string;
  readonly text: string;
  readonly mitigation?: string;
}

export interface ISpecExternalLinks {
  readonly issue?: string | null;
  readonly pr?: string | null;
}

export interface ISpecBoundaryPrediction {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ISpecVerificationCommandRef {
  readonly id: string;
}

export interface ISpecPlanRef {
  readonly planPath: string;
  readonly planHash: string;
  readonly signedAt?: string;
}

/**
 * The canonical machine-readable view of a spec. Derived from `spec.md`
 * frontmatter. The `bodyHash` / `frontmatterHash` are sha256 hex digests.
 */
export interface ISpecJson {
  readonly schema: typeof SPEC_SCHEMA_V1;
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: SpecStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly intent: string;
  readonly motivation: string;
  readonly acceptanceCriteria: readonly ISpecAcceptanceCriterion[];
  readonly affectedAreas: ISpecAffectedAreas;
  readonly relevantRules: readonly string[];
  readonly relevantKnowledge: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly proposedTemplates: readonly ISpecProposedTemplate[];
  readonly risks: readonly ISpecRisk[];
  readonly outOfScope: readonly string[];
  readonly externalLinks: ISpecExternalLinks;
  readonly boundariesCheck: { readonly predicted: readonly ISpecBoundaryPrediction[] };
  readonly verificationCommands: readonly ISpecVerificationCommandRef[];
  readonly plan?: ISpecPlanRef;
  readonly frontmatterHash: string;
  readonly bodyHash: string;
  /** Unknown frontmatter keys preserved so review reports can flag them. */
  readonly unknownKeys: readonly string[];
}

export interface ISpecValidationIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly field: string;
  readonly message: string;
}

/**
 * The structural validation pass — does NOT touch external registries.
 * Returns `errors` for blocking problems, `warnings` for advisory ones.
 * Cross-registry checks (do the referenced rule/knowledge/template ids
 * resolve?) live in `@shrkcrft/inspector`.
 */
export interface ISpecStructuralValidation {
  readonly errors: readonly ISpecValidationIssue[];
  readonly warnings: readonly ISpecValidationIssue[];
}

const KNOWN_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  'schema',
  'id',
  'slug',
  'title',
  'status',
  'createdAt',
  'updatedAt',
  'intent',
  'motivation',
  'acceptanceCriteria',
  'affectedAreas',
  'relevantRules',
  'relevantKnowledge',
  'relevantPaths',
  'proposedTemplates',
  'risks',
  'outOfScope',
  'externalLinks',
  'boundariesCheck',
  'verificationCommands',
  'plan',
]);

export function knownTopLevelKeys(): readonly string[] {
  return KNOWN_TOP_LEVEL_KEYS;
}

/** Default spec body length cap, in bytes. */
export const DEFAULT_SPEC_BODY_MAX_BYTES = 16384;

export function validateSpecStructural(
  spec: ISpecJson,
  body: string,
  options: { bodyMaxBytes?: number } = {},
): ISpecStructuralValidation {
  const errors: ISpecValidationIssue[] = [];
  const warnings: ISpecValidationIssue[] = [];

  if (spec.schema !== SPEC_SCHEMA_V1) {
    errors.push({
      code: 'unsupported-schema',
      severity: 'error',
      field: 'schema',
      message: `Spec schema must be ${SPEC_SCHEMA_V1} (got ${String(spec.schema)})`,
    });
  }
  if (!isSpecIdShape(spec.id)) {
    errors.push({
      code: 'invalid-spec-id',
      severity: 'error',
      field: 'id',
      message: `Spec id must match <YYYY-MM-DD>-<slug> (got "${spec.id}")`,
    });
  }
  if (!spec.slug || !/^[a-z0-9][a-z0-9-]*$/.test(spec.slug)) {
    errors.push({
      code: 'invalid-slug',
      severity: 'error',
      field: 'slug',
      message: `Slug must be kebab-case (got "${spec.slug}")`,
    });
  }
  if (!spec.title || spec.title.trim().length === 0) {
    errors.push({
      code: 'missing-title',
      severity: 'error',
      field: 'title',
      message: 'title must be a non-empty string',
    });
  }
  if (!SPEC_STATUS_VALUES.includes(spec.status)) {
    errors.push({
      code: 'invalid-status',
      severity: 'error',
      field: 'status',
      message: `status must be one of ${SPEC_STATUS_VALUES.join(', ')} (got "${String(spec.status)}")`,
    });
  }
  if (!isIsoTimestamp(spec.createdAt)) {
    errors.push({
      code: 'invalid-created-at',
      severity: 'error',
      field: 'createdAt',
      message: `createdAt must be an ISO-8601 timestamp (got "${spec.createdAt}")`,
    });
  }
  if (!isIsoTimestamp(spec.updatedAt)) {
    errors.push({
      code: 'invalid-updated-at',
      severity: 'error',
      field: 'updatedAt',
      message: `updatedAt must be an ISO-8601 timestamp (got "${spec.updatedAt}")`,
    });
  }
  if (!spec.intent || spec.intent.trim().length === 0) {
    errors.push({
      code: 'missing-intent',
      severity: 'error',
      field: 'intent',
      message: 'intent must be a non-empty string',
    });
  }
  if (!spec.motivation || spec.motivation.trim().length === 0) {
    errors.push({
      code: 'missing-motivation',
      severity: 'error',
      field: 'motivation',
      message: 'motivation must be a non-empty string',
    });
  }
  if (!Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0) {
    errors.push({
      code: 'missing-acceptance-criteria',
      severity: 'error',
      field: 'acceptanceCriteria',
      message: 'acceptanceCriteria must contain at least one entry',
    });
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < spec.acceptanceCriteria.length; i++) {
      const ac = spec.acceptanceCriteria[i]!;
      if (!ac.id) {
        errors.push({
          code: 'acceptance-missing-id',
          severity: 'error',
          field: `acceptanceCriteria[${i}].id`,
          message: 'each acceptance criterion needs an id',
        });
        continue;
      }
      if (seen.has(ac.id)) {
        errors.push({
          code: 'acceptance-duplicate-id',
          severity: 'error',
          field: `acceptanceCriteria[${i}].id`,
          message: `duplicate acceptance criterion id "${ac.id}"`,
        });
      }
      seen.add(ac.id);
      if (!ac.text || ac.text.trim().length === 0) {
        errors.push({
          code: 'acceptance-missing-text',
          severity: 'error',
          field: `acceptanceCriteria[${i}].text`,
          message: `acceptance criterion "${ac.id}" needs text`,
        });
      }
    }
  }

  for (let i = 0; i < spec.proposedTemplates.length; i++) {
    const t = spec.proposedTemplates[i]!;
    if (!t.templateId) {
      errors.push({
        code: 'template-missing-id',
        severity: 'error',
        field: `proposedTemplates[${i}].templateId`,
        message: 'each proposed template needs a templateId',
      });
    }
  }
  for (let i = 0; i < spec.verificationCommands.length; i++) {
    const v = spec.verificationCommands[i]!;
    if (!v.id) {
      errors.push({
        code: 'verification-missing-id',
        severity: 'error',
        field: `verificationCommands[${i}].id`,
        message: 'each verification command reference needs an id',
      });
    }
  }

  for (const k of spec.unknownKeys) {
    warnings.push({
      code: 'unknown-frontmatter-key',
      severity: 'warning',
      field: k,
      message: `Unknown frontmatter key "${k}" — preserved but unrecognised`,
    });
  }

  const maxBytes = options.bodyMaxBytes ?? DEFAULT_SPEC_BODY_MAX_BYTES;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > maxBytes) {
    warnings.push({
      code: 'body-too-long',
      severity: 'warning',
      field: 'body',
      message: `spec body is ${bodyBytes} bytes; recommended max is ${maxBytes}. Specs must stay short — force structure.`,
    });
  }

  return { errors, warnings };
}

export function isSpecIdShape(id: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/.test(id);
}

function isIsoTimestamp(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  const t = new Date(s).getTime();
  return Number.isFinite(t);
}
