/**
 * Rule authoring scaffold.
 *
 * Pure, deterministic generator that returns a rule scaffold (TS source +
 * JSON manifest + a markdown explainer) so an agent does not have to
 * guess the schema fields. Preview-only: this module never writes — the
 * CLI adapter materialises the preview under `.sharkcraft/fixes/`.
 *
 * Hard rules:
 *   - No mutation of `sharkcraft/rules.ts`.
 *   - Generated content must reference real, deterministic schema fields.
 *   - Advisory rules opt out of `verificationCommands` requirements via
 *     `metadata: { advisory: true }`.
 */

export const RULE_SCAFFOLD_SCHEMA = 'sharkcraft.rule-scaffold/v1';

export enum RuleScaffoldKind {
  Architecture = 'architecture',
  Safety = 'safety',
  Style = 'style',
  Governance = 'governance',
  Migration = 'migration',
  Testing = 'testing',
  Advisory = 'advisory',
}

export interface IRuleScaffoldInput {
  /** Kebab-cased id, e.g. `architecture.no-reexport-proxy`. */
  id: string;
  /** Kind drives default tags / appliesWhen / advisory marker. */
  kind: RuleScaffoldKind;
  /** Optional one-line title — defaults to a derivation of `id`. */
  title?: string;
  /** Optional rationale — used as the rule body. */
  rationale?: string;
  /** Optional owner string copied into `source.origin`. */
  owner?: string;
  /** Optional priority — defaults to medium for advisory, high otherwise. */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Optional verification commands — strings copied verbatim. */
  verificationCommands?: readonly string[];
  /** Optional forbidden actions list. */
  forbiddenActions?: readonly string[];
  /** Optional examples (good/bad). */
  goodExample?: string;
  badExample?: string;
}

export interface IRuleScaffoldFile {
  /** Project-relative path the file should be written to. */
  path: string;
  /** Raw file contents. */
  body: string;
  /** Hint to the renderer / docs. */
  language: 'typescript' | 'json' | 'markdown';
}

export interface IRuleScaffoldResult {
  schema: typeof RULE_SCAFFOLD_SCHEMA;
  generatedAt: string;
  ruleId: string;
  kind: RuleScaffoldKind;
  /** The TS define-rule scaffold the agent can copy into `rules.ts`. */
  tsScaffold: IRuleScaffoldFile;
  /** A JSON manifest of the rule (machine-readable summary). */
  jsonManifest: IRuleScaffoldFile;
  /** Markdown explainer with the next commands the agent should run. */
  explainer: IRuleScaffoldFile;
  /** Sanity-check warnings (does NOT fail generation). */
  warnings: readonly string[];
  /** Suggested next commands for the agent. */
  nextCommands: readonly string[];
}

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;

