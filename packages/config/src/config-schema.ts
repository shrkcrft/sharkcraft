import { z } from 'zod';
import {
  EXTRACTOR_KINDS,
  validateWiringSource,
  type IWiringSource,
} from '@shrkcrft/core';

/**
 * One delegate-worker recipe (see `IDelegateRecipe`).
 *
 * Two disjoint modes. A `patch` recipe (default) carries the write-fence
 * (`guardrailGlobs`/`allowedOps`/`verificationIds`) and no `groundedOn`. An
 * `analysis` recipe is read-only: it carries `groundedOn` and NO write-fence.
 * The write-fence arrays are `.optional()` at the object level and the
 * `superRefine` below enforces the per-mode presence/absence rules — so a
 * malformed recipe fails to LOAD with a clear field path (the richer semantic
 * checks — known grounding id, dangling verification id — live in
 * `validateConfig`, mirroring how `guardrailGlobs` is gated in both places).
 */
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
    mode: z.enum(['patch', 'analysis']).optional(),
    groundedOn: z.string().optional(),
    outputShape: z.string().optional(),
    allowedQueries: z.array(z.string()).optional(),
    maxQueryRounds: z.number().int().min(0).max(4).optional(),
    fanOut: z.boolean().optional(),
    maxFanOut: z.number().int().min(2).max(6).optional(),
    escalateTo: z.string().optional(),
    guardrailGlobs: z.array(z.string()).optional(),
    allowedOps: z.array(z.string()).optional(),
    provider: z.enum(['auto', 'ollama', 'llamacpp']).optional(),
    model: z.string().optional(),
    maxAttempts: z.number().int().positive().optional(),
    maxBudgetMs: z.number().int().positive().optional(),
    riskCeiling: z.enum(['low', 'medium']).optional(),
    verificationIds: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const WRITE_FENCE = ['guardrailGlobs', 'allowedOps', 'verificationIds'] as const;
    if (r.mode === 'analysis') {
      if (r.groundedOn === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groundedOn'],
          message: 'an analysis recipe must declare `groundedOn`',
        });
      }
      // Analysis is read-only — a write-fence field is a category error.
      for (const f of WRITE_FENCE) {
        if (r[f] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f],
            message: `an analysis recipe must NOT declare \`${f}\` (analysis mode never writes)`,
          });
        }
      }
    } else {
      // Patch mode (default): the write-fence is mandatory, grounding invalid.
      if (r.groundedOn !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groundedOn'],
          message: '`groundedOn` is only valid for `mode: "analysis"`',
        });
      }
      for (const f of ['allowedQueries', 'maxQueryRounds', 'fanOut', 'maxFanOut', 'escalateTo'] as const) {
        if (r[f] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f],
            message: `\`${f}\` is only valid for \`mode: "analysis"\``,
          });
        }
      }
      for (const f of WRITE_FENCE) {
        if (r[f] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f],
            message: `a patch recipe must declare \`${f}\``,
          });
        }
      }
    }
  });

/** Author-declared rule expectations (see `IRuleSelfTest`). */
const RuleSelfTestSchema = z
  .object({
    expectMatchesAtLeast: z.number().int().min(0).optional(),
    expectIds: z.array(z.string()).optional(),
    expectNotIds: z.array(z.string()).optional(),
  })
  .strict();

/**
 * One side (declared / registered) of a wiring rule — the extraction DSL.
 *
 * The structural rules (exactly one extraction mode, per-kind required fields,
 * compilable regexes, capture group present) are enforced by
 * `validateWiringSource` in `@shrkcrft/core` rather than re-stated here, so the
 * loader, the pack-merge seam, and the engines cannot drift apart. A rule that
 * LOADS but cannot RUN is exactly the silent-green this plane exists to prevent.
 */
