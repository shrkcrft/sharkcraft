import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  ANGULAR_PATH_APP,
  ANGULAR_PATH_COMPONENTS,
  ANGULAR_PATH_SERVICES,
  COMMON_AGENT_BRIEFING,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_RULE_INTERFACE_PREFIX,
  COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
  COMMON_RULE_ONE_EXPORT,
  COMMON_SAFETY_RULE,
  NEST_PATH_E2E,
  NEST_PATH_SRC,
  OVERVIEW_DOC,
} from './shared-snippets.ts';
import {
  NG_ACCESSIBLE,
  NG_AVOID_BYPASS_SECURITY,
  NG_DOMAIN_NO_UI_IMPORTS,
  NG_FEATURE_FOLDERS,
  NG_GUARDS_SMALL,
  NG_LAZY_ROUTES,
  NG_LIFECYCLE_SAFE_CLEANUP,
  NG_NO_BUSINESS_LOGIC_IN_TEMPLATE,
  NG_NO_DEEP_LIB_IMPORTS,
  NG_NO_GOD_SERVICES,
  NG_ON_PUSH,
  NG_PLUGIN_NO_DEEP_IMPORTS,
  NG_PLUGIN_STABLE_CONTRACT,
  NG_RXJS_NO_NESTED_SUBSCRIBE,
  NG_SIGNALS_FIRST,
  NG_STANDALONE_COMPONENTS,
  NG_TRACK_BY,
  NG_TYPED_REACTIVE_FORMS,
  TS_AGENT_SMALL_DIFFS,
  TS_BRANDED_IDS,
  TS_DISCRIMINATED_UNIONS,
  TS_ERROR_HANDLING,
  TS_NO_ANY,
  TS_NO_CIRCULAR_IMPORTS,
  TS_NO_DEEP_IMPORTS,
  TS_NO_FLOATING_PROMISES,
  TS_PREFER_SATISFIES,
  TS_PUBLIC_RETURN_TYPES,
  TS_READONLY_DEFAULT,
  TS_VALIDATE_BOUNDARY_INPUT,
} from './r26-snippets.ts';

// ─── Core ──────────────────────────────────────────────────────────────────

export const GENERIC_SAFE_REPO: IPreset = definePreset({
  id: 'generic-safe-repo',
  title: 'Generic safe repository baseline',
  description: 'Safety + dry-run defaults that apply to any repo regardless of language. Composed by most other presets.',
  tags: ['core', 'safety', 'generic'],
  weight: 6,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [COMMON_SAFETY_RULE, TS_AGENT_SMALL_DIFFS],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY],
    docs: { 'overview.md': OVERVIEW_DOC('Generic safe repo', 'Dry-run by default; CLI is the only write path; MCP never writes.') },
  },
  recommendedNextCommands: ['shrk doctor', 'shrk context --task "<task>"'],
});

export const AI_AGENT_SAFE_DEVELOPMENT: IPreset = definePreset({
  id: 'ai-agent-safe-development',
  title: 'AI-agent-safe development',
  description: 'Agent guardrails: small diffs, contract-driven changes, never apply without a review.',
  tags: ['agent', 'safety'],
  weight: 7,
  composes: ['generic-safe-repo'],
  includes: {
    knowledge: [],
    rules: [COMMON_SAFETY_RULE, TS_AGENT_SMALL_DIFFS],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_FEATURE_DEV],
    docs: { 'overview.md': OVERVIEW_DOC('AI-agent safe development', 'Agents must inspect existing patterns, prefer minimal diffs, surface uncertainty, and never apply plans without a review.') },
  },
  recommendedNextCommands: ['shrk contract template render generic-change --task "<task>"', 'shrk plan review <plan.json>'],
});

