// NestJS 11+ preset family.
//
// Seven focused presets covering modern Nest practice — architecture,
// validation, async lifecycle, performance, security, observability,
// testing — plus one comprehensive `nest-11-modern` that composes them.
// Targets HasNestJS workspaces with weight set above the legacy R26
// `nestjs-service` (weight 7) and R47 `nest-service` canonical alias
// (weight 9), so the recommender prefers these when the workspace
// declares HasNestJS.

import { WorkspaceProfile } from '@shrkcrft/workspace';
import { definePreset } from '../define/define-preset.ts';
import type { IPreset } from '../model/preset.ts';
import {
  COMMON_AGENT_BRIEFING,
  COMMON_PIPELINE_CONTEXT_ONLY,
  COMMON_PIPELINE_FEATURE_DEV,
  COMMON_PIPELINE_UNIT_TEST,
  COMMON_SAFETY_RULE,
  NEST_PATH_E2E,
  NEST_PATH_SRC,
  OVERVIEW_DOC,
} from './shared-snippets.ts';
import {
  NEST11_API_VERSIONING,
  NEST11_ASYNC_PROVIDERS,
  NEST11_CACHE_MANAGER,
  NEST11_CLASS_VALIDATOR_DTO,
  NEST11_DTO_AT_BOUNDARY,
  NEST11_E2E_SUPERTEST,
  NEST11_ENABLE_SHUTDOWN_HOOKS,
  NEST11_EXPLICIT_CORS,
  NEST11_FASTIFY_ADAPTER,
  NEST11_GLOBAL_VALIDATION_PIPE,
  NEST11_HELMET,
  NEST11_JWT_GUARDS,
  NEST11_LIFECYCLE_HOOKS,
  NEST11_LOGGER_WITH_CONTEXT,
  NEST11_MODULE_PER_FEATURE,
  NEST11_MODULE_PUBLIC_API,
  NEST11_NO_CIRCULAR_MODULES,
  NEST11_NO_LOG_SECRETS,
  NEST11_NO_QUERY_IN_CONTROLLER,
  NEST11_NO_SECRETS_IN_CODE,
  NEST11_PAGINATION_BY_DEFAULT,
  NEST11_REQUEST_RESPONSE_DTOS,
  NEST11_SERVICE_OWNS_DOMAIN,
  NEST11_STRUCTURED_LOGS,
  NEST11_SWAGGER_DECORATORS,
  NEST11_TERMINUS_HEALTH,
  NEST11_TEST_FILE_LAYOUT,
  NEST11_TESTING_MODULE,
  NEST11_THIN_CONTROLLERS,
  NEST11_THROTTLER,
  NEST11_TRUST_PROXY_AWARE,
} from './nest11-snippets.ts';

const NEST11_TAGS = ['nestjs', 'nest-11', 'backend'];
const NEST11_NEXT_COMMANDS = [
  'shrk doctor',
  'shrk task "<task>"',
  'shrk ci scaffold github-actions --quickstart',
];

// ─── 1) Architecture — modules, controllers, services, repos ─────────────