const WiringSourceSchema = z
  .object({
    // Reference a named top-level extractor. When set, `files`/`extract` may be
    // omitted (they come from the named definition) and any field spelled here
    // overrides it — see `resolveExtractorRef` in `@shrkcrft/core`.
    $use: z.string().min(1).optional(),
    files: z.array(z.string()).optional(),
    extract: z.enum(EXTRACTOR_KINDS as unknown as [string, ...string[]]).optional(),
    anchor: z.string().optional(),
    argIndex: z.number().int().min(0).optional(),
    jsonPath: z.string().optional(),
    capture: z.enum(['name', 'value']).optional(),
    capturePath: z.enum(['stem', 'basename', 'regex']).optional(),
    pathPattern: z.string().optional(),
    pathPatternFlags: z.string().optional(),
    emit: z.enum(['edge', 'symbol', 'from']).optional(),
    to: z
      .object({
        module: z.string().optional(),
        modulePattern: z.string().optional(),
        modulePatternFlags: z.string().optional(),
        files: z.array(z.string()).optional(),
        match: z.string().optional(),
        matchFlags: z.string().optional(),
      })
      .strict()
      .optional(),
    match: z.string().optional(),
    matchFlags: z.string().optional(),
    exclude: z.string().optional(),
    excludeFlags: z.string().optional(),
    pattern: z.string().optional(),
    flags: z.string().optional(),
    arrayProperty: z.string().optional(),
  })
  .strict()
  .superRefine((src, ctx) => {
    // A `$use` source is only HALF a source until the named extractor is folded
    // in, so the structural check (one extraction mode, per-kind required
    // fields) cannot run here — it runs on the RESOLVED source in the loader,
    // where the merged shape is real. What can be checked now is checked now:
    // a locally-spelled regex must still compile.
    if (typeof src.$use === 'string') {
      for (const [field, pattern, flags] of [
        ['pattern', src.pattern, src.flags],
        ['match', src.match, src.matchFlags],
        ['exclude', src.exclude, src.excludeFlags],
      ] as const) {
        if (typeof pattern !== 'string') continue;
        try {
          new RegExp(pattern, flags ?? '');
        } catch (e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `invalid regular expression: ${(e as Error).message}`,
          });
        }
      }
      return;
    }
    const problem = validateWiringSource(src as IWiringSource);
    if (problem === undefined) return;
    // Point at the most specific field the message is about, so the loader
    // error lands on the line the author has to change.
    const path = problem.startsWith('match ')
      ? ['match']
      : problem.startsWith('pathPattern') || problem.includes('`pathPattern`')
        ? ['pathPattern']
      : problem.startsWith('to.modulePattern')
        ? ['to', 'modulePattern']
      : problem.startsWith('to.match')
        ? ['to', 'match']
      : problem.includes('`to` selector')
        ? ['to']
      : problem.startsWith('exclude ')
        ? ['exclude']
      : problem.includes('capture group') || problem.includes('invalid regular expression')
        ? ['pattern']
        : problem.includes('`anchor`')
          ? ['anchor']
          : problem.includes('`jsonPath`')
            ? ['jsonPath']
            : problem.includes('`argIndex`')
              ? ['argIndex']
              : problem.includes('`files`')
                ? ['files']
                : ['extract'];
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: problem });
  });

/**
 * A NAMED extractor in the top-level `extractors` map.
 *
 * Identical to an inline source except that it may not itself `$use` another
 * one: a chain of aliases would make "which files does this rule actually
 * scan?" a graph traversal instead of a lookup, and that question has to stay
 * answerable at a glance. One level, always resolvable, no cycles possible.
 */
export const ExtractorDefinitionSchema = WiringSourceSchema.superRefine((src, ctx) => {
  if (typeof (src as { $use?: unknown }).$use === 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['$use'],
      message:
        'a named extractor cannot `$use` another extractor — define its selector inline so every consumer resolves in one hop',
    });
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
    declared: WiringSourceSchema.optional(),
    // A single source or a union array — combined per `registeredMode`.
    registered: z.union([WiringSourceSchema, z.array(WiringSourceSchema)]).optional(),
    // Multi-hop: hop0 ⊆ hop1 ⊆ … — mutually exclusive with declared/registered.
    chain: z.array(WiringSourceSchema).optional(),
    registeredMode: z.enum(['union', 'intersection']).optional(),
    groupBy: z.enum(['dir', 'package']).optional(),
    mode: z.enum(['subset', 'parity', 'disjoint']).optional(),
    message: z.string().optional(),
    failOnEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
    hint: z.string().optional(),
    hintDeclaredMissing: z.string().optional(),
    hintRegisteredMissing: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const hasChain = Array.isArray(rule.chain) && rule.chain.length > 0;
    const hasClassic = rule.declared !== undefined || rule.registered !== undefined;
    if (hasChain && hasClassic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chain'],
        message: '`chain` is mutually exclusive with `declared`/`registered`',
      });
      return;
    }
    if (hasChain) {
      if (rule.chain!.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chain'],
          message: '`chain` needs at least 2 hops',
        });
      }
      if (rule.mode !== undefined && rule.mode !== 'subset') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mode'],
          message: `\`mode: ${rule.mode}\` is not supported on a chain rule (each hop is a subset relation)`,
        });
      }
      return;
    }
    if (rule.declared === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declared'],
        message: 'set `declared` (or use `chain`)',
      });
    }
    if (rule.registered === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['registered'],
        message: 'set `registered` (or use `chain`)',
      });
    }
  });

