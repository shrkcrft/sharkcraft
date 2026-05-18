// Modern Angular 18 / 19 / 20 / 21 rule snippets.
//
// Covers the post-decorators wave: signal-based reactivity, signal-based
// queries (`viewChild()` / `contentChild()` etc.), signal-based I/O
// (`input()` / `output()` / `model()`), zoneless change detection, the new
// template control flow (`@if` / `@for` / `@switch` / `@defer` / `@let`),
// `inject()` over constructor DI, `afterRender` / `afterNextRender`,
// `resource()` / `httpResource()`, `linkedSignal`, `NgOptimizedImage`,
// self-closing component tags, and the no-NgModules / hybrid-rendering
// posture.
//
// Each snippet is a string injected verbatim into a generated
// `sharkcraft/*.ts` file; `defineKnowledgeEntry`, `KnowledgeType`, and
// `KnowledgePriority` are provided by the local-mirror preamble the
// synthesizer prepends.

import { ruleSnippet } from './r26-snippets.ts';

// ─── Signal-based reactivity (Angular 16+, fully baked by 19/20) ──────────

export const NG21_SIGNAL_STATE = ruleSnippet({
  id: 'angular21.signal-state',
  title: 'Local component state lives in signals',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'signals'],
  appliesWhen: ['generate-component', 'generate-code'],
  content:
    'Use signal() for every piece of component-local mutable state. Derive read-only values with computed(). Reserve effect() for side effects only (DOM imperative code, logging, external I/O) — never write to a signal from inside an effect.',
});

export const NG21_LINKED_SIGNAL = ruleSnippet({
  id: 'angular21.linked-signal',
  title: 'Use linkedSignal for writable derived state',
  priority: 'high',
  tags: ['angular', 'angular-21', 'signals'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'When you need a writable signal that resets whenever a source signal changes (e.g. a selection that follows a filtered list), use linkedSignal({ source, computation }) instead of an effect that pokes a writable signal — that pattern is officially discouraged.',
});

export const NG21_NO_EFFECT_FOR_DERIVED = ruleSnippet({
  id: 'angular21.no-effect-for-derived',
  title: 'Never derive state inside an effect()',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'signals'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'If you find yourself writing effect(() => mySignal.set(compute(otherSignal()))), switch to computed() or linkedSignal(). Writing inside effects breaks single-source-of-truth and reintroduces the very glitches signals were designed to remove.',
});

// ─── Signal-based queries (Angular 17.2+) ─────────────────────────────────

export const NG21_SIGNAL_VIEW_CHILD = ruleSnippet({
  id: 'angular21.signal-view-child',
  title: 'Use viewChild() / viewChildren() functions, not @ViewChild',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'queries', 'signals'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'Replace @ViewChild and @ViewChildren with the viewChild() / viewChildren() functions. The signal form is reactive (you can pipe it through computed()/effect()), avoids the "expression has changed after it was checked" class of bug, and integrates with OnPush + zoneless out of the box. Use viewChild.required<ElementRef>("name") when the element is guaranteed.',
});

export const NG21_SIGNAL_CONTENT_CHILD = ruleSnippet({
  id: 'angular21.signal-content-child',
  title: 'Use contentChild() / contentChildren() functions, not @ContentChild',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'queries', 'signals'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'Replace @ContentChild and @ContentChildren with the contentChild() / contentChildren() functions. Same reactivity story as viewChild — and contentChild() resolves at the same lifecycle moment regardless of static/dynamic, so you no longer need the {static: true} workaround.',
});

// ─── Signal-based inputs / outputs (Angular 17.1+ / 17.3+) ───────────────

export const NG21_SIGNAL_INPUTS = ruleSnippet({
  id: 'angular21.signal-inputs',
  title: 'Use input() and input.required(), not @Input()',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'inputs', 'signals'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'Declare inputs as `readonly user = input<User>()` or `readonly id = input.required<string>()` instead of @Input(). Signal inputs are read-only signals — call them as a function in the template (`{{ user() }}`) or pipe them through computed() in the class. Use the transform option for coerced inputs: `input(false, { transform: booleanAttribute })`.',
});

export const NG21_SIGNAL_OUTPUTS = ruleSnippet({
  id: 'angular21.signal-outputs',
  title: 'Use output(), not @Output() EventEmitter',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'outputs', 'signals'],
  appliesWhen: ['generate-component', 'refactor'],
  content:
    'Declare outputs as `readonly select = output<UserId>()` instead of `@Output() select = new EventEmitter<UserId>()`. The output() helper drops the RxJS dependency, is fully typed, and emits via `this.select.emit(id)`. It still composes with `outputToObservable()` when a stream is needed.',
});

