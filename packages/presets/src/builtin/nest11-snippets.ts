// NestJS 11+ rule snippets.
//
// Covers the modern Nest service surface: module structure, thin
// controllers, DTOs with class-validator, the global ValidationPipe with
// strict options, async providers + lifecycle hooks, graceful shutdown,
// the Fastify adapter, caching, throttling, helmet, explicit CORS, JWT
// auth, structured logging via the Nest Logger, @nestjs/terminus health
// checks, and the TestingModule patterns for unit + supertest e2e.
//
// Each snippet is a string injected verbatim into a generated
// `sharkcraft/*.ts` file; `defineKnowledgeEntry`, `KnowledgeType`, and
// `KnowledgePriority` are provided by the local-mirror preamble the
// synthesizer prepends to the file.

import { ruleSnippet } from './r26-snippets.ts';

// ─── Architecture: modules, controllers, services, repos ──────────────────

export const NEST11_THIN_CONTROLLERS = ruleSnippet({
  id: 'nest11.thin-controllers',
  title: 'Controllers are thin — no business logic',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'architecture'],
  appliesWhen: ['generate-controller', 'review'],
  content:
    'Controllers parse the request (params/query/body via DTOs), call ONE service method, and return the result. No conditionals over domain rules, no inline database access, no orchestration of multiple services. If a controller method body is more than a handful of lines or branches on domain state, the logic belongs in a service.',
});

export const NEST11_SERVICE_OWNS_DOMAIN = ruleSnippet({
  id: 'nest11.service-owns-domain',
  title: 'Services own domain logic; repositories own data access',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'architecture'],
  appliesWhen: ['generate-service', 'review'],
  content:
    'Services express domain rules and orchestrate work. Data access lives behind a repository (TypeORM Repository, Prisma client, or a hand-rolled interface). Services depend on repository interfaces, not on the ORM directly — that boundary is what makes unit tests cheap.',
});

export const NEST11_MODULE_PER_FEATURE = ruleSnippet({
  id: 'nest11.module-per-feature',
  title: 'Module per feature, not per layer',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'architecture'],
  appliesWhen: ['create-feature'],
  content:
    'Each feature gets its own module under src/<feature>/ owning controller(s), service(s), DTOs, and (optionally) entities. Top-level grab-bags like ControllersModule / ServicesModule are an anti-pattern — they couple every feature to every other.',
});

export const NEST11_MODULE_PUBLIC_API = ruleSnippet({
  id: 'nest11.module-public-api',
  title: 'Each module exports its public API only',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'architecture', 'boundaries'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'A module\'s `exports: [...]` lists exactly the providers other modules may inject. Internal services stay unexported. Avoid `exports: [SomeModule]` re-exports unless you intentionally want the entire surface to be transitive.',
});

export const NEST11_NO_CIRCULAR_MODULES = ruleSnippet({
  id: 'nest11.no-circular-modules',
  title: 'Avoid circular module dependencies',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'architecture'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'If module A imports module B and B imports A, extract the shared piece into a third module that both depend on. `forwardRef()` exists to escape genuine cycles in the dependency graph, not to paper over a missing abstraction.',
});

export const NEST11_DTO_AT_BOUNDARY = ruleSnippet({
  id: 'nest11.dto-at-boundary',
  title: 'DTOs at the HTTP boundary; never expose entities',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'dto', 'security'],
  appliesWhen: ['generate-controller', 'generate-dto'],
  content:
    'Request shapes live in `<feature>.dto.ts`; response shapes either in a dedicated response DTO or as a serialized projection. Never return an ORM entity directly — that leaks internal columns (audit fields, soft-delete flags, foreign keys) and couples your HTTP contract to your schema.',
});

// ─── Validation: ValidationPipe + class-validator ─────────────────────────

export const NEST11_GLOBAL_VALIDATION_PIPE = ruleSnippet({
  id: 'nest11.global-validation-pipe',
  title: 'Global ValidationPipe with whitelist + forbidNonWhitelisted + transform',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'validation', 'security'],
  appliesWhen: ['bootstrap'],
  content:
    'main.ts registers a global ValidationPipe: `app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }))`. whitelist strips unknown properties, forbidNonWhitelisted rejects them, transform turns plain objects into the DTO class so class-validator + class-transformer decorators fire.',
});

