import {
  AdoptionCategory,
  AdoptionKind,
  buildOnboardingAdoptionPlan,
  buildOnboardingDiff,
  buildOnboardingPlan,
  importAgentRulesForOnboarding,
  renderOnboardingReport,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT_COMMAND = 'shrk onboard --write-drafts';
const NEXT_COMMANDS_FULL = [
  'shrk onboard --write-drafts',
  'shrk onboard --write-drafts --scaffold-templates',
  'shrk onboard --write-drafts --import-agents',
  'shrk onboard --diff',
];

export const createOnboardingPlanTool: IToolDefinition = {
  name: 'create_onboarding_plan',
  description:
    'Build an onboarding plan for the current repository. Read-only: returns the structured plan (profiles, presets, inferred rules/paths/templates/boundaries/pipelines, readiness estimate). Options enable additional read-only analyses (template scaffolding preview, agent rule import preview, diff against live config). Does NOT write any files — use the CLI to materialize drafts.',
  inputSchema: {
    type: 'object',
    properties: {
      preferredPreset: {
        type: 'string',
        description:
          'Pin this preset id to the top of the recommendation list. The plan still includes the full ranked list.',
      },
      scaffoldTemplates: {
        type: 'boolean',
        description:
          'When true, attempt to produce runnable scaffolded bodies for high/medium-confidence template candidates. Still read-only — the user must run the CLI to write drafts.',
      },
      importAgents: {
        type: 'boolean',
        description:
          'When true, also parse AGENTS.md / CLAUDE.md / .cursor/rules into an imported-agent-rules bundle.',
      },
      includeDiff: {
        type: 'boolean',
        description:
          'When true, also compute a diff vs. the live SharkCraft config (rules / paths / templates / pipelines / boundaries / verification commands).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const obj = input as {
      preferredPreset?: unknown;
      scaffoldTemplates?: unknown;
      importAgents?: unknown;
      includeDiff?: unknown;
    };
    const preferredPreset = obj.preferredPreset;
    const scaffoldTemplates = obj.scaffoldTemplates === true;
    const importAgents = obj.importAgents === true;
    const includeDiff = obj.includeDiff === true;

    const plan = buildOnboardingPlan(ctx.inspection, {
      ...(typeof preferredPreset === 'string' ? { preferredPreset } : {}),
      ...(scaffoldTemplates ? { scaffoldTemplates: true } : {}),
    });
    const importedAgentRules = importAgents
      ? importAgentRulesForOnboarding({ projectRoot: ctx.inspection.projectRoot })
      : undefined;
    const diff = includeDiff
      ? buildOnboardingDiff(ctx.inspection, plan)
      : undefined;

    return {
      data: {
        plan,
        reportPreview: renderOnboardingReport(plan),
        inferredAssetsSummary: {
          rules: plan.inferredRules.length,
          paths: plan.inferredPathConventions.length,
          templates: plan.inferredTemplateCandidates.length,
          templatesScaffolded: plan.inferredTemplateCandidates.filter(
            (t) => t.scaffold,
          ).length,
          pipelines: plan.inferredPipelines.length,
          boundaries: plan.inferredBoundaryRules.length,
          verificationCommands: plan.inferredVerificationCommands.length,
        },
        ...(importedAgentRules ? { importedAgentRules } : {}),
        ...(diff ? { diff } : {}),
        nextCommand: NEXT_COMMAND,
        nextCommands: NEXT_COMMANDS_FULL,
        note:
          'MCP cannot write drafts. Run the CLI commands to materialize them under sharkcraft/onboarding/.',
      },
    };
  },
};

export const getOnboardingReportPreviewTool: IToolDefinition = {
  name: 'get_onboarding_report_preview',
  description:
    'Render the onboarding plan as a Markdown report (same content `shrk onboard --write-drafts` would write to sharkcraft/onboarding/onboarding-report.md). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      preferredPreset: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const preferredPreset = (input as { preferredPreset?: unknown })
      .preferredPreset;
    const plan = buildOnboardingPlan(ctx.inspection, {
      ...(typeof preferredPreset === 'string' ? { preferredPreset } : {}),
    });
    return {
      data: {
        markdown: renderOnboardingReport(plan),
        nextCommand: NEXT_COMMAND,
      },
    };
  },
};

const KIND_MAP: Record<string, AdoptionKind> = {
  rules: AdoptionKind.Rule,
  paths: AdoptionKind.Path,
  verifications: AdoptionKind.Verification,
  templates: AdoptionKind.Template,
  boundaries: AdoptionKind.Boundary,
  pipelines: AdoptionKind.Pipeline,
};

function parseKinds(value: unknown): AdoptionKind[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<AdoptionKind>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const k = KIND_MAP[v.toLowerCase()];
    if (k) out.add(k);
  }
  return [...out];
}

