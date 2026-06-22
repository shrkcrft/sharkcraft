import { z } from 'zod';

/** One delegate-worker recipe (see `IDelegateRecipe`). */
const DelegateRecipeSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    match: z
      .object({
        keywords: z.array(z.string()).optional(),
        fileGlobs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    guardrailGlobs: z.array(z.string()),
    allowedOps: z.array(z.string()),
    provider: z.enum(['auto', 'ollama', 'llamacpp']).optional(),
    model: z.string().optional(),
    maxAttempts: z.number().int().positive().optional(),
    maxBudgetMs: z.number().int().positive().optional(),
    riskCeiling: z.enum(['low', 'medium']).optional(),
    verificationIds: z.array(z.string()),
  })
  .strict();

/**
 * Zod schema for sharkcraft.config.ts. Used by the loader and the doctor to
 * surface clear errors for malformed configs. We don't replace ISharkCraftConfig
 * with the inferred type because hand-written interfaces document intent better.
 */
export const SharkCraftConfigSchema = z
  .object({
    projectName: z.string().optional(),
    description: z.string().optional(),
    sharkcraftDir: z.string().optional(),
    knowledgeFiles: z.array(z.string()).optional(),
    docsFiles: z.array(z.string()).optional(),
    ruleFiles: z.array(z.string()).optional(),
    pathFiles: z.array(z.string()).optional(),
    templateFiles: z.array(z.string()).optional(),
    pipelineFiles: z.array(z.string()).optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    defaultScope: z.array(z.string()).optional(),
    actionHintDiagnostics: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Local registry extensions consumed by the inspector.
    presetFiles: z.array(z.string()).optional(),
    boundaryFiles: z.array(z.string()).optional(),
    contextTestFiles: z.array(z.string()).optional(),
    agentTestFiles: z.array(z.string()).optional(),
    // Verification commands available to `shrk apply --validate --verification`.
    verificationCommands: z
      .array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          command: z.string(),
          trusted: z.boolean().optional(),
        }),
      )
      .optional(),
    // Adaptive surface gating.
    surface: z
      .object({
        // Named profile (built-in or pack-contributed).
        // Profile.hidden + profile.enabled merge with the explicit
        // arrays below (config wins on conflicts).
        profile: z.string().optional(),
        enabled: z.array(z.string()).optional(),
        hidden: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // Local usage log opt-out (default: enabled).
    usage: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Local-LLM delegate worker (see `shrk delegate`).
    delegation: z
      .object({
        enabled: z.boolean().optional(),
        provider: z.enum(['auto', 'ollama', 'llamacpp']).optional(),
        model: z.string().optional(),
        recipes: z.array(DelegateRecipeSchema).optional(),
        recipeOverrides: z
          .record(
            z.string(),
            z
              .object({
                model: z.string().optional(),
                verificationIds: z.array(z.string()).optional(),
                guardrailGlobs: z.array(z.string()).optional(),
                enabled: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SharkCraftConfigInput = z.infer<typeof SharkCraftConfigSchema>;
