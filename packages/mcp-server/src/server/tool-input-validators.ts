import { z } from 'zod';
import { ContributionKind, ProfileKind } from '@shrkcrft/inspector';

/**
 * Zod schemas for MCP tool inputs that have structured arguments. The schemas
 * are intentionally narrow: they exist to give MCP clients clear errors when
 * arguments are malformed, not to replicate the JSON Schema we advertise.
 */
const createGenerationPlanSchema = z
  .object({
    templateId: z.string().min(1, 'templateId is required'),
    name: z.string().optional(),
    variables: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const renderTemplatePreviewSchema = createGenerationPlanSchema;

const explainGenerationTargetSchema = z
  .object({
    templateId: z.string().min(1, 'templateId is required'),
    name: z.string().optional(),
    variables: z.record(z.string(), z.string()).optional(),
    task: z.string().optional(),
  })
  .strict();

const getKnowledgeSchema = z.object({ id: z.string().min(1) }).strict();
const getRuleSchema = z.object({ id: z.string().min(1) }).strict();
const getPathConventionSchema = z.object({ id: z.string().min(1) }).strict();
const getTemplateSchema = z.object({ id: z.string().min(1) }).strict();

const searchTemplatesSchema = z.object({ query: z.string() }).strict();

const getRelevantContextSchema = z
  .object({
    task: z.string().min(1, 'task is required'),
    framework: z.string().optional(),
    area: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.array(z.string()).optional(),
    maxTokens: z.number().int().min(100).optional(),
    includeExamples: z.boolean().optional(),
    includeTemplates: z.boolean().optional(),
    includeRules: z.boolean().optional(),
    includePaths: z.boolean().optional(),
    includeDocs: z.boolean().optional(),
    compact: z.boolean().optional(),
  })
  .strict();

const getRelevantRulesSchema = z
  .object({
    task: z.string().min(1, 'task is required'),
    scope: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    appliesWhen: z.array(z.string()).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

const getActionHintsSchema = z
  .object({
    task: z.string().optional(),
    entryIds: z.array(z.string()).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

const getPipelineSchema = z.object({ id: z.string().min(1) }).strict();
const getPackSchema = z.object({ packageName: z.string().min(1) }).strict();
const createPipelinePlanSchema = z
  .object({
    id: z.string().min(1),
    task: z.string().min(1),
    inputs: z.record(z.string(), z.string()).optional(),
    includeOptional: z.array(z.string()).optional(),
    includeScript: z.boolean().optional(),
  })
  .strict();

const getPipelineContextSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
    task: z.string().min(1, 'task is required'),
    maxTokens: z.number().int().min(100).optional(),
    scope: z.array(z.string()).optional(),
  })
  .strict();

const compressContextSchema = z
  .object({
    content: z.string().min(1, 'content is required'),
    contentType: z.string().optional(),
    query: z.string().optional(),
    maxItems: z.number().int().min(1).optional(),
    // Arms the lossy SmartCrusher row-sampler for oversized homogeneous arrays.
    // Must mirror the tool's inputSchema, or the strict validator rejects the
    // call on the real MCP wire before the handler ever runs.
    maxTokens: z.number().int().min(1).optional(),
  })
  .strict();

const retrieveOriginalSchema = z.object({ key: z.string().min(1, 'key is required') }).strict();

const alignCacheSchema = z
  .object({ content: z.string().min(1, 'content is required'), map: z.unknown().optional() })
  .strict();

const restoreCacheSchema = z
  .object({ content: z.string(), map: z.unknown() })
  .strict();

const getKnowledgeGraphSchema = z
  .object({
    format: z.enum(['json', 'table']).optional(),
    // Mirrors the tool's inputSchema (P5.2). Must stay in lockstep, or the
    // schema-parity guard (schema-parity.test.ts) turns red.
    maxTokens: z.number().int().min(1).optional(),
  })
  .strict();

// deps_audit advertises package/format/maxTokens; validate them on the wire so
// the new lossy `maxTokens` budget can't be armed with a bad value (P5.2/P1.3).
const depsAuditSchema = z
  .object({
    package: z.string().optional(),
    format: z.enum(['json', 'table']).optional(),
    maxTokens: z.number().int().min(1).optional(),
  })
  .strict();

// get_self_config_doctor advertises `schema: 'v1' | 'v2'` — mirrored here, or
// the strict wire validator rejects the documented input (schema-parity guard).
const getSelfConfigDoctorSchema = z
  .object({ schema: z.enum(['v1', 'v2']).optional() })
  .strict();

// list_profiles / get_profile advertise `kind` as the ProfileKind enum —
// mirrored here (round 12), so an unknown kind is rejected on the wire instead
// of silently listing every kind.
const profileKindSchema = z.enum(Object.values(ProfileKind) as [ProfileKind, ...ProfileKind[]]);
const listProfilesSchema = z.object({ kind: profileKindSchema.optional() }).strict();
const getProfileSchema = z
  .object({ id: z.string().min(1, 'id is required'), kind: profileKindSchema.optional() })
  .strict();

// get_pack_contributions advertises `kind` as the ContributionKind enum —
// mirrored here (round 12 review, A-1), so an unknown kind is rejected on the
// wire instead of narrowing the report to nothing.
const getPackContributionsSchema = z
  .object({
    pack: z.string().optional(),
    kind: z.enum(Object.values(ContributionKind) as [ContributionKind, ...ContributionKind[]]).optional(),
  })
  .strict();

export const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  get_self_config_doctor: getSelfConfigDoctorSchema,
  list_profiles: listProfilesSchema,
  get_profile: getProfileSchema,
  get_pack_contributions: getPackContributionsSchema,
  create_generation_plan: createGenerationPlanSchema,
  render_template_preview: renderTemplatePreviewSchema,
  explain_generation_target: explainGenerationTargetSchema,
  get_knowledge: getKnowledgeSchema,
  get_rule: getRuleSchema,
  get_path_convention: getPathConventionSchema,
  get_template: getTemplateSchema,
  search_templates: searchTemplatesSchema,
  get_relevant_context: getRelevantContextSchema,
  get_relevant_rules: getRelevantRulesSchema,
  get_action_hints: getActionHintsSchema,
  get_pipeline: getPipelineSchema,
  get_pipeline_context: getPipelineContextSchema,
  get_pack: getPackSchema,
  create_pipeline_plan: createPipelinePlanSchema,
  compress_context: compressContextSchema,
  retrieve_original: retrieveOriginalSchema,
  align_cache: alignCacheSchema,
  restore_cache: restoreCacheSchema,
  get_knowledge_graph: getKnowledgeGraphSchema,
  deps_audit: depsAuditSchema,
  // Round 13 (lane B): check_boundaries takes `failOnDeadUnits` beside its
  // original `ruleId` — both declared, or the strict schema would reject the
  // tool's only pre-existing input on the wire.
  check_boundaries: z
    .object({ ruleId: z.string().optional(), failOnDeadUnits: z.boolean().optional() })
    .strict(),
});

export interface IToolValidationFailure {
  toolName: string;
  message: string;
  issues: { path: string; message: string }[];
}

export function validateToolInput(
  toolName: string,
  input: unknown,
): { ok: true; data: unknown } | { ok: false; failure: IToolValidationFailure } {
  const schema = TOOL_INPUT_SCHEMAS[toolName];
  if (!schema) return { ok: true, data: input };
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    failure: {
      toolName,
      message: parsed.error.issues
        .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
        .join('; '),
      issues: parsed.error.issues.map((iss) => ({
        path: iss.path.join('.'),
        message: iss.message,
      })),
    },
  };
}
