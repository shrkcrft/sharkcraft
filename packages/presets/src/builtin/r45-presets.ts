import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  COMMON_AGENT_BRIEFING,
  COMMON_PATH_SERVICES,
  COMMON_PATH_TESTS,
  COMMON_PATH_UTILS,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_RULE_INTERFACE_PREFIX,
  COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
  COMMON_RULE_ONE_EXPORT,
  COMMON_SAFETY_RULE,
  COMMON_TEMPLATE_SERVICE,
  COMMON_TEMPLATE_TEST,
  COMMON_TEMPLATE_UTILITY,
  OVERVIEW_DOC,
} from './shared-snippets.ts';

// Universal adoption — fills four Phase-1 preset gaps:
//   next-app, turborepo, package-workspace, clean-architecture-ts.
// Each preset is generic — no project-specific anchors, no per-stack jargon
// that an unrelated team cannot use as-is.

export const NEXT_APP_PRESET: IPreset = definePreset({
  id: 'next-app',
  title: 'Next.js app',
  description:
    'Next.js app baseline (app-router-first): server components by default, route-group conventions, no business logic in pages, typed search params.',
  tags: ['next', 'react', 'frontend'],
  appliesTo: [WorkspaceProfile.HasNext, WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 8,
  composes: ['strict-typescript', 'react-app'],
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'next.app-router',
    title: 'Prefer the Next.js App Router for new routes',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['next', 'routing'],
    appliesWhen: ['generate-code'],
    content: 'New routes live under app/. The pages/ router is legacy; do not introduce new pages/ routes unless explicitly migrating.',
  })`,
      `defineKnowledgeEntry({
    id: 'next.no-business-logic-in-page',
    title: 'Keep business logic out of page.tsx / layout.tsx',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['next', 'architecture'],
    appliesWhen: ['generate-code', 'refactor'],
    content: 'Page and layout components compose. Domain logic, data fetching, and validation live in colocated modules under app/.../_lib or feature folders.',
  })`,
    ],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_TESTS],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Next.js app',
        'App Router by default. Server components for data fetching. Client components only at the leaves. Pages are thin composition; business logic stays in colocated modules.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk task "<task>"',
    'shrk gen typescript.utility <name> --dry-run',
  ],
});

export const TURBOREPO_PRESET: IPreset = definePreset({
  id: 'turborepo',
  title: 'Turborepo monorepo',
  description:
    'Conventions for Turborepo workspaces: package layer order, public entry points, no relative cross-package imports, run via the affected task graph.',
  tags: ['turborepo', 'monorepo'],
  appliesTo: [WorkspaceProfile.HasTurborepo, WorkspaceProfile.IsMonorepo],
  weight: 8,
  composes: ['strict-typescript'],
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'turborepo.affected-tasks',
    title: 'Use turbo run for affected tasks; avoid blanket rebuilds',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['turborepo', 'ci'],
    appliesWhen: ['generate-code', 'fix-build'],
    content: 'Prefer \`turbo run <task> --filter=...\` over running every package. Wire CI to the affected task graph so unrelated packages stay green.',
  })`,
      `defineKnowledgeEntry({
    id: 'turborepo.public-entrypoints',
    title: 'Cross-package imports go through the public entry point',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['turborepo', 'imports'],
    appliesWhen: ['generate-code'],
    content: 'Import via the package name (matches package.json exports / main). Avoid reaching into src/.',
  })`,
    ],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_INTERFACE_PREFIX, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Turborepo monorepo',
        'apps/ + packages/ layout. turbo.json drives the task graph. CI runs affected tasks only.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk ci scaffold github-actions --quickstart',
    'shrk task "<task>"',
  ],
});

export const PACKAGE_WORKSPACE_PRESET: IPreset = definePreset({
  id: 'package-workspace',
  title: 'Package workspace monorepo',
  description:
    'Generic npm / pnpm / yarn workspaces monorepo (no Nx, no Turborepo). Layer / boundary conventions + safe-codegen baseline.',
  tags: ['workspaces', 'monorepo'],
  appliesTo: [WorkspaceProfile.HasPackageWorkspaces, WorkspaceProfile.IsMonorepo],
  notAppropriateFor: [WorkspaceProfile.HasNx, WorkspaceProfile.HasTurborepo],
  weight: 6,
  composes: ['strict-typescript'],
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'workspaces.public-entrypoints',
    title: 'Cross-package imports use the package name',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['workspaces', 'imports'],
    appliesWhen: ['generate-code'],
    content: 'Import other workspace packages by name (package.json exports / main). No relative imports across package boundaries.',
  })`,
    ],
    rules: [COMMON_SAFETY_RULE, COMMON_RULE_INTERFACE_PREFIX, COMMON_RULE_ONE_EXPORT],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Package workspace',
        'Plain workspaces (npm / pnpm / yarn). Each package has a stable public entry. Cross-package boundary checks are enforced by `shrk check boundaries`.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk check boundaries',
    'shrk task "<task>"',
  ],
});

export const CLEAN_ARCHITECTURE_TS_PRESET: IPreset = definePreset({
  id: 'clean-architecture-ts',
  title: 'Clean Architecture (TypeScript)',
  description:
    'Layered TypeScript convention: domain (no deps), application (depends on domain), infrastructure (depends on application + domain), presentation (depends on application). No reverse imports.',
  tags: ['typescript', 'architecture', 'clean-architecture'],
  appliesTo: [WorkspaceProfile.HasTypeScript],
  weight: 6,
  composes: ['strict-typescript'],
  includes: {
    knowledge: [
      COMMON_AGENT_BRIEFING,
      `defineKnowledgeEntry({
    id: 'clean-arch.layer-order',
    title: 'Clean Architecture layers: domain → application → infrastructure / presentation',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    tags: ['architecture'],
    appliesWhen: ['generate-code', 'refactor'],
    content: 'Lower layers know nothing about higher ones. Domain has no dependencies on other layers. Application depends only on domain. Infrastructure and presentation are at the edges.',
  })`,
      `defineKnowledgeEntry({
    id: 'clean-arch.boundary-ports',
    title: 'Cross-layer access uses ports / interfaces, not concrete types',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    tags: ['architecture', 'imports'],
    appliesWhen: ['generate-code'],
    content: 'Application defines interfaces (ports). Infrastructure implements them (adapters). Presentation depends on application interfaces, never on infrastructure directly.',
  })`,
    ],
    rules: [
      COMMON_SAFETY_RULE,
      COMMON_RULE_INTERFACE_PREFIX,
      COMMON_RULE_ONE_EXPORT,
      COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
    ],
    paths: [COMMON_PATH_SERVICES, COMMON_PATH_UTILS, COMMON_PATH_TESTS],
    templates: [COMMON_TEMPLATE_SERVICE, COMMON_TEMPLATE_UTILITY, COMMON_TEMPLATE_TEST],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'Clean Architecture (TypeScript)',
        'Layers: domain / application / infrastructure / presentation. Lower layers know nothing about higher ones. Wire boundaries through ports + adapters; enforce with `shrk check boundaries`.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk check boundaries',
    'shrk task "<task>"',
  ],
});

export const R45_PRESETS: readonly IPreset[] = Object.freeze([
  NEXT_APP_PRESET,
  TURBOREPO_PRESET,
  PACKAGE_WORKSPACE_PRESET,
  CLEAN_ARCHITECTURE_TS_PRESET,
]);