function deriveTitle(id: string): string {
  const tail = id.split('.').slice(-1)[0] ?? id;
  return tail
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function defaultsForKind(kind: RuleScaffoldKind): {
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: readonly string[];
  appliesWhen: readonly string[];
  forbiddenActions: readonly string[];
  verification: readonly string[];
  advisory: boolean;
} {
  switch (kind) {
    case RuleScaffoldKind.Safety:
      return {
        priority: 'critical',
        tags: ['safety'],
        appliesWhen: ['generate-code', 'review-code', 'agent-action'],
        forbiddenActions: ['Bypass the safety guard.'],
        verification: ['shrk safety audit --deep'],
        advisory: false,
      };
    case RuleScaffoldKind.Architecture:
      return {
        priority: 'high',
        tags: ['architecture', 'boundaries'],
        appliesWhen: ['generate-code', 'create-feature', 'review-code'],
        forbiddenActions: ['Cross the declared layer boundary.'],
        verification: ['shrk check boundaries'],
        advisory: false,
      };
    case RuleScaffoldKind.Style:
      return {
        priority: 'medium',
        tags: ['style'],
        appliesWhen: ['generate-code', 'review-code'],
        forbiddenActions: [],
        verification: ['bun x tsc -p tsconfig.base.json --noEmit'],
        advisory: false,
      };
    case RuleScaffoldKind.Governance:
      return {
        priority: 'high',
        tags: ['governance'],
        appliesWhen: ['agent-action', 'review-code'],
        forbiddenActions: ['Skip the governance gate.'],
        verification: ['shrk doctor', 'shrk safety audit --deep'],
        advisory: false,
      };
    case RuleScaffoldKind.Migration:
      return {
        priority: 'medium',
        tags: ['migration'],
        appliesWhen: ['generate-code', 'create-feature'],
        forbiddenActions: ['Land partial migrations without a plan.'],
        verification: ['shrk audit project-coupling audit --fail-on engine'],
        advisory: false,
      };
    case RuleScaffoldKind.Testing:
      return {
        priority: 'high',
        tags: ['testing'],
        appliesWhen: ['generate-test', 'create-feature', 'review-code'],
        forbiddenActions: ['Disable a test instead of fixing the cause.'],
        verification: ['bun test'],
        advisory: false,
      };
    case RuleScaffoldKind.Advisory:
    default:
      return {
        priority: 'medium',
        tags: ['advisory'],
        appliesWhen: ['review-code'],
        forbiddenActions: [],
        verification: [],
        advisory: true,
      };
  }
}

function tsArrayLiteral(items: readonly string[]): string {
  if (items.length === 0) return '[]';
  return '[\n' + items.map((s) => `      ${JSON.stringify(s)},`).join('\n') + '\n    ]';
}

function buildTsBody(
  input: IRuleScaffoldInput,
  defaults: ReturnType<typeof defaultsForKind>,
): string {
  const id = input.id;
  const title = input.title ?? deriveTitle(id);
  const priority = input.priority ?? defaults.priority;
  const rationale = (input.rationale ?? `Document why "${id}" matters in one paragraph.`).trim();
  const tags = defaults.tags.slice();
  const appliesWhen = defaults.appliesWhen.slice();
  const forbidden = (input.forbiddenActions && input.forbiddenActions.length > 0
    ? input.forbiddenActions
    : defaults.forbiddenActions
  ).slice();
  const verification = (input.verificationCommands && input.verificationCommands.length > 0
    ? input.verificationCommands
    : defaults.verification
  ).slice();
  const examples: string[] = [];
  if (input.goodExample) {
    examples.push(
      `      { title: 'Good', code: ${JSON.stringify(input.goodExample)}, language: 'typescript' },`,
    );
  }
  if (input.badExample) {
    examples.push(
      `      { title: 'Bad', code: ${JSON.stringify(input.badExample)}, language: 'typescript' },`,
    );
  }
  const examplesBlock = examples.length > 0 ? `\n  examples: [\n${examples.join('\n')}\n  ],` : '';
  const ownerBlock = input.owner
    ? `\n  source: { origin: ${JSON.stringify(input.owner)}, loader: 'sharkcraft' },`
    : '';
  const advisoryBlock = defaults.advisory ? `\n  metadata: { advisory: true },` : '';
  const verificationLine =
    verification.length > 0 ? `\n      verificationCommands: ${tsArrayLiteral(verification)},` : '';
  const forbiddenLine =
    forbidden.length > 0 ? `\n      forbiddenActions: ${tsArrayLiteral(forbidden)},` : '';
  return `// Generated by \`shrk rules scaffold --id ${id}\`. Preview-only — review,
// then move into \`sharkcraft/rules.ts\` (or your pack's rules file).
// Self-contained — no @shrkcrft/* imports required.

const KnowledgePriority = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
} as const;

function defineRule<T>(rule: T): T { return rule; }

export const ${idToConst(id)} = defineRule({
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  priority: KnowledgePriority.${capitalize(priority)},
  scope: ${tsArrayLiteral([id.split('.')[0] ?? 'project'])},
  tags: ${tsArrayLiteral(tags)},
  appliesWhen: ${tsArrayLiteral(appliesWhen)},
  content: ${JSON.stringify(rationale)},${examplesBlock}${ownerBlock}${advisoryBlock}
  actionHints: {${forbiddenLine}${verificationLine}
  },
});
`;
}

function buildJsonManifest(input: IRuleScaffoldInput, defaults: ReturnType<typeof defaultsForKind>): string {
  const obj = {
    schema: RULE_SCAFFOLD_SCHEMA,
    id: input.id,
    title: input.title ?? deriveTitle(input.id),
    kind: input.kind,
    priority: input.priority ?? defaults.priority,
    advisory: defaults.advisory,
    tags: defaults.tags,
    appliesWhen: defaults.appliesWhen,
    rationale: input.rationale ?? '',
    forbiddenActions: input.forbiddenActions ?? defaults.forbiddenActions,
    verificationCommands: input.verificationCommands ?? defaults.verification,
    examples: {
      good: input.goodExample ?? null,
      bad: input.badExample ?? null,
    },
    owner: input.owner ?? null,
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

function buildExplainer(input: IRuleScaffoldInput, defaults: ReturnType<typeof defaultsForKind>): string {
  const advisoryNote = defaults.advisory
    ? '- This rule is **advisory**: `shrk rules doctor` will not require `verificationCommands`.\n'
    : '- This rule is enforceable: `shrk rules doctor` will require `verificationCommands` and `forbiddenActions`.\n';
  return `# Rule scaffold — ${input.id}

This is a **preview** generated by \`shrk rules scaffold\`. Nothing has
been written into \`sharkcraft/rules.ts\`. Move the TypeScript scaffold
into the right rules file, fill in the rationale and verification
commands, then run the validations below.

## Next commands

1. Edit the scaffold under \`.sharkcraft/fixes/\` or copy it into
   \`sharkcraft/rules.ts\`.
2. \`shrk rules doctor --id ${input.id}\` — checks the new rule for
   missing actionHints / verificationCommands / forbiddenActions.
3. \`shrk doctor\` — confirms the workspace still loads cleanly.

## Notes

${advisoryNote}- Kind: \`${input.kind}\`
- Default tags: ${defaults.tags.map((t) => '`' + t + '`').join(', ') || '_(none)_'}
- Default appliesWhen: ${defaults.appliesWhen.map((t) => '`' + t + '`').join(', ') || '_(none)_'}

## Owner

${input.owner ? '`' + input.owner + '`' : '_(unset — set with `--owner <name>`)_'}
`;
}

function idToConst(id: string): string {
  return id
    .split(/[.\-]/)
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fileSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

export function buildRuleScaffold(input: IRuleScaffoldInput): IRuleScaffoldResult {
  const warnings: string[] = [];
  if (!ID_RE.test(input.id)) {
    warnings.push(
      `id "${input.id}" does not match the recommended pattern <namespace>.<kebab-id>; got "${input.id}".`,
    );
  }
  const defaults = defaultsForKind(input.kind);
  if (!defaults.advisory && (input.verificationCommands?.length ?? 0) === 0 && defaults.verification.length === 0) {
    warnings.push(
      'Enforceable rules should declare verificationCommands. Default kind suggestion was empty — fill before adopting.',
    );
  }
  if (!input.rationale) {
    warnings.push('No rationale provided; the scaffold contains a placeholder line.');
  }
  const safeId = fileSafeId(input.id);
  const tsScaffold: IRuleScaffoldFile = {
    path: `.sharkcraft/fixes/rule-${safeId}.preview.ts`,
    body: buildTsBody(input, defaults),
    language: 'typescript',
  };
  const jsonManifest: IRuleScaffoldFile = {
    path: `.sharkcraft/fixes/rule-${safeId}.preview.json`,
    body: buildJsonManifest(input, defaults),
    language: 'json',
  };
  const explainer: IRuleScaffoldFile = {
    path: `.sharkcraft/fixes/rule-${safeId}.preview.md`,
    body: buildExplainer(input, defaults),
    language: 'markdown',
  };
  const nextCommands = [
    `shrk rules doctor --id ${input.id}`,
    'shrk doctor',
  ];
  return {
    schema: RULE_SCAFFOLD_SCHEMA,
    generatedAt: new Date().toISOString(),
    ruleId: input.id,
    kind: input.kind,
    tsScaffold,
    jsonManifest,
    explainer,
    warnings,
    nextCommands,
  };
}
