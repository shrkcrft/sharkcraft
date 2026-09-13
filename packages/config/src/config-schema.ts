import { z } from 'zod';
import {
  AreaKind,
  EXTRACTOR_KINDS,
  exemptionListProblem,
  globListProblem,
  markedListFailOnEmptyConflict,
  normalizeUnitList,
  normalizeWiringSource,
  SCAN_ZONES,
  unitListProblems,
  validateWiringSource,
  type IWiringSourceInput,
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
 *
 * Exported (round 12, 12.1): a PACK-contributed recipe is validated by this
 * same schema (`delegateRecipeRejectionReasons`, @shrkcrft/inspector), so an
 * inline recipe and a pack one are refused for the same reasons.
 */
export const DelegateRecipeSchema = z
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
 * The lexical `scan` zone, spelled from the shared `SCAN_ZONES` list rather
 * than re-typed per plane. Two hand-written enums are how the policy plane and
 * the extraction DSL would end up accepting different zone names.
 */
const ScanZoneSchema = z.enum(SCAN_ZONES as unknown as [string, ...string[]]);

/**
 * A gate-plane glob list's SHAPE, judged by core's `globListProblem` (the
 * companion of the one `!` parser): a bare `!`, a `!!x`, or a list of
 * negations only. Each used to load and select nothing — a rule that could
 * never enforce anything — so each fails at load, on the field the author has
 * to change. An empty list is left to the field's own rule.
 */
function refineGlobList(
  ctx: z.RefinementCtx,
  globs: readonly string[] | undefined,
  path: (string | number)[],
): void {
  if (globs === undefined || globs.length === 0) return;
  const problem = globListProblem(globs);
  if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: problem });
}

/**
 * An EXEMPTION list (policy `exemptFiles`, generated `handMaintained`) takes
 * plain globs: a `!` there would read as "exempt everything else", which no
 * engine implements and no author means.
 */
function refineExemptionList(
  ctx: z.RefinementCtx,
  globs: readonly string[] | undefined,
  path: (string | number)[],
): void {
  if (globs === undefined) return;
  const problem = exemptionListProblem(globs);
  if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: problem });
}

/**
 * A MARKABLE list (round 13, docs/intended-empty.md): each entry is a glob, or
 * `{ pattern, expectEmpty: true, reason? }` asserting that the unit's target
 * does not exist yet. Every entry is judged by core's one parser
 * (`unitListProblems`), so a malformed marker is refused here — at load, exit
 * 3 for the local config, an ERRORED row for a pack element — with the same
 * `<listPath>[i]: …` sentence on every path. The glob SHAPE rules
 * (`globListProblem`) run on the normalised units, by the field's owner
 * ({@link markableUnits}), so `{ pattern: '!' }` is refused exactly like `'!'`.
 */
function markableList(listPath: string, minLength = 0): z.ZodType<readonly unknown[]> {
  return z
    .array(z.unknown())
    .min(minLength)
    .superRefine((list, ctx) => {
      for (const message of unitListProblems(list, listPath)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    });
}

/**
 * The plain units of a markable list, or `undefined` when the list is absent
 * or holds a malformed marker ({@link markableList} already reported it). A
 * parent refinement runs even when a list's marker check failed (the issue is
 * continuable), so it must read the list through this — never cast it.
 */
function markableUnits(list: unknown): readonly string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const n = normalizeUnitList(list, 'list');
  return n.ok ? n.value.units : undefined;
}

/**
 * THE load-time conflict between a rule's `failOnEmpty: true` and its PRIMARY
 * list having every inclusion unit marked `expectEmpty`
 * (`markedListFailOnEmptyConflict`, core): the markers say the empty result is
 * intended, `failOnEmpty` says it is a failure. Partial marking is legal, and
 * the DEFAULT failOnEmpty of an error rule is never a conflict.
 */
