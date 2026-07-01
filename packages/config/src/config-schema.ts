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
    // Exactly one of pattern / arrayProperty must be set (enforced below).
    pattern: z.string().optional(),
    flags: z.string().optional(),
    arrayProperty: z.string().optional(),
  })
  .strict()
  .superRefine((src, ctx) => {
    const hasPattern = typeof src.pattern === 'string';
    const hasArray = typeof src.arrayProperty === 'string';
    // Exactly one extraction mode: a regex pattern OR a named array literal.
    if (hasPattern === hasArray) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasPattern ? ['arrayProperty'] : ['pattern'],
        message: 'set exactly one of `pattern` or `arrayProperty`',
      });
      return;
    }
    // arrayProperty needs no capture group — only validate a regex pattern.
    if (!hasPattern) return;
    // Catch a bad regex / bad flags at config-load time (clear field location)
    // rather than at runtime. The engine also degrades gracefully, but this
    // surfaces the typo through `shrk doctor` / the loader.
    let re: RegExp | undefined;
    try {
      re = new RegExp(src.pattern!, src.flags ?? '');
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

/**
 * One wiring/completeness rule (see `IWiringRule`).
 *
 * Exported so the inspector's `resolveProjectConfig` seam can validate each
 * pack-contributed element with the EXACT same rules the config loader uses
 * (regex / capture-group / superRefine preserved).
 */
export const WiringRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    severity: z.enum(['error', 'warning']).optional(),
    declared: WiringSourceSchema,
    // A single source or a union array — a token is registered if any source has it.
    registered: z.union([WiringSourceSchema, z.array(WiringSourceSchema)]),
    groupBy: z.enum(['dir', 'package']).optional(),
    mode: z.enum(['subset', 'parity']).optional(),
    hint: z.string().optional(),
    hintDeclaredMissing: z.string().optional(),
    hintRegisteredMissing: z.string().optional(),
  })
  .strict();

/** One declarable registry inventory (see `IRegistryDeclaration`). Exported for the pack-plane merge seam. */
export const RegistryDeclarationSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: WiringSourceSchema,
    consumer: WiringSourceSchema.optional(),
  })
  .strict();

/**
 * One DI/registration idiom (see `IRegistrationIdiom`) — the three-role shape
 * (declared / provided / consumed) the registration graph queries. Exported for
 * the pack-plane merge seam.
 */
export const RegistrationIdiomSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    declared: WiringSourceSchema,
    provided: WiringSourceSchema,
    consumed: WiringSourceSchema,
  })
  .strict();

/** One policy-lint rule (see `IPolicyRule`). Exported for the pack-plane merge seam. */
export const PolicyRuleSchema = z
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

/** One reuse primitive (see `IReusePrimitive`). Exported for the pack-plane merge seam. */
export const ReusePrimitiveSchema = z
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
    // Declarable registry inventories — `shrk registry <name> list|exists|where`.
    registries: z.array(RegistryDeclarationSchema).optional(),
    // DI/registration idioms — the runtime-wiring graph behind
    // `shrk wiring chain|unprovided|orphans`.
    registrationGraph: z.array(RegistrationIdiomSchema).optional(),
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
