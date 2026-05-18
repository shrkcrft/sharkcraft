// Reusable rule / knowledge expression strings for the Modern Angular preset library.
// These are embedded verbatim into the synthesized sharkcraft/*.ts files,
// using `defineKnowledgeEntry` from @shrkcrft/knowledge.

export function ruleSnippet(opts: {
  id: string;
  title: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: readonly string[];
  appliesWhen: readonly string[];
  content: string;
}): string {
  const prio = opts.priority.charAt(0).toUpperCase() + opts.priority.slice(1);
  return `defineKnowledgeEntry({
    id: ${JSON.stringify(opts.id)},
    title: ${JSON.stringify(opts.title)},
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.${prio},
    tags: ${JSON.stringify(opts.tags)},
    appliesWhen: ${JSON.stringify(opts.appliesWhen)},
    content: ${JSON.stringify(opts.content)},
  })`;
}

// ─── Strict TypeScript rules ───────────────────────────────────────────────

export const TS_NO_ANY = ruleSnippet({
  id: 'ts.no-any',
  title: 'Avoid `any` in public surfaces',
  priority: 'critical',
  tags: ['typescript', 'safety'],
  appliesWhen: ['generate-code', 'refactor', 'review'],
  content: 'Avoid `any` unless isolated and justified. Prefer `unknown` for external input and narrow it explicitly. Use type assertions only when no other option exists.',
});

export const TS_PREFER_SATISFIES = ruleSnippet({
  id: 'ts.prefer-satisfies',
  title: 'Prefer `satisfies` over object casts',
  priority: 'high',
  tags: ['typescript'],
  appliesWhen: ['generate-code', 'refactor'],
  content: 'Use `satisfies` for object-shape validation to preserve narrowed literal types instead of `as` casts.',
});

export const TS_DISCRIMINATED_UNIONS = ruleSnippet({
  id: 'ts.discriminated-unions',
  title: 'Use discriminated unions for state machines',
  priority: 'high',
  tags: ['typescript', 'state'],
  appliesWhen: ['generate-code'],
  content: 'Model finite-state shapes as discriminated unions (`type T = { kind: "a"; … } | { kind: "b"; … }`), not booleans + optional fields.',
});

export const TS_READONLY_DEFAULT = ruleSnippet({
  id: 'ts.readonly-default',
  title: 'Prefer `readonly` for immutable data',
  priority: 'medium',
  tags: ['typescript'],
  appliesWhen: ['generate-code'],
  content: 'Use `readonly` arrays/properties whenever mutation is not part of the contract — it documents intent and unlocks safer call sites.',
});

