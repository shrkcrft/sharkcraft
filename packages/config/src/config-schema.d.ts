import { z } from 'zod';
/**
 * Zod schema for sharkcraft.config.ts. Used by the loader and the doctor to
 * surface clear errors for malformed configs. We don't replace ISharkCraftConfig
 * with the inferred type because hand-written interfaces document intent better.
 */
export declare const SharkCraftConfigSchema: z.ZodObject<{
    projectName: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    sharkcraftDir: z.ZodOptional<z.ZodString>;
    knowledgeFiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    docsFiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    ruleFiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pathFiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    templateFiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultMaxTokens: z.ZodOptional<z.ZodNumber>;
    defaultScope: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export type SharkCraftConfigInput = z.infer<typeof SharkCraftConfigSchema>;
//# sourceMappingURL=config-schema.d.ts.map