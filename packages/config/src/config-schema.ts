import { z } from 'zod';

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
  })
  .strict();

export type SharkCraftConfigInput = z.infer<typeof SharkCraftConfigSchema>;