export const NEST11_CLASS_VALIDATOR_DTO = ruleSnippet({
  id: 'nest11.class-validator-dto',
  title: 'DTOs are classes with class-validator decorators',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'validation', 'dto'],
  appliesWhen: ['generate-dto'],
  content:
    'Define DTOs as classes (not interfaces) so class-validator can attach metadata. Use @IsString, @IsInt, @IsEmail, @IsUUID, @Length, @Min, @Max, @IsOptional, @IsEnum, @IsArray + @ValidateNested + @Type(() => Inner). Mark optional fields with @IsOptional() + a `?` on the property; the ValidationPipe will skip them when absent.',
});

export const NEST11_REQUEST_RESPONSE_DTOS = ruleSnippet({
  id: 'nest11.request-response-dtos',
  title: 'Separate request DTOs from response DTOs',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'dto'],
  appliesWhen: ['generate-dto', 'generate-controller'],
  content:
    'CreateXDto, UpdateXDto, and XResponseDto are distinct classes — even when fields overlap. PartialType(CreateXDto) and PickType / OmitType from @nestjs/mapped-types compose them without duplication. This keeps the input surface (validated) and output surface (serialized) under independent control.',
});

export const NEST11_SWAGGER_DECORATORS = ruleSnippet({
  id: 'nest11.swagger-decorators',
  title: 'Annotate DTOs with @ApiProperty for OpenAPI',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'openapi', 'swagger'],
  appliesWhen: ['generate-dto'],
  content:
    'Pair each class-validator decorator with @ApiProperty / @ApiPropertyOptional from @nestjs/swagger. Set example, description, enum, and type explicitly — Swagger UI is the canonical contract reference for clients.',
});

// ─── Async lifecycle + graceful shutdown ──────────────────────────────────

export const NEST11_LIFECYCLE_HOOKS = ruleSnippet({
  id: 'nest11.lifecycle-hooks',
  title: 'Use Nest lifecycle hooks, not raw process events',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'lifecycle'],
  appliesWhen: ['generate-service'],
  content:
    'Implement OnModuleInit / OnApplicationBootstrap for warm-up, OnModuleDestroy / OnApplicationShutdown for teardown. They run in DI-resolution order, so dependencies of a provider are still live during its destroy hook. Don\'t hook process.on(\'SIGTERM\') directly — Nest already wires it via enableShutdownHooks().',
});

export const NEST11_ENABLE_SHUTDOWN_HOOKS = ruleSnippet({
  id: 'nest11.enable-shutdown-hooks',
  title: 'Call app.enableShutdownHooks() in main.ts',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'lifecycle'],
  appliesWhen: ['bootstrap'],
  content:
    'Without enableShutdownHooks() the OnModuleDestroy / OnApplicationShutdown hooks never fire on SIGTERM, leaving connections (DB pools, Kafka clients, etc.) dangling. Call it before app.listen().',
});

export const NEST11_ASYNC_PROVIDERS = ruleSnippet({
  id: 'nest11.async-providers',
  title: 'Use useFactory for async configuration providers',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'di'],
  appliesWhen: ['generate-module'],
  content:
    'Configuration that must be resolved at boot (env, secrets vault, schema generation) goes through `{ provide: TOKEN, useFactory: async (cfg) => …, inject: [ConfigService] }`. Don\'t lazy-load it inside a service\'s onModuleInit — that delays the readiness signal.',
});

// ─── Performance: Fastify, cache, throttler, pagination ──────────────────

export const NEST11_FASTIFY_ADAPTER = ruleSnippet({
  id: 'nest11.fastify-adapter',
  title: 'Use the Fastify adapter for high-throughput services',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'performance'],
  appliesWhen: ['bootstrap'],
  content:
    'NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter()) gives ~2× the RPS of the default Express adapter and matches Nest\'s typed-decorator surface. Only stay on Express if you need a middleware that isn\'t available for Fastify (rare).',
});

export const NEST11_CACHE_MANAGER = ruleSnippet({
  id: 'nest11.cache-manager',
  title: 'Cache idempotent GETs via @nestjs/cache-manager',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'performance'],
  appliesWhen: ['generate-controller', 'optimize'],
  content:
    'Register CacheModule with a TTL appropriate to the data (seconds for hot reads, minutes for slowly-changing references). Decorate idempotent GET endpoints with @UseInterceptors(CacheInterceptor) or inject CACHE_MANAGER for explicit key-based caches. Never cache user-private responses without a per-user key.',
});