function refineMarkedFailOnEmpty(
  ctx: z.RefinementCtx,
  list: unknown,
  listPath: string,
  failOnEmpty: boolean | undefined,
): void {
  if (failOnEmpty !== true || !Array.isArray(list)) return;
  const n = normalizeUnitList(list, listPath);
  if (!n.ok) return;
  const problem = markedListFailOnEmptyConflict(n.value, listPath, failOnEmpty);
  if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failOnEmpty'], message: problem });
}

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
    files: markableList('files').optional(),
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
        files: markableList('to.files').optional(),
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
    scan: ScanZoneSchema.optional(),
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
      // A locally spelled glob list REPLACES the extractor's, so its shape can
      // be judged standalone — here, where a pack element's schema check (the
      // merge seam, `packs test --load`) sees it too (round 12 review, R12-X3).
      // Judged on the NORMALISED units (round 13): a marker's pattern is a
      // unit of its list; a malformed marker was already reported on the list.
      for (const [path, globs, label] of [
        [['files'], markableUnits(src.files), '`files`'],
        [['to', 'files'], markableUnits(src.to?.files), '`to.files`'],
      ] as const) {
        if (globs === undefined || globs.length === 0) continue;
        const problem = globListProblem(globs);
        if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: `${label} ${problem}` });
      }
      return;
    }
    // The structural check runs on the NORMALISED source (round 13): a
    // marker's pattern is a glob of its list, never an object handed to a glob
    // reader; a malformed marker was already reported on its list.
    const normalized = normalizeWiringSource(src as IWiringSourceInput);
    if (!normalized.ok) return;
    const problem = validateWiringSource(normalized.value);
    if (problem === undefined) return;
    // Point at the most specific field the message is about, so the loader
    // error lands on the line the author has to change.
    const path = problem.startsWith('match ')
      ? ['match']
      : problem.startsWith('pathPattern') || problem.includes('`pathPattern`')
        ? ['pathPattern']
      : problem.startsWith('`to.files`')
        ? ['to', 'files']
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
    // Subset only: registered tokens the declared selector is known NOT to
    // produce, accepted explicitly (literal ids, or 'allow'). Without it such a
    // token is a coverage shortfall — the rule reads `partial`, exit 2.
    registeredExtras: z.union([z.literal('allow'), z.array(z.string())]).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const hasChain = Array.isArray(rule.chain) && rule.chain.length > 0;
    const hasClassic = rule.declared !== undefined || rule.registered !== undefined;
    // Round 13: the PRIMARY source (the declared side, or chain[0]) may not
    // mark every inclusion glob `expectEmpty` while `failOnEmpty: true` asserts
    // the opposite. A `$use` source's markers arrive with the merge, so its
    // conflict is judged after resolution (`validateResolvedPlaneSources`).
    refineMarkedFailOnEmpty(
      ctx,
      (hasChain ? rule.chain?.[0] : rule.declared)?.files,
      hasChain ? 'chain[0].files' : 'declared.files',
      rule.failOnEmpty,
    );
    if (
      rule.registeredExtras !== undefined &&
      (hasChain || (rule.mode !== undefined && rule.mode !== 'subset'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['registeredExtras'],
        message:
          '`registeredExtras` applies only to a classic subset rule — parity reports registered-only tokens as violations, and disjoint / chain rules never examine them',
      });
    }
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
    selfTest: RuleSelfTestSchema.optional(),
    // A source matching 0 ids fails (1) instead of reading not-verified (2).
    failOnEmpty: z.boolean().optional(),
  })
  .strict()
  // Round 13: every inclusion glob of the source marked expectEmpty while
  // failOnEmpty: true asserts the opposite (an inline `files`; a `$use` one is
  // judged after resolution).
  .superRefine((decl, ctx) => refineMarkedFailOnEmpty(ctx, decl.source?.files, 'source.files', decl.failOnEmpty));

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
    selfTest: RuleSelfTestSchema.optional(),
    // A graph matching 0 tokens fails (1) instead of reading not-verified (2).
    failOnEmpty: z.boolean().optional(),
  })
  .strict()
  // Round 13: the declared role (the primary selector) fully marked
  // expectEmpty contradicts failOnEmpty: true.
  .superRefine((idiom, ctx) =>
    refineMarkedFailOnEmpty(ctx, idiom.declared?.files, 'declared.files', idiom.failOnEmpty),
  );