export const ENTERPRISE_REVIEW_GATED: IPreset = definePreset({
  id: 'enterprise-review-gated',
  title: 'Enterprise review-gated workflow',
  description: 'Contract approval + plan signing + boundary enforcement before any apply. Suited to large org repositories.',
  tags: ['enterprise', 'governance'],
  weight: 6,
  composes: ['ai-agent-safe-development'],
  includes: {
    knowledge: [],
    rules: [COMMON_SAFETY_RULE, TS_NO_DEEP_IMPORTS, TS_NO_CIRCULAR_IMPORTS],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_FEATURE_DEV],
    docs: { 'overview.md': OVERVIEW_DOC('Enterprise review-gated', 'Every plan goes through contract approval + signed plan + boundary check before apply.') },
  },
  recommendedNextCommands: [
    'shrk contract create --task "<task>" --save',
    'shrk plan review <plan.json>',
    'shrk apply <plan.json> --verify-signature --validate',
  ],
});

// ─── TypeScript ────────────────────────────────────────────────────────────

export const STRICT_TYPESCRIPT: IPreset = definePreset({
  id: 'strict-typescript',
  title: 'Strict TypeScript',
  description: 'Strict-mode TypeScript rule library: no any, satisfies-first, no floating promises, no deep imports, no circular imports, branded ids.',
  tags: ['typescript', 'strict'],
  appliesTo: [WorkspaceProfile.HasTypeScript],
  weight: 8,
  composes: ['generic-safe-repo'],
  includes: {
    knowledge: [],
    rules: [
      TS_NO_ANY,
      TS_PREFER_SATISFIES,
      TS_DISCRIMINATED_UNIONS,
      TS_READONLY_DEFAULT,
      TS_PUBLIC_RETURN_TYPES,
      TS_NO_FLOATING_PROMISES,
      TS_ERROR_HANDLING,
      TS_NO_DEEP_IMPORTS,
      TS_NO_CIRCULAR_IMPORTS,
      TS_VALIDATE_BOUNDARY_INPUT,
      TS_BRANDED_IDS,
      COMMON_RULE_INTERFACE_PREFIX,
      COMMON_RULE_ONE_EXPORT,
      COMMON_RULE_NO_LOGIC_CONSTRUCTORS,
    ],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_UNIT_TEST],
    docs: { 'overview.md': OVERVIEW_DOC('Strict TypeScript', 'A starter rule pack for projects committed to strict TypeScript. Pair with the boundary-rules from `node-service` / `mcp-server` / `nx-monorepo` as appropriate.') },
  },
  recommendedNextCommands: ['bun x tsc --noEmit', 'shrk check boundaries'],
});

export const NODE_SERVICE: IPreset = definePreset({
  id: 'node-service',
  title: 'Node.js service (TypeScript)',
  description: 'TypeScript Node.js service: strict rules + service template + HTTP/CLI pipeline.',
  tags: ['typescript', 'node', 'service'],
  appliesTo: [WorkspaceProfile.HasTypeScript, WorkspaceProfile.IsService],
  weight: 7,
  composes: ['strict-typescript'],
  includes: {
    knowledge: [],
    rules: [TS_NO_FLOATING_PROMISES, TS_VALIDATE_BOUNDARY_INPUT],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_FEATURE_DEV],
    docs: { 'overview.md': OVERVIEW_DOC('Node service', 'Validate external input at handler boundaries; prefer typed errors; keep handlers thin.') },
  },
  recommendedNextCommands: ['bun test', 'shrk doctor'],
});

export const NPM_PACKAGE: IPreset = definePreset({
  id: 'npm-package',
  title: 'npm package',
  description: 'Publishable TypeScript package: strict rules + public-API discipline + barrel hygiene.',
  tags: ['typescript', 'library', 'npm'],
  appliesTo: [WorkspaceProfile.HasTypeScript, WorkspaceProfile.IsLibrary],
  weight: 7,
  composes: ['strict-typescript'],
  includes: {
    knowledge: [],
    rules: [TS_NO_DEEP_IMPORTS, TS_PUBLIC_RETURN_TYPES],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('npm package', 'Re-export through `src/index.ts`. Avoid leaking internals. Keep the public surface intentional.') },
  },
  recommendedNextCommands: ['shrk api report', 'bun x tsc -p . --noEmit'],
});