/** One declarable registry inventory (see `IRegistryDeclaration`). Exported for the pack-plane merge seam. */
export const RegistryDeclarationSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: WiringSourceSchema,
    consumer: WiringSourceSchema.optional(),
    // Human-noun → canonical-id synonym map for `exists <id> --resolve`.
    aliases: z.record(z.string(), z.string()).optional(),
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
    scan: z.enum(['all', 'code', 'strings', 'comments']).optional(),
    exemptFiles: z.array(z.string()).optional(),
    exemptLines: z.string().optional(),
    failOnEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
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

/**
 * One baseline / ledger drift rule (see `IBaselineRule`). Exported for the
 * pack-plane merge seam — which DROPS any pack-contributed rule whose compute
 * is a shell command (see `resolveProjectConfig`), mirroring the
 * "pack-contributed verification commands are NOT auto-run" contract.
 */
export const BaselineRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    baseline: z.string(),
    compute: z
      .object({
        kind: z.enum(['command', 'extractor']),
        run: z.string().optional(),
        source: WiringSourceSchema.optional(),
        canonical: z
          .enum(['auto', 'json-sorted-keys', 'lines-sorted', 'lines', 'raw'])
          .optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .superRefine((c, ctx) => {
        if (c.kind === 'command') {
          if (!c.run || c.run.trim() === '') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['run'],
              message: 'a `command` compute must set `run`',
            });
          }
          if (c.source !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['source'],
              message: '`source` is only valid for `kind: "extractor"`',
            });
          }
          return;
        }
        if (c.source === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['source'],
            message: 'an `extractor` compute must set `source`',
          });
        }
        if (c.run !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['run'],
            message: '`run` is only valid for `kind: "command"` (an extractor never spawns)',
          });
        }
      }),
    direction: z.enum(['two-way', 'additions-only', 'no-shrink']).optional(),
    keyBy: z.string().optional(),
    watchFiles: z.array(z.string()).optional(),
    failOnEmpty: z.boolean().optional(),
    expectEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
    severity: z.enum(['error', 'warning']).optional(),
    hint: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.expectEmpty === true && rule.failOnEmpty === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectEmpty'],
        message:
          'sets both `expectEmpty` and `failOnEmpty` — they assert opposite things about an empty result',
      });
    }
  });

/**
 * One generated-artifact drift/provenance rule (see `IGeneratedArtifactRule`).
 * Exported for the pack-plane merge seam — which DROPS any pack-contributed
 * rule that declares a `regen` command (a header-only pack rule still merges).
 */
export const GeneratedArtifactRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    generatedGlob: z.array(z.string()).min(1),
    regen: z.string().optional(),
    sources: z
      .array(
        z
          .object({
            id: z.string().optional(),
            regen: z.string(),
            glob: z.array(z.string()).min(1),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    handMaintained: z.array(z.string()).optional(),
    handMaintainedMarker: z.string().min(1).optional(),
    handMaintainedMarkerFlags: z.string().optional(),
    compare: z.enum(['bytes', 'normalized-whitespace']).optional(),
    provenanceHeader: z
      .object({
        mustMatch: z.string(),
        flags: z.string().optional(),
        withinLines: z.number().int().positive().optional(),
        forbidOutside: z.boolean().optional(),
        outsideGlob: z.array(z.string()).optional(),
        pointsToRegenCommand: z.boolean().optional(),
      })
      .strict()
      .superRefine((h, ctx) => {
        try {
          new RegExp(h.mustMatch, h.flags ?? '');
        } catch (e) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['mustMatch'],
            message: `invalid regular expression: ${(e as Error).message}`,
          });
        }
      })
      .optional(),
    failOnEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
    severity: z.enum(['error', 'warning']).optional(),
    timeoutMs: z.number().int().positive().optional(),
    hint: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.regen === undefined && rule.provenanceHeader === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regen'],
        message:
          'a generated-artifact rule must set `regen` (drift check), `provenanceHeader` (header check), or both — otherwise it checks nothing',
      });
    }
    if (rule.regen !== undefined && !rule.regen.includes('{TMP}')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regen'],
        message:
          '`regen` must contain the `{TMP}` placeholder — the engine regenerates into a temp dir and diffs, it never overwrites the tree to check it',
      });
    }
    if (rule.regen !== undefined && rule.sources !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message:
          'sets both `regen` and `sources` — a rule is either single-writer (`regen`) or multi-writer (`sources`), never both',
      });
    }
    rule.sources?.forEach((src, i) => {
      if (!src.regen.includes('{TMP}')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', i, 'regen'],
          message:
            '`regen` must contain the `{TMP}` placeholder — each writer regenerates into a temp dir and diffs its own slice',
        });
      }
    });
    if (rule.handMaintainedMarker !== undefined) {
      try {
        new RegExp(rule.handMaintainedMarker, rule.handMaintainedMarkerFlags ?? '');
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['handMaintainedMarker'],
          message: `invalid regular expression: ${(e as Error).message}`,
        });
      }
      // The marker exempts a file from the header check, so a marker the
      // GENERATED header would also satisfy lets every generated file exempt
      // itself — silently disabling the rule it was added to refine. Overlap in
      // either direction is refused at load rather than discovered as a
      // permanently-green gate.
      const header = rule.provenanceHeader?.mustMatch;
      if (header !== undefined) {
        const overlaps =
          header === rule.handMaintainedMarker ||
          header.includes(rule.handMaintainedMarker) ||
          rule.handMaintainedMarker.includes(header);
        if (overlaps) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['handMaintainedMarker'],
            message:
              `"${rule.handMaintainedMarker}" overlaps \`provenanceHeader.mustMatch\` ` +
              `("${header}") — a generated file's own header would then exempt it from the header check`,
          });
        }
      }
    }
    // A hand-maintained bless must name ONE file. A wildcard basename would
    // silently absorb every future file dropped into the directory, converting
    // a reviewed per-file exemption into a blanket opt-out that makes the whole
    // rule pass without checking anything.
    rule.handMaintained?.forEach((pattern, i) => {
      const base = pattern.split('/').pop() ?? '';
      if (base.includes('*') || base.includes('?')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['handMaintained', i],
          message:
            `"${pattern}" wildcards the FILENAME — a hand-maintained entry must name one file (leading \`**/\` is fine) ` +
            'so the exemption set cannot silently grow as files are added',
        });
      }
    });
  });