export const NEST11_THROTTLER = ruleSnippet({
  id: 'nest11.throttler',
  title: 'Rate-limit with @nestjs/throttler',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'performance', 'security'],
  appliesWhen: ['bootstrap', 'generate-controller'],
  content:
    'Register ThrottlerModule globally with sane defaults (e.g. 60 requests / minute / IP), then loosen or tighten per route via @Throttle({ default: { limit, ttl } }) or @SkipThrottle() for internal endpoints. Without throttler a single client can DOS your service trivially.',
});

export const NEST11_PAGINATION_BY_DEFAULT = ruleSnippet({
  id: 'nest11.pagination-by-default',
  title: 'List endpoints paginate by default',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'performance'],
  appliesWhen: ['generate-controller'],
  content:
    'Every list endpoint accepts `?page=1&pageSize=20` (or cursor-based) and caps pageSize server-side (e.g. max 100). Returning an unbounded array works on day 1 and dies in week 3 — paginate from the start so the contract never has to break.',
});

// ─── Security: helmet, CORS, auth, secrets ────────────────────────────────

export const NEST11_HELMET = ruleSnippet({
  id: 'nest11.helmet',
  title: 'Register helmet for HTTP security headers',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'security'],
  appliesWhen: ['bootstrap'],
  content:
    'Add `app.register(helmet)` (Fastify) or `app.use(helmet())` (Express) before any route is mounted. helmet sets X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, and CSP defaults. Skipping it leaves you on every "missing security header" audit.',
});

export const NEST11_EXPLICIT_CORS = ruleSnippet({
  id: 'nest11.explicit-cors',
  title: 'CORS allowlist — never `origin: true` in production',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'security'],
  appliesWhen: ['bootstrap'],
  content:
    'Configure CORS with an explicit `origin: ["https://app.example.com"]` array (or a function that validates against an allowlist). `origin: true` reflects whatever the request sent — fine for local dev, catastrophic in prod for any cookie-/credential-bearing endpoint.',
});

export const NEST11_JWT_GUARDS = ruleSnippet({
  id: 'nest11.jwt-guards',
  title: 'Authentication via Guards, not middleware',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'security', 'auth'],
  appliesWhen: ['generate-controller'],
  content:
    'Auth runs through @nestjs/passport + a JwtAuthGuard (or custom AuthGuard) applied via @UseGuards() at controller or method level. Guards see the full execution context (request, handler metadata) and integrate with @SetMetadata for role-based / permission-based checks. Middleware can\'t do that.',
});

export const NEST11_NO_SECRETS_IN_CODE = ruleSnippet({
  id: 'nest11.no-secrets-in-code',
  title: 'Secrets come from the env, never from source',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'security'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'JWT signing keys, DB passwords, third-party API keys, encryption secrets — all loaded through @nestjs/config (ConfigService.get) from environment variables, .env (local only, in .gitignore), or a vault. A literal secret in a `.ts` file is a CVE waiting for a commit.',
});

export const NEST11_TRUST_PROXY_AWARE = ruleSnippet({
  id: 'nest11.trust-proxy-aware',
  title: 'Configure trust-proxy when behind a load balancer',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'security'],
  appliesWhen: ['bootstrap'],
  content:
    'When the service runs behind an ALB / Cloudflare / nginx, set the trust-proxy option on the adapter so req.ip + X-Forwarded-For resolve correctly. Otherwise throttler keys, audit logs, and rate-limiting all degenerate to the proxy\'s IP.',
});

// ─── Observability: Logger, structured logs, terminus ────────────────────

export const NEST11_LOGGER_WITH_CONTEXT = ruleSnippet({
  id: 'nest11.logger-with-context',
  title: 'Logger instances carry a context name',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'observability'],
  appliesWhen: ['generate-service'],
  content:
    'In each provider, do `private readonly logger = new Logger(MyService.name)`. The context name appears in every log line so filtering by component is trivial. Don\'t share a single Logger instance across the app — you lose the grouping.',
});