export const NG21_MODEL_TWO_WAY = ruleSnippet({
  id: 'angular21.model-two-way',
  title: 'Use model() for two-way bindings',
  priority: 'high',
  tags: ['angular', 'angular-21', 'inputs', 'outputs', 'signals'],
  appliesWhen: ['generate-component'],
  content:
    'For components that own a piece of state the parent wants to bind two-way, use `readonly value = model<string>("")`. Banana-in-a-box syntax (`[(value)]="x"`) wires up automatically — no manual @Input + @Output pair, no `valueChange` EventEmitter.',
});

// ─── Zoneless change detection (stable in Angular 21) ─────────────────────

export const NG21_ZONELESS = ruleSnippet({
  id: 'angular21.zoneless',
  title: 'Configure zoneless change detection',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'zoneless', 'performance'],
  appliesWhen: ['bootstrap', 'configure'],
  content:
    'Bootstrap with provideZonelessChangeDetection() and remove `zone.js` from polyfills + angular.json. Once zoneless, change detection runs only when a signal changes, an input updates, an event handler fires, or a marked component opts in via markForCheck(). Verify by reading the platform: ApplicationRef.componentTypes should not include any zone-aware regressions.',
});

export const NG21_NO_ZONE_APIS = ruleSnippet({
  id: 'angular21.no-zone-apis',
  title: 'Do not call NgZone APIs in zoneless code',
  priority: 'high',
  tags: ['angular', 'angular-21', 'zoneless'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'In zoneless apps NgZone.run / runOutsideAngular are no-ops. Replace them with explicit ChangeDetectorRef.markForCheck() (rare), afterNextRender() for DOM-aware logic, or simply let the signal graph propagate.',
});

// ─── New template control flow (Angular 17+) ──────────────────────────────

export const NG21_CONTROL_FLOW = ruleSnippet({
  id: 'angular21.control-flow',
  title: 'Use @if / @for / @switch, not *ngIf / *ngFor / [ngSwitch]',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'templates'],
  appliesWhen: ['generate-template', 'refactor'],
  content:
    'Built-in control flow is the canonical form. `@if`, `@else if`, `@else`; `@for (item of items; track item.id)` — track is REQUIRED, not optional; `@switch (x) { @case (\'a\') { … } @default { … } }`. Migrate legacy structural directives with `ng generate @angular/core:control-flow`.',
});

export const NG21_DEFER = ruleSnippet({
  id: 'angular21.defer',
  title: 'Use @defer for non-critical UI',
  priority: 'high',
  tags: ['angular', 'angular-21', 'templates', 'performance'],
  appliesWhen: ['generate-template', 'optimize-bundle'],
  content:
    'Wrap heavy, below-the-fold, or interaction-gated UI in `@defer (on viewport)` / `(on hover)` / `(on idle)` / `(when condition())`. Pair with `@placeholder`, `@loading`, and `@error` blocks. Each @defer block is its own lazy-loaded chunk — no manual `loadComponent` plumbing needed.',
});

export const NG21_LET_TEMPLATE = ruleSnippet({
  id: 'angular21.let-template',
  title: 'Use @let for template-local values',
  priority: 'medium',
  tags: ['angular', 'angular-21', 'templates'],
  appliesWhen: ['generate-template'],
  content:
    'Introduce template-scoped names with `@let total = items().reduce(...)`. This replaces the `*ngIf="x as y"` aliasing trick — works anywhere in the template, no implicit-element baggage.',
});