export const createOnboardingAdoptionPlanTool: IToolDefinition = {
  name: 'create_onboarding_adoption_plan',
  description:
    'Build an adoption plan classifying inferred items into safe-to-adopt / manual-review / low-confidence / conflict / already-covered / skipped buckets. READ-ONLY: this MCP tool never writes patches. Use `shrk onboard adopt --write-patch` on the CLI to materialize them.',
  inputSchema: {
    type: 'object',
    properties: {
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Confidence threshold. Default high.',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Kinds to include (rules,paths,verifications,templates,boundaries,pipelines).',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Kinds to exclude.',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const obj = input as { confidence?: unknown; include?: unknown; exclude?: unknown };
    const confidence =
      obj.confidence === 'medium' || obj.confidence === 'low' ? obj.confidence : 'high';
    const include = parseKinds(obj.include);
    const exclude = parseKinds(obj.exclude);
    const plan = buildOnboardingPlan(ctx.inspection, {});
    const adoption = buildOnboardingAdoptionPlan({
      inspection: ctx.inspection,
      plan,
      confidence,
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    });
    return {
      data: {
        confidence: adoption.confidence,
        included: adoption.included,
        excluded: adoption.excluded,
        summary: adoption.summary,
        items: adoption.items,
        categories: Object.values(AdoptionCategory),
        suggestedAdditions: adoption.byCategory[AdoptionCategory.SafeToAdopt],
        skipped: adoption.byCategory[AdoptionCategory.Skipped],
        conflicts: adoption.byCategory[AdoptionCategory.Conflict],
        manualReview: adoption.byCategory[AdoptionCategory.ManualReview],
        nextCommand: 'shrk onboard adopt --write-patch',
        note:
          'MCP cannot write the adoption patch. Run the CLI command above to materialize sharkcraft/onboarding/adoption/.',
      },
    };
  },
};

export const getOnboardingAdoptionReviewTool: IToolDefinition = {
  name: 'get_onboarding_adoption_review',
  description:
    'Return the categorised review of the inferred adoption plan, grouped by category (safe-to-adopt, manual-review, low-confidence, conflict, already-covered, skipped). READ-ONLY.',
  inputSchema: {
    type: 'object',
    properties: {
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const confidence =
      (input as { confidence?: unknown }).confidence === 'medium' ||
      (input as { confidence?: unknown }).confidence === 'low'
        ? ((input as { confidence?: string }).confidence as 'medium' | 'low')
        : 'high';
    const plan = buildOnboardingPlan(ctx.inspection, {});
    const adoption = buildOnboardingAdoptionPlan({
      inspection: ctx.inspection,
      plan,
      confidence,
    });
    return {
      data: {
        confidence: adoption.confidence,
        byCategory: adoption.byCategory,
        summary: adoption.summary,
        nextCommand: 'shrk onboard adopt --write-patch',
      },
    };
  },
};

export const listInferredAssetsTool: IToolDefinition = {
  name: 'list_inferred_assets',
  description:
    'List the asset ids the inference engine would propose for this repository: rules, path conventions, boundary rules, template candidates, pipelines, verification commands. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      preferredPreset: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const preferredPreset = (input as { preferredPreset?: unknown })
      .preferredPreset;
    const plan = buildOnboardingPlan(ctx.inspection, {
      ...(typeof preferredPreset === 'string' ? { preferredPreset } : {}),
    });
    return {
      data: {
        rules: plan.inferredRules.map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          source: r.source,
        })),
        paths: plan.inferredPathConventions.map((p) => ({
          id: p.id,
          title: p.title,
        })),
        boundaries: plan.inferredBoundaryRules.map((b) => ({
          id: b.id,
          title: b.title,
          severity: b.severity,
        })),
        templates: plan.inferredTemplateCandidates.map((t) => ({
          id: t.id,
          name: t.name,
          confidence: t.confidence,
        })),
        pipelines: plan.inferredPipelines.map((p) => ({
          id: p.id,
          title: p.title,
        })),
        verificationCommands: plan.inferredVerificationCommands.map((v) => ({
          id: v.id,
          command: v.command,
        })),
        nextCommand: NEXT_COMMAND,
      },
    };
  },
};