export const NEST_11_ARCHITECTURE: IPreset = definePreset({
  id: 'nest-11-architecture',
  title: 'NestJS 11 — module + controller + service architecture',
  description:
    'Module-per-feature, thin controllers (validate + delegate, nothing more), services own domain logic, repositories abstract data access, DTOs at every HTTP boundary, no circular module dependencies. The structural backbone of a maintainable Nest service.',
  tags: [...NEST11_TAGS, 'architecture'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_THIN_CONTROLLERS,
      NEST11_SERVICE_OWNS_DOMAIN,
      NEST11_MODULE_PER_FEATURE,
      NEST11_MODULE_PUBLIC_API,
      NEST11_NO_CIRCULAR_MODULES,
      NEST11_DTO_AT_BOUNDARY,
      NEST11_NO_QUERY_IN_CONTROLLER,
    ],
    paths: [NEST_PATH_SRC, NEST_PATH_E2E],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 architecture',
        'Module per feature under src/<feature>/. Controllers parse + delegate. Services own domain logic; data access goes through repositories. Modules export only their public providers. DTOs at every boundary; entities never leave the service layer.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 2) Validation — ValidationPipe + class-validator + DTOs ─────────────

export const NEST_11_VALIDATION: IPreset = definePreset({
  id: 'nest-11-validation',
  title: 'NestJS 11 — strict validation at the boundary',
  description:
    'Global ValidationPipe with whitelist + forbidNonWhitelisted + transform, class-validator decorators on every DTO field, separated request and response DTOs, @ApiProperty annotations for the OpenAPI contract.',
  tags: [...NEST11_TAGS, 'validation'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_GLOBAL_VALIDATION_PIPE,
      NEST11_CLASS_VALIDATOR_DTO,
      NEST11_REQUEST_RESPONSE_DTOS,
      NEST11_DTO_AT_BOUNDARY,
      NEST11_SWAGGER_DECORATORS,
    ],
    paths: [NEST_PATH_SRC],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 validation',
        'ValidationPipe is registered globally with strict options. Every DTO is a class with class-validator decorators; @Type() wires nested objects through class-transformer. Request and response DTOs are separate classes — input is whitelisted, output is projected.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 3) Async lifecycle + graceful shutdown ──────────────────────────────

export const NEST_11_ASYNC_LIFECYCLE: IPreset = definePreset({
  id: 'nest-11-async-lifecycle',
  title: 'NestJS 11 — async providers + graceful shutdown',
  description:
    'Async configuration providers via useFactory, OnModuleInit / OnApplicationBootstrap / OnModuleDestroy / OnApplicationShutdown lifecycle hooks, enableShutdownHooks() at bootstrap so SIGTERM cleanly tears down DB pools and message clients.',
  tags: [...NEST11_TAGS, 'lifecycle'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_LIFECYCLE_HOOKS,
      NEST11_ENABLE_SHUTDOWN_HOOKS,
      NEST11_ASYNC_PROVIDERS,
    ],
    paths: [NEST_PATH_SRC],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 lifecycle',
        'enableShutdownHooks() in main.ts so the OnModuleDestroy / OnApplicationShutdown hooks fire on SIGTERM. Configuration that must resolve at boot uses { useFactory } async providers — not lazy init from inside a service.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 4) Performance — Fastify, cache, throttler, pagination ──────────────

export const NEST_11_PERFORMANCE: IPreset = definePreset({
  id: 'nest-11-performance',
  title: 'NestJS 11 — Fastify, caching, throttling, pagination',
  description:
    'NestFastifyApplication adapter for ~2× throughput vs. Express, @nestjs/cache-manager for hot reads, @nestjs/throttler for per-IP rate limiting, mandatory pagination on every list endpoint.',
  tags: [...NEST11_TAGS, 'performance'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_FASTIFY_ADAPTER,
      NEST11_CACHE_MANAGER,
      NEST11_THROTTLER,
      NEST11_PAGINATION_BY_DEFAULT,
    ],
    paths: [NEST_PATH_SRC],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 performance',
        'Fastify adapter for high-throughput HTTP. Idempotent GETs cached via CacheInterceptor with explicit per-route TTLs. Global ThrottlerModule with sane defaults (60 req/min/IP); per-route overrides via @Throttle. List endpoints paginate by default; pageSize is capped server-side.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 5) Security — helmet, CORS, auth, secrets, trust-proxy ──────────────

export const NEST_11_SECURITY: IPreset = definePreset({
  id: 'nest-11-security',
  title: 'NestJS 11 — security baseline',
  description:
    'helmet middleware for HTTP security headers, explicit CORS allowlist (never `origin: true`), JWT auth via @nestjs/passport guards, no-secrets-in-source enforcement, trust-proxy configured for load-balanced deployments, throttler for abuse protection.',
  tags: [...NEST11_TAGS, 'security'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_HELMET,
      NEST11_EXPLICIT_CORS,
      NEST11_JWT_GUARDS,
      NEST11_NO_SECRETS_IN_CODE,
      NEST11_TRUST_PROXY_AWARE,
      NEST11_THROTTLER,
    ],
    paths: [NEST_PATH_SRC],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 security',
        'helmet registered before any route. CORS allowlist explicit. Authentication runs through Guards (JwtAuthGuard + @UseGuards), not middleware. Secrets come from ConfigService.get only. trust-proxy configured. Throttler in place.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 6) Observability — Logger, structured logs, terminus ────────────────

export const NEST_11_OBSERVABILITY: IPreset = definePreset({
  id: 'nest-11-observability',
  title: 'NestJS 11 — structured logging + health checks',
  description:
    'Per-provider Logger instances with context names, structured JSON logs in production (pino / nest-winston), redact-list for secrets and PII, @nestjs/terminus health checks with separated liveness and readiness endpoints.',
  tags: [...NEST11_TAGS, 'observability'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_LOGGER_WITH_CONTEXT,
      NEST11_STRUCTURED_LOGS,
      NEST11_NO_LOG_SECRETS,
      NEST11_TERMINUS_HEALTH,
    ],
    paths: [NEST_PATH_SRC],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_FEATURE_DEV],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 observability',
        'Each provider holds its own Logger(MyService.name). Production logger is structured JSON via pino or nest-winston with a redact list for tokens / passwords / PII. /health/liveness and /health/readiness are separate endpoints; readiness fails 503 when a critical dep is down.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 7) Testing — TestingModule + e2e ───────────────────────────────────

export const NEST_11_TESTING: IPreset = definePreset({
  id: 'nest-11-testing',
  title: 'NestJS 11 — TestingModule + supertest e2e',
  description:
    'Unit tests via Test.createTestingModule + overrideProvider for slow deps, co-located *.spec.ts files; e2e under test/*.e2e-spec.ts driving the real AppModule through supertest with the validation pipeline live.',
  tags: [...NEST11_TAGS, 'testing'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend],
  weight: 11,
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      NEST11_TESTING_MODULE,
      NEST11_E2E_SUPERTEST,
      NEST11_TEST_FILE_LAYOUT,
    ],
    paths: [NEST_PATH_SRC, NEST_PATH_E2E],
    templates: [],
    pipelines: [COMMON_PIPELINE_CONTEXT_ONLY, COMMON_PIPELINE_UNIT_TEST],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 testing',
        'Unit specs are co-located beside their unit; they use Test.createTestingModule + overrideProvider to fake the expensive deps. E2E specs live under test/, drive AppModule through supertest, and keep the real validation pipeline + guards + interceptors active — that is the contract being tested.',
      ),
    },
  },
  recommendedNextCommands: NEST11_NEXT_COMMANDS,
});

// ─── 8) The whole stack — composes 1-7 ──────────────────────────────────

export const NEST_11_MODERN: IPreset = definePreset({
  id: 'nest-11-modern',
  title: 'NestJS 11 — modern stack (architecture + validation + lifecycle + perf + security + obs + testing)',
  description:
    'The canonical preset for a new NestJS 11+ service. Composes the seven focused presets, then layers on API versioning. Use this unless you specifically want a narrower slice.',
  tags: [...NEST11_TAGS, 'comprehensive'],
  appliesTo: [WorkspaceProfile.HasNestJS, WorkspaceProfile.IsBackend, WorkspaceProfile.IsService],
  weight: 12,
  composes: [
    'nest-11-architecture',
    'nest-11-validation',
    'nest-11-async-lifecycle',
    'nest-11-performance',
    'nest-11-security',
    'nest-11-observability',
    'nest-11-testing',
  ],
  includes: {
    knowledge: [COMMON_AGENT_BRIEFING],
    rules: [
      COMMON_SAFETY_RULE,
      // Extras that don't fit any single focused preset:
      NEST11_API_VERSIONING,
    ],
    paths: [NEST_PATH_SRC, NEST_PATH_E2E],
    templates: [],
    pipelines: [
      COMMON_PIPELINE_CONTEXT_ONLY,
      COMMON_PIPELINE_FEATURE_DEV,
      COMMON_PIPELINE_UNIT_TEST,
    ],
    docs: {
      'overview.md': OVERVIEW_DOC(
        'NestJS 11 modern stack',
        'Module-per-feature architecture. Thin controllers, services own domain, repositories abstract data. Global ValidationPipe + class-validator. Fastify adapter, cache-manager, throttler, mandatory pagination. helmet + CORS allowlist + JWT guards + no-secrets. Per-provider Logger + structured JSON logs + terminus health. TestingModule unit specs + supertest e2e. URI versioning when the API has external consumers.',
      ),
    },
  },
  recommendedNextCommands: [
    'shrk doctor',
    'shrk task "<task>"',
    'shrk ci scaffold github-actions --quickstart',
    'nest g resource <feature>',
  ],
});

export const NEST_11_PRESETS: readonly IPreset[] = Object.freeze([
  NEST_11_ARCHITECTURE,
  NEST_11_VALIDATION,
  NEST_11_ASYNC_LIFECYCLE,
  NEST_11_PERFORMANCE,
  NEST_11_SECURITY,
  NEST_11_OBSERVABILITY,
  NEST_11_TESTING,
  NEST_11_MODERN,
]);