export const TS_PUBLIC_RETURN_TYPES = ruleSnippet({
  id: 'ts.public-return-types',
  title: 'Annotate public function return types',
  priority: 'high',
  tags: ['typescript', 'api'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Public/exported functions must declare an explicit return type — TS infers internally, but the signature is part of the contract.',
});

export const TS_NO_FLOATING_PROMISES = ruleSnippet({
  id: 'ts.no-floating-promises',
  title: 'Never let a Promise float',
  priority: 'critical',
  tags: ['typescript', 'async'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Always `await` or explicitly `.catch()` rejected promises. Floating promises hide errors and produce nondeterministic ordering.',
});

export const TS_ERROR_HANDLING = ruleSnippet({
  id: 'ts.error-handling',
  title: 'Model expected failures, do not swallow errors',
  priority: 'critical',
  tags: ['typescript', 'errors'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Throw typed errors (or use Result types) for expected failure paths. Preserve `cause` when wrapping. Never `catch (e) { /* ignore */ }`.',
});

export const TS_NO_DEEP_IMPORTS = ruleSnippet({
  id: 'ts.no-deep-imports',
  title: 'No deep imports across package boundaries',
  priority: 'critical',
  tags: ['typescript', 'monorepo'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Import only from a package\'s public entrypoint (`@scope/pkg`), never from internal files (`@scope/pkg/src/internal/...`).',
});

export const TS_VALIDATE_BOUNDARY_INPUT = ruleSnippet({
  id: 'ts.validate-boundary-input',
  title: 'Validate untrusted input at boundaries',
  priority: 'high',
  tags: ['typescript', 'safety'],
  appliesWhen: ['generate-code'],
  content: 'External payloads (HTTP, IPC, files) must be parsed/validated (e.g. zod, custom guard) before crossing into the typed domain.',
});

export const TS_BRANDED_IDS = ruleSnippet({
  id: 'ts.branded-ids',
  title: 'Brand critical identifiers',
  priority: 'medium',
  tags: ['typescript', 'modeling'],
  appliesWhen: ['generate-code'],
  content: 'For ids that travel widely (UserId, OrderId, etc.) use branded types so they cannot be accidentally swapped with raw strings/numbers.',
});

export const TS_NO_CIRCULAR_IMPORTS = ruleSnippet({
  id: 'ts.no-circular-imports',
  title: 'No circular imports',
  priority: 'critical',
  tags: ['typescript', 'monorepo'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Cycles produce unpredictable initialisation order. If you need bidirectional knowledge, split into a shared types module both sides depend on.',
});

export const TS_AGENT_SMALL_DIFFS = ruleSnippet({
  id: 'ts.agent.small-diffs',
  title: 'Prefer small incremental changes',
  priority: 'high',
  tags: ['typescript', 'agent'],
  appliesWhen: ['generate-code', 'refactor'],
  content: 'AI agents must inspect existing patterns before generating. Prefer minimal, targeted changes; do not rewrite architecture without an explicit instruction.',
});

// ─── Modern Angular rules ──────────────────────────────────────────────────

export const NG_STANDALONE_COMPONENTS = ruleSnippet({
  id: 'angular.standalone-components',
  title: 'Prefer standalone components',
  priority: 'high',
  tags: ['angular', 'architecture'],
  appliesWhen: ['generate-code'],
  content: 'New components, directives and pipes should be standalone unless an existing NgModule contract requires otherwise.',
});

export const NG_ON_PUSH = ruleSnippet({
  id: 'angular.on-push',
  title: 'Use OnPush change detection',
  priority: 'high',
  tags: ['angular', 'performance'],
  appliesWhen: ['generate-code'],
  content: 'Components default to `ChangeDetectionStrategy.OnPush` unless they intentionally rely on default CD. Combine with signals/observables for explicit reactivity.',
});

export const NG_SIGNALS_FIRST = ruleSnippet({
  id: 'angular.signals-first',
  title: 'Prefer signals for local reactive state',
  priority: 'high',
  tags: ['angular', 'signals'],
  appliesWhen: ['generate-code'],
  content: 'Use `signal()` for local state and `computed()` for derived values. Use `effect()` only for side effects (DOM/I/O). Do not write to signals inside effects.',
});

export const NG_RXJS_NO_NESTED_SUBSCRIBE = ruleSnippet({
  id: 'angular.rxjs.no-nested-subscribe',
  title: 'No nested `subscribe`',
  priority: 'critical',
  tags: ['angular', 'rxjs'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Use `switchMap` / `concatMap` / `mergeMap` / `exhaustMap` deliberately to compose streams. A second `.subscribe()` inside a `.subscribe()` body is almost always a bug.',
});

export const NG_LIFECYCLE_SAFE_CLEANUP = ruleSnippet({
  id: 'angular.rxjs.lifecycle-cleanup',
  title: 'Use lifecycle-safe cleanup for subscriptions',
  priority: 'high',
  tags: ['angular', 'rxjs'],
  appliesWhen: ['generate-code'],
  content: 'Wire subscriptions through `takeUntilDestroyed()` (Angular 16+) or a destroy `Subject` so observables tear down with the component.',
});

export const NG_TRACK_BY = ruleSnippet({
  id: 'angular.track-by',
  title: 'Use `trackBy` / `@for track`',
  priority: 'high',
  tags: ['angular', 'performance'],
  appliesWhen: ['generate-code'],
  content: 'Always supply a `trackBy` function (or `track` expression in the new control flow) for lists to avoid full DOM re-rendering on every change.',
});

export const NG_NO_BUSINESS_LOGIC_IN_TEMPLATE = ruleSnippet({
  id: 'angular.no-business-logic-in-template',
  title: 'Keep business logic out of templates',
  priority: 'medium',
  tags: ['angular', 'components'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Templates should bind to fields, signals, getters and pipes. Complex predicates or transformations belong in the component class or a pure pipe.',
});

export const NG_TYPED_REACTIVE_FORMS = ruleSnippet({
  id: 'angular.typed-reactive-forms',
  title: 'Use typed reactive forms',
  priority: 'high',
  tags: ['angular', 'forms'],
  appliesWhen: ['generate-code'],
  content: 'Prefer typed `FormGroup<T>` / `FormControl<T>` so the form value matches the domain model. Avoid `any` form values.',
});

export const NG_LAZY_ROUTES = ruleSnippet({
  id: 'angular.lazy-routes',
  title: 'Lazy-load feature routes',
  priority: 'high',
  tags: ['angular', 'routing', 'performance'],
  appliesWhen: ['generate-code'],
  content: 'Use `loadComponent` / `loadChildren` for feature routes so the initial bundle stays small. Heavy components should not be eager-loaded.',
});

export const NG_GUARDS_SMALL = ruleSnippet({
  id: 'angular.guards-small',
  title: 'Keep guards / resolvers small',
  priority: 'medium',
  tags: ['angular', 'routing'],
  appliesWhen: ['generate-code'],
  content: 'Guards/resolvers should make a decision quickly. Business logic belongs in a service called by the guard, not inline.',
});

export const NG_NO_DEEP_LIB_IMPORTS = ruleSnippet({
  id: 'angular.no-deep-lib-imports',
  title: 'No deep imports across libraries',
  priority: 'critical',
  tags: ['angular', 'monorepo'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Import from a library\'s `index.ts` barrel only. Deep paths break Nx boundaries and the public API contract.',
});

export const NG_FEATURE_FOLDERS = ruleSnippet({
  id: 'angular.feature-folders',
  title: 'Prefer feature-oriented folders',
  priority: 'medium',
  tags: ['angular', 'architecture'],
  appliesWhen: ['generate-code'],
  content: 'Group component + service + tests by feature, not by file kind. Avoid `components/`, `services/`, etc. as top-level grab-bags.',
});

export const NG_NO_GOD_SERVICES = ruleSnippet({
  id: 'angular.no-god-services',
  title: 'Avoid god services',
  priority: 'high',
  tags: ['angular', 'services'],
  appliesWhen: ['generate-code'],
  content: 'A service should own a focused concern. If a service mixes UI state, API calls, and business rules, split it.',
});

export const NG_DOMAIN_NO_UI_IMPORTS = ruleSnippet({
  id: 'angular.domain.no-ui-imports',
  title: 'Domain services must not import UI',
  priority: 'critical',
  tags: ['angular', 'boundaries'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Domain / data services live below the UI layer. They must not import components, templates, or anything from `@angular/animations`/`@angular/router`.',
});

export const NG_ACCESSIBLE = ruleSnippet({
  id: 'angular.accessible',
  title: 'Semantic HTML + keyboard support',
  priority: 'high',
  tags: ['angular', 'a11y'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Interactive elements must be reachable by keyboard, have visible focus, and use semantic HTML. Use ARIA only where semantic HTML is insufficient.',
});

export const NG_AVOID_BYPASS_SECURITY = ruleSnippet({
  id: 'angular.security.no-bypass',
  title: 'Avoid `bypassSecurityTrust*`',
  priority: 'critical',
  tags: ['angular', 'security'],
  appliesWhen: ['generate-code', 'review'],
  content: '`DomSanitizer.bypassSecurityTrust*` opens an XSS hole. Only use it with reviewed, trusted inputs — sanitize otherwise.',
});

export const NG_PLUGIN_STABLE_CONTRACT = ruleSnippet({
  id: 'angular.plugin.stable-contract',
  title: 'Plugin contracts are stable',
  priority: 'critical',
  tags: ['angular', 'plugins'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Plugin manifests, lifecycle hooks, and capability tokens are public API. Breaking changes require a migration note and a major-version bump.',
});

export const NG_PLUGIN_NO_DEEP_IMPORTS = ruleSnippet({
  id: 'angular.plugin.no-deep-imports',
  title: 'Plugins cannot deep-import each other',
  priority: 'critical',
  tags: ['angular', 'plugins', 'boundaries'],
  appliesWhen: ['generate-code', 'review'],
  content: 'Plugin-to-plugin communication must use the documented event/token contract. Direct imports between plugin packages are forbidden.',
});