/** One policy-lint rule (see `IPolicyRule`). Exported for the pack-plane merge seam. */
export const PolicyRuleSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    surface: z.enum(['template', 'style', 'ts']),
    files: markableList('files').optional(),
    pattern: z.string(),
    flags: z.string().optional(),
    scan: ScanZoneSchema.optional(),
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
    // `files` `!` EXCLUDES; `exemptFiles` MARKS and takes plain globs. A
    // negation-only `files` is rejected, never read as "the surface defaults
    // minus these" — one syntax, one meaning, on every plane.
    refineGlobList(ctx, markableUnits(src.files), ['files']);
    refineExemptionList(ctx, src.exemptFiles, ['exemptFiles']);
    refineMarkedFailOnEmpty(ctx, src.files, 'files', src.failOnEmpty);
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
    baseline: z.string().optional(),
    mode: z.enum(['ledger', 'ceiling']).optional(),
    ceiling: z.number().optional(),
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
    direction: z
      .enum(['two-way', 'additions-only', 'no-shrink', 'at-most', 'at-least'])
      .optional(),
    keyBy: z.string().optional(),
    watchFiles: markableList('watchFiles').optional(),
    failOnEmpty: z.boolean().optional(),
    expectEmpty: z.boolean().optional(),
    selfTest: RuleSelfTestSchema.optional(),
    severity: z.enum(['error', 'warning']).optional(),
    hint: z.string().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    // The two modes take DISJOINT vocabularies. Accepting a ledger `direction`
    // on a ceiling rule (or vice versa) would silently fall back to that mode's
    // default and check something the author never asked for — the shape of
    // every silent-green this plane exists to prevent.
    const isCeiling = rule.mode === 'ceiling';
    const NUMERIC = ['at-most', 'at-least'];
    if (isCeiling) {
      if (rule.ceiling === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ceiling'],
          message: 'a `ceiling` baseline must declare its `ceiling` limit',
        });
      }
      if (rule.baseline !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseline'],
          message:
            'a `ceiling` baseline has no committed artifact — its pinned value IS `ceiling`, so a second place to look would be a second authority',
        });
      }
      if (rule.direction !== undefined && !NUMERIC.includes(rule.direction)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['direction'],
          message: `\`direction: "${rule.direction}"\` is a LEDGER direction — a ceiling takes "at-most" or "at-least"`,
        });
      }
      if (rule.keyBy !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keyBy'],
          message: '`keyBy` compares entries by key — a ceiling compares one number',
        });
      }
    } else {
      if (rule.baseline === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseline'],
          message: 'a ledger baseline must name its committed `baseline` artifact',
        });
      }
      if (rule.ceiling !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ceiling'],
          message: '`ceiling` requires `mode: "ceiling"`',
        });
      }
      if (rule.direction !== undefined && NUMERIC.includes(rule.direction)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['direction'],
          message: `\`direction: "${rule.direction}"\` is a CEILING direction — a ledger takes "two-way", "additions-only" or "no-shrink"`,
        });
      }
    }
    if (rule.expectEmpty === true && rule.failOnEmpty === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectEmpty'],
        message:
          'sets both `expectEmpty` and `failOnEmpty` — they assert opposite things about an empty result',
      });
    }
    refineGlobList(ctx, markableUnits(rule.watchFiles), ['watchFiles']);
    // Round 13: the rule's primary INPUT list fully marked expectEmpty
    // contradicts failOnEmpty: true — the extractor compute's `source.files`,
    // or a command compute's `watchFiles` probe. (`expectEmpty: true` on the
    // RULE is the output assertion: with `mode: 'ceiling'` it stays legal and
    // is honoured; with `failOnEmpty: true` it is refused above.)
    if (rule.compute?.kind === 'extractor') {
      refineMarkedFailOnEmpty(ctx, rule.compute.source?.files, 'compute.source.files', rule.failOnEmpty);
    } else {
      refineMarkedFailOnEmpty(ctx, rule.watchFiles, 'watchFiles', rule.failOnEmpty);
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
    generatedGlob: markableList('generatedGlob', 1),
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
    refineGlobList(ctx, markableUnits(rule.generatedGlob), ['generatedGlob']);
    refineMarkedFailOnEmpty(ctx, rule.generatedGlob, 'generatedGlob', rule.failOnEmpty);
    rule.sources?.forEach((src, i) => refineGlobList(ctx, src.glob, ['sources', i, 'glob']));
    refineGlobList(ctx, rule.provenanceHeader?.outsideGlob, ['provenanceHeader', 'outsideGlob']);
    refineExemptionList(ctx, rule.handMaintained, ['handMaintained']);
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
    files: markableList('files', 1),
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
    refineGlobList(ctx, markableUnits(rule.files), ['files']);
    refineMarkedFailOnEmpty(ctx, rule.files, 'files', rule.failOnEmpty);
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
    supersedes: z.array(z.string()).optional(),
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
    // Local task-routing-hint + playbook registry files, relative to
    // sharkcraftDir (docs/task-routing-hints.md, docs/playbooks.md). The
    // loaders always read them; before these keys were declared, using either
    // one made the strict schema reject — and drop — the WHOLE config.
    taskRoutingHintFiles: z.array(z.string()).optional(),
    playbookFiles: z.array(z.string()).optional(),
    // Local convention files, relative to sharkcraftDir, loaded in addition to
    // the conventional `conventions.ts` (plugin-api convention.ts: "Packs and
    // local config contribute conventions via `conventionFiles[]`").
    conventionFiles: z.array(z.string()).optional(),
    // Ownership rule files (docs/ownership.md `config.ownershipFiles`).
    ownershipFiles: z.array(z.string()).optional(),
    // Release-readiness knowledge stale-check (docs/knowledge-integrity.md).
    knowledgeCheck: z
      .object({
        enabled: z.boolean().optional(),
        strict: z.boolean().optional(),
        failOn: z
          .array(
            z.enum([
              'required',
              'stale',
              'missing',
              'all',
              'unverifiable',
              'path-missing',
              'anchor-missing',
              'content',
              'count',
              'aged',
              'implicit',
              // A malformed reference fails (1) instead of settling to 2 — the
              // same vocabulary as `knowledge stale-check --fail-on`.
              'invalid',
            ]),
          )
          .optional(),
        // Minimum share of in-scope entries the check can examine (0..1). An
        // explicit acceptance — `knowledge stale-check` and release readiness
        // print it — and a ratchet: below it the run fails.
        minReferenced: z.number().min(0).max(1).optional(),
        // Every entry must declare a checkable reference (for a finished ratchet).
        requireReferences: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Project-wide quality-gate thresholds for `shrk quality` (docs/quality-gates.md).
    qualityGates: z
      .object({
        minReadiness: z.number().optional(),
        requireBoundaryClean: z.boolean().optional(),
        requireDriftClean: z.boolean().optional(),
        requireAgentTests: z.boolean().optional(),
        requireContextTests: z.boolean().optional(),
        requirePackSignatures: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Per-policy severity / enable overrides (docs/policy-checks.md).
    policyOverrides: z
      .array(
        z
          .object({
            policyId: z.string().min(1),
            severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
            enabled: z.boolean().optional(),
            reason: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    // Recommender tuning (`shrk recommend`, MCP `recommend_commands`,
    // `shrk context`; docs/command-entrypoints.md). `minScore` is the confidence
    // floor multiplier in normalised units (1.0 = each signal source's own
    // floor); `scaffoldRequiresCreateIntent` (default true) keeps source-writing
    // scaffolds out of non-create queries.
    recommend: z
      .object({
        minScore: z.number().positive().optional(),
        scaffoldRequiresCreateIntent: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
    // registry-lifecycle scan tuning. `skipDirsAdd` EXTENDS the default
    // source-only skip set (the one to reach for); `skipDirs` REPLACES it — a
    // replacing list that drops node_modules/dist/… is warned about by the
    // scan and by `shrk doctor`.
    registryLifecycle: z
      .object({
        skipDirs: z.array(z.string()).optional(),
        skipDirsAdd: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // Project-declared area patterns for the area map (`shrk repo areas`,
    // impact, review packets). Evaluated before the built-in table. `kind` is
    // the core AreaKind enum; `unknown` is an outcome, never a declaration.
    areaMap: z
      .object({
        patterns: z
          .array(
            z
              .object({
                kind: z
                  .nativeEnum(AreaKind)
                  .refine((k) => k !== AreaKind.Unknown, {
                    message: "an area pattern cannot declare kind 'unknown' — that is what an unmatched file gets",
                  }),
                match: z.array(z.string().min(1)).min(1),
                id: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
        replaceDefaults: z.boolean().optional(),
        minClassificationRate: z.number().min(0).max(1).optional(),
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
        // Deny list: exact paths or `<group> *` selectors — not callable
        // (surface gate, exit 78) and absent from --help.
        disabled: z.array(z.string()).optional(),
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
