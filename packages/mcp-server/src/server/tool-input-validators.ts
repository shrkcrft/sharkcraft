import { z } from 'zod';

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

export const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
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