// ─── Modern Angular family ─────────────────────────────────────────────────

export const MODERN_ANGULAR: IPreset = definePreset({
  id: 'modern-angular',
  title: 'Modern Angular',
  description: 'Modern Angular (signals-aware, standalone-first, OnPush, RxJS-disciplined). Composes the angular sub-presets.',
  tags: ['angular', 'modern'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 9,
  composes: ['strict-typescript', 'generic-safe-repo'],
  includes: {
    knowledge: [],
    rules: [
      NG_STANDALONE_COMPONENTS,
      NG_ON_PUSH,
      NG_SIGNALS_FIRST,
      NG_RXJS_NO_NESTED_SUBSCRIBE,
      NG_LIFECYCLE_SAFE_CLEANUP,
      NG_TRACK_BY,
      NG_NO_BUSINESS_LOGIC_IN_TEMPLATE,
      NG_TYPED_REACTIVE_FORMS,
      NG_LAZY_ROUTES,
      NG_GUARDS_SMALL,
      NG_NO_DEEP_LIB_IMPORTS,
      NG_FEATURE_FOLDERS,
      NG_NO_GOD_SERVICES,
      NG_DOMAIN_NO_UI_IMPORTS,
      NG_ACCESSIBLE,
      NG_AVOID_BYPASS_SECURITY,
    ],
    paths: [ANGULAR_PATH_APP, ANGULAR_PATH_COMPONENTS, ANGULAR_PATH_SERVICES],
    templates: [],
    pipelines: [COMMON_PIPELINE_FEATURE_DEV],
    docs: { 'overview.md': OVERVIEW_DOC('Modern Angular', 'Signals-first reactivity, RxJS used deliberately, standalone components, OnPush CD, lazy routes, typed forms, Nx-style boundaries.') },
    tasks: { 'angular-modes.md': '# Angular adoption modes\n\n- **strict** — apply every rule.\n- **gradual** — adopt boundaries + signals discipline first.\n- **migration** — code transformation toward modern Angular.\n- **greenfield** — new project starts strict.\n' },
  },
  recommendedNextCommands: ['shrk presets get modern-angular', 'shrk ingest repository --preset modern-angular --write-drafts'],
});

export const ANGULAR_SIGNALS_FIRST: IPreset = definePreset({
  id: 'angular-signals-first',
  title: 'Angular — signals-first',
  description: 'Reactivity rules for signal-heavy Angular apps.',
  tags: ['angular', 'signals'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  includes: {
    knowledge: [],
    rules: [NG_SIGNALS_FIRST, NG_ON_PUSH],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular signals-first', '`signal()` for local state, `computed()` for derived, `effect()` only for side effects.') },
  },
});

export const ANGULAR_RXJS_DISCIPLINED: IPreset = definePreset({
  id: 'angular-rxjs-disciplined',
  title: 'Angular — RxJS disciplined',
  description: 'No nested subscribe, lifecycle-safe cleanup, deliberate operator choice.',
  tags: ['angular', 'rxjs'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  includes: {
    knowledge: [],
    rules: [NG_RXJS_NO_NESTED_SUBSCRIBE, NG_LIFECYCLE_SAFE_CLEANUP],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular RxJS disciplined', 'Use switchMap/concatMap/exhaustMap deliberately. Always wire subscriptions through takeUntilDestroyed.') },
  },
});

export const ANGULAR_STANDALONE_COMPONENTS: IPreset = definePreset({
  id: 'angular-standalone-components',
  title: 'Angular — standalone components',
  description: 'Prefer standalone components/directives/pipes over NgModules.',
  tags: ['angular', 'standalone'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  includes: {
    knowledge: [],
    rules: [NG_STANDALONE_COMPONENTS],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular standalone components', 'New constructs default to standalone unless an existing NgModule contract requires otherwise.') },
  },
});

export const ANGULAR_ENTERPRISE_ARCHITECTURE: IPreset = definePreset({
  id: 'angular-enterprise-architecture',
  title: 'Angular — enterprise architecture',
  description: 'Library boundaries, public APIs, no deep imports, Nx tags.',
  tags: ['angular', 'enterprise', 'architecture'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  includes: {
    knowledge: [],
    rules: [NG_NO_DEEP_LIB_IMPORTS, NG_FEATURE_FOLDERS, NG_DOMAIN_NO_UI_IMPORTS, TS_NO_CIRCULAR_IMPORTS],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular enterprise architecture', 'Public APIs go through index.ts barrels. Deep imports forbidden. Domain services do not import UI.') },
  },
});

export const ANGULAR_PERFORMANCE: IPreset = definePreset({
  id: 'angular-performance',
  title: 'Angular — performance',
  description: 'OnPush CD, trackBy, lazy routes, deferred heavy components.',
  tags: ['angular', 'performance'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 5,
  includes: {
    knowledge: [],
    rules: [NG_ON_PUSH, NG_TRACK_BY, NG_LAZY_ROUTES],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular performance', 'Avoid unnecessary CD, track list rendering, lazy-load expensive features.') },
  },
});

export const ANGULAR_TESTING: IPreset = definePreset({
  id: 'angular-testing',
  title: 'Angular — testing',
  description: 'Behavior over implementation, harnesses for complex UIs, deterministic async.',
  tags: ['angular', 'testing'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 5,
  includes: {
    knowledge: [],
    rules: [],
    paths: [],
    templates: [],
    pipelines: [COMMON_PIPELINE_UNIT_TEST],
    docs: { 'overview.md': OVERVIEW_DOC('Angular testing', 'Prefer harness/page-object patterns for complex UIs. Test signal/observable behavior deterministically. E2E only for critical flows.') },
  },
});

export const ANGULAR_ACCESSIBILITY: IPreset = definePreset({
  id: 'angular-accessibility',
  title: 'Angular — accessibility',
  description: 'Semantic HTML, keyboard navigation, focus management, ARIA only where needed.',
  tags: ['angular', 'a11y'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 5,
  includes: {
    knowledge: [],
    rules: [NG_ACCESSIBLE],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular accessibility', 'Interactive elements must be keyboard reachable, focus-visible, and use semantic HTML.') },
  },
});

export const ANGULAR_SECURITY: IPreset = definePreset({
  id: 'angular-security',
  title: 'Angular — security',
  description: 'No bypassSecurityTrust*, sanitize user HTML, validate route params, CSP-friendly.',
  tags: ['angular', 'security'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  includes: {
    knowledge: [],
    rules: [NG_AVOID_BYPASS_SECURITY, TS_VALIDATE_BOUNDARY_INPUT],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular security', 'Avoid bypassSecurityTrust*. Sanitize user HTML. Validate route params.') },
  },
});

export const ANGULAR_PLUGIN_PLATFORM: IPreset = definePreset({
  id: 'angular-plugin-platform',
  title: 'Angular — plugin platform',
  description: 'Plugin contracts, lifecycle, capability tokens, isolation.',
  tags: ['angular', 'plugins'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 5,
  includes: {
    knowledge: [],
    rules: [NG_PLUGIN_STABLE_CONTRACT, NG_PLUGIN_NO_DEEP_IMPORTS],
    paths: [],
    templates: [],
    pipelines: [],
    docs: { 'overview.md': OVERVIEW_DOC('Angular plugin platform', 'Plugin contracts are stable. No plugin-to-plugin deep imports. Lifecycle is deterministic.') },
  },
});

export const ANGULAR_ENTERPRISE_APP: IPreset = definePreset({
  id: 'angular-enterprise-app',
  title: 'Angular enterprise app',
  description: 'Production-grade Angular monorepo app with strict TypeScript + signals + RxJS discipline + Nx boundaries.',
  tags: ['angular', 'enterprise', 'app'],
  appliesTo: [WorkspaceProfile.HasAngular, WorkspaceProfile.IsMonorepo],
  weight: 7,
  composes: ['modern-angular', 'angular-enterprise-architecture', 'strict-typescript'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: {} },
});

export const ANGULAR_LIBRARY: IPreset = definePreset({
  id: 'angular-library',
  title: 'Angular library',
  description: 'Publishable Angular library: stable public API, no deep imports, peerDependency hygiene.',
  tags: ['angular', 'library'],
  appliesTo: [WorkspaceProfile.HasAngular, WorkspaceProfile.IsLibrary],
  weight: 6,
  composes: ['modern-angular', 'npm-package'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: {} },
});

export const ANGULAR_SMART_UI_PLATFORM: IPreset = definePreset({
  id: 'angular-smart-ui-platform',
  title: 'Angular smart UI platform',
  description: 'Smart/dumb component split, deliberate state ownership, large-app organisation.',
  tags: ['angular', 'ui-platform'],
  appliesTo: [WorkspaceProfile.HasAngular],
  weight: 6,
  composes: ['modern-angular'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: {} },
});

// ─── Testing presets ───────────────────────────────────────────────────────

export const VITEST_FOCUSED: IPreset = definePreset({
  id: 'vitest-focused',
  title: 'Vitest-focused testing',
  description: 'Vitest-driven test discipline; deterministic timers; behavior over implementation.',
  tags: ['testing', 'vitest'],
  appliesTo: [WorkspaceProfile.HasVitest],
  weight: 5,
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [COMMON_PIPELINE_UNIT_TEST], docs: { 'overview.md': OVERVIEW_DOC('Vitest-focused', 'Behavior tests. Deterministic timers. Use `vi.useFakeTimers()` rather than wall-clock.') } },
});

export const JEST_FOCUSED: IPreset = definePreset({
  id: 'jest-focused',
  title: 'Jest-focused testing',
  description: 'Jest-driven test discipline; deterministic; focused unit tests over snapshot-only.',
  tags: ['testing', 'jest'],
  appliesTo: [WorkspaceProfile.HasJest],
  weight: 5,
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [COMMON_PIPELINE_UNIT_TEST], docs: { 'overview.md': OVERVIEW_DOC('Jest-focused', 'Avoid brittle snapshot-only suites. Use jest.useFakeTimers() for async.') } },
});

export const PLAYWRIGHT_FOCUSED: IPreset = definePreset({
  id: 'playwright-focused',
  title: 'Playwright-focused E2E',
  description: 'Playwright e2e: page-object/harness patterns, deterministic auth, critical-flows only.',
  tags: ['testing', 'playwright', 'e2e'],
  weight: 5,
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('Playwright-focused', 'Use page objects / harnesses; cover the critical flow not every screen; deterministic auth setup.') } },
});

// ─── Frontend ──────────────────────────────────────────────────────────────

export const REACT_APP_PRESET: IPreset = definePreset({
  id: 'react-app',
  title: 'React app',
  description: 'React app baseline (strict TS, no deep imports, error boundaries).',
  tags: ['react', 'frontend'],
  appliesTo: [WorkspaceProfile.HasReact, WorkspaceProfile.IsFrontend],
  weight: 6,
  composes: ['strict-typescript'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('React app', 'Components are pure where possible. Side effects belong in hooks. Avoid deep imports between feature folders.') } },
});

export const VUE_APP_PRESET: IPreset = definePreset({
  id: 'vue-app',
  title: 'Vue app',
  description: 'Vue 3 app baseline (composition API, typed props, scoped styles).',
  tags: ['vue', 'frontend'],
  appliesTo: [WorkspaceProfile.HasVue, WorkspaceProfile.IsFrontend],
  weight: 6,
  composes: ['strict-typescript'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('Vue app', 'Composition API + typed props. Scoped styles for component CSS. Pinia for state when needed.') } },
});

export const WEB_COMPONENT_LIBRARY: IPreset = definePreset({
  id: 'web-component-library',
  title: 'Web Component library',
  description: 'Framework-agnostic web components (lit/stencil/etc): explicit lifecycle, slotting, encapsulation.',
  tags: ['web-components', 'library'],
  weight: 5,
  composes: ['strict-typescript', 'npm-package'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('Web Component library', 'Shadow DOM by default. Slot for composition. Keep public attributes stable.') } },
});

// ─── Backend ───────────────────────────────────────────────────────────────

export const NESTJS_SERVICE: IPreset = definePreset({
  id: 'nestjs-service',
  title: 'NestJS service',
  description: 'NestJS service: typed DTOs at boundaries, no logic in controllers, layered modules.',
  tags: ['nestjs', 'backend'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 7,
  composes: ['node-service'],
  includes: { knowledge: [], rules: [TS_VALIDATE_BOUNDARY_INPUT], paths: [NEST_PATH_SRC, NEST_PATH_E2E], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('NestJS service', 'Validate DTOs at controllers. Keep services thin. Use modules to enforce layers.') } },
});

export const EXPRESS_SERVICE: IPreset = definePreset({
  id: 'express-service',
  title: 'Express service',
  description: 'Express HTTP service: explicit error middleware, typed request handlers, no router-in-handler.',
  tags: ['express', 'backend'],
  appliesTo: [WorkspaceProfile.IsBackend],
  weight: 5,
  composes: ['node-service'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('Express service', 'Centralised error middleware. Strict request typing. Avoid spawning routes from inside handlers.') } },
});

export const FASTIFY_SERVICE: IPreset = definePreset({
  id: 'fastify-service',
  title: 'Fastify service',
  description: 'Fastify service: schema-validated routes, plugin encapsulation, deterministic startup.',
  tags: ['fastify', 'backend'],
  appliesTo: [WorkspaceProfile.IsBackend],
  weight: 5,
  composes: ['node-service'],
  includes: { knowledge: [], rules: [], paths: [], templates: [], pipelines: [], docs: { 'overview.md': OVERVIEW_DOC('Fastify service', 'Schema-validate routes. Encapsulate features as plugins. Keep startup ordering deterministic.') } },
});

export const R26_PRESETS: readonly IPreset[] = Object.freeze([
  GENERIC_SAFE_REPO,
  AI_AGENT_SAFE_DEVELOPMENT,
  ENTERPRISE_REVIEW_GATED,
  STRICT_TYPESCRIPT,
  NODE_SERVICE,
  NPM_PACKAGE,
  MODERN_ANGULAR,
  ANGULAR_SIGNALS_FIRST,
  ANGULAR_RXJS_DISCIPLINED,
  ANGULAR_STANDALONE_COMPONENTS,
  ANGULAR_ENTERPRISE_ARCHITECTURE,
  ANGULAR_PERFORMANCE,
  ANGULAR_TESTING,
  ANGULAR_ACCESSIBILITY,
  ANGULAR_SECURITY,
  ANGULAR_PLUGIN_PLATFORM,
  ANGULAR_ENTERPRISE_APP,
  ANGULAR_LIBRARY,
  ANGULAR_SMART_UI_PLATFORM,
  VITEST_FOCUSED,
  JEST_FOCUSED,
  PLAYWRIGHT_FOCUSED,
  REACT_APP_PRESET,
  VUE_APP_PRESET,
  WEB_COMPONENT_LIBRARY,
  NESTJS_SERVICE,
  EXPRESS_SERVICE,
  FASTIFY_SERVICE,
]);
