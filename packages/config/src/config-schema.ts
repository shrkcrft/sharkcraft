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

/** One side (declared / registered) of a wiring rule. */
const WiringSourceSchema = z
  .object({
    files: z.array(z.string()),
    pattern: z.string(),
    flags: z.string().optional(),
  })
  .strict()
  .superRefine((src, ctx) => {
    // Catch a bad regex / bad flags at config-load time (clear field location)
    // rather than at runtime. The engine also degrades gracefully, but this
    // surfaces the typo through `shrk doctor` / the loader.
    let re: RegExp | undefined;
    try {
      re = new RegExp(src.pattern, src.flags ?? '');
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: `invalid regular expression: ${(e as Error).message}`,
      });
      return;
    }
    // Group 1 is the token contract — a pattern with no capture group matches
    // nothing useful and would silently pass.
    try {
      const groups = (new RegExp(re.source + '|').exec('')?.length ?? 1) - 1;
      if (groups < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pattern'],
          message: 'pattern must contain at least one capture group (group 1 captures the token)',
        });
      }
    } catch {
      // Can't determine group count — don't block.
    }
  });

/** One wiring/completeness rule (see `IWiringRule`). */
const WiringRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    severity: z.enum(['error', 'warning']).optional(),
    declared: WiringSourceSchema,
    registered: WiringSourceSchema,
    hint: z.string().optional(),
  })
  .strict();

/** One policy-lint rule (see `IPolicyRule`). */
const PolicyRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    surface: z.enum(['template', 'style', 'ts']),
    files: z.array(z.string()).optional(),
    pattern: z.string(),
    flags: z.string().optional(),
    message: z.string(),
    suggest: z.string().optional(),
    severity: z.enum(['error', 'warning']).optional(),
  })
  .strict()
  .superRefine((src, ctx) => {
    try {
      new RegExp(src.pattern, src.flags ?? '');
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: `invalid regular expression: ${(e as Error).message}`,
      });
    }
  });

/** One reuse primitive (see `IReusePrimitive`). */
const ReusePrimitiveSchema = z
  .object({
    symbol: z.string(),
    roles: z.array(z.string()),
    importPath: z.string().optional(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
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
    // Wiring/completeness rules — the "declared but not wired" plane.
    wiringRules: z.array(WiringRuleSchema).optional(),
    // Policy-lint rules — the template/style/ts content plane.
    policyRules: z.array(PolicyRuleSchema).optional(),
    // Reuse primitives — role-keyed canonical symbols for `shrk reuse`.
    reusePrimitives: z.array(ReusePrimitiveSchema).optional(),
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