export const NEST11_STRUCTURED_LOGS = ruleSnippet({
  id: 'nest11.structured-logs',
  title: 'JSON-structured logs in production (pino or nest-winston)',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'observability'],
  appliesWhen: ['bootstrap', 'configure'],
  content:
    'Plug a structured logger (nestjs-pino or nest-winston) and route the Nest Logger through it. Production logs are JSON one-line records that ship cleanly into Loki / CloudWatch / Datadog. The default ConsoleLogger is fine for dev only.',
});

export const NEST11_NO_LOG_SECRETS = ruleSnippet({
  id: 'nest11.no-log-secrets',
  title: 'Never log secrets, tokens, PII, or full request bodies',
  priority: 'critical',
  tags: ['nestjs', 'nest-11', 'observability', 'security'],
  appliesWhen: ['generate-code', 'review'],
  content:
    'Redact Authorization headers, JWTs, passwords, credit-card numbers, government IDs, and full request/response bodies that may contain user data. Configure the logger redact paths once (pino: redact: [\'req.headers.authorization\', \'body.password\']) so the discipline survives drive-by edits.',
});

export const NEST11_TERMINUS_HEALTH = ruleSnippet({
  id: 'nest11.terminus-health',
  title: 'Expose /health via @nestjs/terminus with liveness + readiness',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'observability'],
  appliesWhen: ['generate-controller'],
  content:
    'Use @nestjs/terminus HealthCheckService to compose indicators (db.pingCheck, http.pingCheck, memory.heapCheck). Expose /health/liveness (process is up) AND /health/readiness (deps are reachable) separately — Kubernetes treats them differently. Don\'t return 200 from readiness when the DB is down.',
});

// ─── Testing: TestingModule + e2e ────────────────────────────────────────

export const NEST11_TESTING_MODULE = ruleSnippet({
  id: 'nest11.testing-module',
  title: 'Unit tests use Test.createTestingModule + overrideProvider',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'Build a TestingModule that imports the module under test, then `overrideProvider(SlowDep).useValue(mock)` for whatever you want to fake. Resolve the unit under test with `module.get(MyService)`. Avoid `new MyService(...)` outside of testing the constructor itself — DI is part of the contract.',
});

export const NEST11_E2E_SUPERTEST = ruleSnippet({
  id: 'nest11.e2e-supertest',
  title: 'E2E with supertest against the real AppModule',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'E2E tests bootstrap a TestingModule from AppModule, build a Nest application, and drive it with supertest (`request(app.getHttpServer()).get(...)`). Override only the truly slow/expensive deps (external HTTP, message brokers); keep the validation pipeline, guards, and interceptors live — that\'s the contract being tested.',
});

export const NEST11_TEST_FILE_LAYOUT = ruleSnippet({
  id: 'nest11.test-file-layout',
  title: 'Unit specs co-located; e2e under test/',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'testing'],
  appliesWhen: ['generate-test'],
  content:
    'Unit specs live next to the unit (`users.service.spec.ts` beside `users.service.ts`). E2E specs live under `test/*.e2e-spec.ts` — Nest\'s default jest-e2e.json glob matches that pattern. Don\'t mix the two; they have different setup costs and different debugging stories.',
});

// ─── API design ──────────────────────────────────────────────────────────

export const NEST11_API_VERSIONING = ruleSnippet({
  id: 'nest11.api-versioning',
  title: 'Enable versioning when the contract is consumed externally',
  priority: 'medium',
  tags: ['nestjs', 'nest-11', 'api'],
  appliesWhen: ['bootstrap', 'generate-controller'],
  content:
    'For any service whose API has external consumers, call `app.enableVersioning({ type: VersioningType.URI, defaultVersion: \'1\' })` at bootstrap. Annotate controllers with @Controller({ path: \'users\', version: \'1\' }). Breaking changes ship as v2 alongside v1 — never as a silent overwrite.',
});

export const NEST11_NO_QUERY_IN_CONTROLLER = ruleSnippet({
  id: 'nest11.no-query-in-controller',
  title: 'Never query the database from a controller',
  priority: 'high',
  tags: ['nestjs', 'nest-11', 'architecture'],
  appliesWhen: ['generate-controller', 'review'],
  content:
    'Repositories are injected into services, not controllers. A controller that imports `Repository<User>` or `prisma.user` directly is on the path to a 600-line "controller that does everything" — back it out into a service.',
});