export const NG21_SELF_CLOSING_TAGS = ruleSnippet({
  id: 'angular21.self-closing-tags',
  title: 'Self-close components with no content children',
  priority: 'low',
  tags: ['angular', 'angular-21', 'templates'],
  appliesWhen: ['generate-template'],
  content:
    'Components / directives that take no projected content should be written `<app-foo [x]="y" />`, not `<app-foo …></app-foo>`. Saves a token and matches modern Angular / JSX conventions.',
});

export const NG21_NG_OPTIMIZED_IMAGE = ruleSnippet({
  id: 'angular21.ng-optimized-image',
  title: 'Use NgOptimizedImage for raster images',
  priority: 'high',
  tags: ['angular', 'angular-21', 'performance', 'a11y'],
  appliesWhen: ['generate-template'],
  content:
    'Replace `<img src="...">` with `<img ngSrc="..." width="…" height="…" priority? />`. NgOptimizedImage adds automatic responsive `srcset`, lazy-loads non-priority images, sets fetchpriority on LCP images, and enforces explicit dimensions to prevent layout shift.',
});

// ─── inject(), afterRender, modern lifecycle (Angular 14+ / 16+) ──────────

export const NG21_INJECT_FN = ruleSnippet({
  id: 'angular21.inject-fn',
  title: 'Use inject(), not constructor parameters',
  priority: 'high',
  tags: ['angular', 'angular-21', 'di'],
  appliesWhen: ['generate-component', 'generate-service', 'refactor'],
  content:
    'Default to `private readonly users = inject(UsersService)` over constructor-parameter injection. Required for functional guards / interceptors, makes inheritance straightforward, and removes the need for `@Self()` / `@SkipSelf()` / `@Optional()` decorator stacks (use the options bag instead).',
});

export const NG21_AFTER_RENDER = ruleSnippet({
  id: 'angular21.after-render',
  title: 'Use afterNextRender / afterRender for DOM-aware logic',
  priority: 'high',
  tags: ['angular', 'angular-21', 'lifecycle'],
  appliesWhen: ['generate-component'],
  content:
    'For code that needs the DOM (measuring, focusing, third-party libs): use afterNextRender(() => …) for one-shot setup or afterRender(() => …) for every CD pass. Both run only in the browser, so they\'re SSR-safe by construction — replacing the ngAfterViewInit + isPlatformBrowser dance.',
});

export const NG21_PROVIDED_IN_ROOT = ruleSnippet({
  id: 'angular21.provided-in-root',
  title: 'Services use providedIn: \'root\' (tree-shakeable)',
  priority: 'high',
  tags: ['angular', 'angular-21', 'di', 'services'],
  appliesWhen: ['generate-service'],
  content:
    'Inject services via `@Injectable({ providedIn: "root" })` so unused services tree-shake out. Only override with component / route providers when you need a fresh instance per consumer.',
});

// ─── No NgModules / standalone-only ───────────────────────────────────────

export const NG21_NO_NGMODULES = ruleSnippet({
  id: 'angular21.no-ngmodules',
  title: 'Do not create new NgModules',
  priority: 'critical',
  tags: ['angular', 'angular-21', 'architecture'],
  appliesWhen: ['generate-code', 'create-feature'],
  content:
    'Angular 21 starter apps are NgModule-free. Components, directives, and pipes are standalone by default (the `standalone: true` flag is the default since v19). Configure providers via `provideX()` functions in bootstrapApplication() or route data, never with @NgModule. If you find yourself writing @NgModule, you are working against the grain.',
});

export const NG21_BOOTSTRAP_APPLICATION = ruleSnippet({
  id: 'angular21.bootstrap-application',
  title: 'bootstrap via bootstrapApplication + provideX functions',
  priority: 'high',
  tags: ['angular', 'angular-21', 'bootstrap'],
  appliesWhen: ['bootstrap'],
  content:
    'main.ts uses bootstrapApplication(AppComponent, { providers: [provideRouter(routes), provideHttpClient(withFetch()), provideZonelessChangeDetection(), provideAnimationsAsync()] }). Each capability has a provideX() — no AppModule needed.',
});