/**
 * One doc-reference rule (see `IDocReferenceRule`). Exported for the pack-plane
 * merge seam — this plane spawns nothing, so a pack may contribute one freely.
 */
export const DocReferenceRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    files: z.array(z.string()).min(1),
    tokenPattern: z.string().min(1),
    tokenPatternFlags: z.string().optional(),
    resolvesAs: z
      .array(
        z.enum([
          'template',
          'pipeline',
          'playbook',
          'command',
          'policy',
          'construct',
          'helper',
          'boundary-rule',
          'path-convention',
        ]),
      )
      .min(1),
    requireContext: z.enum(['backtick', 'off', 'after']).optional(),
    afterWords: z.array(z.string()).optional(),
    exempt: z.array(z.string()).optional(),
    exemptMarker: z.string().min(1).optional(),
    failOnEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
    severity: z.enum(['error', 'warning']).optional(),
    hint: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    try {
      new RegExp(rule.tokenPattern, rule.tokenPatternFlags ?? '');
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenPattern'],
        message: `invalid regular expression: ${(e as Error).message}`,
      });
    }
    // `after` without cue words matches nothing, forever — a rule that can only
    // ever be a loud skip is a bug in the rule, so it fails at load instead.
    if (rule.requireContext === 'after' && (rule.afterWords?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['afterWords'],
        message:
          '`requireContext: "after"` requires `afterWords` — without cue words no token could ever qualify',
      });
    }
    if (rule.requireContext !== 'after' && (rule.afterWords?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['afterWords'],
        message: '`afterWords` only applies with `requireContext: "after"`',
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
    // Named, reusable extraction selectors referenced by `{ $use: "<id>" }`
    // from any plane. One definition, N consumers — the planes describing the
    // same id set cannot drift apart.
    extractors: z.record(z.string().min(1), ExtractorDefinitionSchema).optional(),
    // Wiring/completeness rules — the "declared but not wired" plane.
    wiringRules: z.array(WiringRuleSchema).optional(),
    // Declarable registry inventories — `shrk registry <name> list|exists|where`.
    registries: z.array(RegistryDeclarationSchema).optional(),
    // DI/registration idioms — the runtime-wiring graph behind
    // `shrk wiring chain|unprovided|orphans`.
    registrationGraph: z.array(RegistrationIdiomSchema).optional(),
    // Policy-lint rules — the template/style/ts content plane.
    policyRules: z.array(PolicyRuleSchema).optional(),
    // Baseline/ledger drift rules — `shrk baseline check|diff|update`.
    baselines: z.array(BaselineRuleSchema).optional(),
    // Generated-artifact drift + provenance rules — `shrk generated check`.
    generatedArtifacts: z.array(GeneratedArtifactRuleSchema).optional(),
    // Prose-reference rules — `shrk docs references check`. Ids cited in
    // free text (READMEs, docs, agent skill files) must still resolve.
    docReferences: z.array(DocReferenceRuleSchema).optional(),
    // Reuse primitives — role-keyed canonical symbols for `shrk reuse`.
    reusePrimitives: z.array(ReusePrimitiveSchema).optional(),
    // registry-lifecycle scan tuning. `skipDirs` OVERRIDES the default
    // source-only skip set so a repo that registers code under tools/ / a
    // non-standard root isn't silently blinded by a baked-in exclusion.
    registryLifecycle: z
      .object({
        skipDirs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
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