// ─── Async data: resource() / httpResource() (Angular 19/20+) ────────────

export const NG21_RESOURCE_API = ruleSnippet({
  id: 'angular21.resource-api',
  title: 'Model async state with resource()',
  priority: 'high',
  tags: ['angular', 'angular-21', 'async', 'signals'],
  appliesWhen: ['generate-component', 'generate-service'],
  content:
    'For "fetch X based on signal Y" patterns, use resource({ request: () => y(), loader: ({ request, abortSignal }) => fetch(...) }). The resource exposes `.value()`, `.status()`, `.error()`, and `.reload()` — a fully-typed state machine driven by signals. Don\'t hand-roll subscription + loading-state + error-state triplets anymore.',
});

export const NG21_HTTP_RESOURCE = ruleSnippet({
  id: 'angular21.http-resource',
  title: 'Use httpResource() for declarative HTTP',
  priority: 'high',
  tags: ['angular', 'angular-21', 'http', 'signals'],
  appliesWhen: ['generate-service'],
  content:
    'For straight reads, `const user = httpResource<User>(() => \\`/api/users/${id()}\\`)` replaces an HttpClient.get + BehaviorSubject + loading flag triple. The signal in the URL closure is tracked; updating it refetches.',
});

// ─── Modern SSR / hybrid rendering (Angular 19+) ─────────────────────────

export const NG21_HYBRID_RENDERING = ruleSnippet({
  id: 'angular21.hybrid-rendering',
  title: 'Configure routes with server-rendering modes',
  priority: 'medium',
  tags: ['angular', 'angular-21', 'ssr'],
  appliesWhen: ['configure-routes'],
  content:
    'In app.routes.server.ts, tag each route with a RenderMode: `Prerender` for static, `Server` for per-request SSR, `Client` for CSR-only. The default `provideServerRouting(serverRoutes)` enforces the boundary — no more "did this code accidentally run on the server?" guesswork.',
});

export const NG21_PROVIDE_HTTP_FETCH = ruleSnippet({
  id: 'angular21.provide-http-fetch',
  title: 'provideHttpClient(withFetch()) — never the XHR backend',
  priority: 'high',
  tags: ['angular', 'angular-21', 'http', 'ssr'],
  appliesWhen: ['configure'],
  content:
    'Provide HttpClient with the fetch backend (`provideHttpClient(withFetch())`). XHR breaks under SSR and pays a startup cost; fetch is universal, supports streaming, and is required for resource transfer between server and client.',
});

// ─── Forms — modern signal-compatible patterns ───────────────────────────

export const NG21_SIGNAL_FORMS_INTEROP = ruleSnippet({
  id: 'angular21.signal-forms-interop',
  title: 'Bridge reactive forms into signals with toSignal()',
  priority: 'medium',
  tags: ['angular', 'angular-21', 'forms', 'signals'],
  appliesWhen: ['generate-component'],
  content:
    'When you need a form value as a signal, do `const value = toSignal(form.valueChanges, { initialValue: form.getRawValue() })`. Don\'t mix .subscribe() into a component that otherwise relies on signal-driven CD — that subscription will leak.',
});

// ─── Testing — modern flow ───────────────────────────────────────────────

export const NG21_TEST_SIGNAL_INPUT = ruleSnippet({
  id: 'angular21.test-signal-input',
  title: 'Set signal inputs in tests via setInput()',
  priority: 'medium',
  tags: ['angular', 'angular-21', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'In TestBed, set signal-input values with `fixture.componentRef.setInput("user", u)` — not by assigning `component.user`. Detection runs only when the input signal is updated, and setInput is the supported path that triggers it.',
});

export const NG21_TEST_NO_DETECT_CHANGES_OUTSIDE = ruleSnippet({
  id: 'angular21.test-no-detect-changes-outside',
  title: 'Let the framework drive CD in tests',
  priority: 'low',
  tags: ['angular', 'angular-21', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'In zoneless tests, call `fixture.detectChanges()` only at deliberate "settle" points; signal updates inside the test run schedule the next CD automatically. Sprinkling detectChanges() after every assignment masks real reactivity bugs.',
});
