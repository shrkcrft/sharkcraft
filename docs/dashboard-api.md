# Dashboard API

SharkCraft's dashboard API is a **local, read-only** JSON layer that prepares
the backend for a future React/Vite dashboard. It ships in two pieces:

- **`@shrkcrft/dashboard-api`** — versioned TypeScript contract types. No
  runtime logic. The future dashboard imports these without pulling any
  engine code.
- **`shrk dashboard serve`** — a local HTTP server that returns
  `IDashboardApiEnvelope<T>` payloads. GET/HEAD only. Localhost-bound by
  default. No write endpoints exist anywhere in the surface.

## Schema id

All payloads share the envelope `sharkcraft.dashboard-api/v1`:

```json
{
  "schema": "sharkcraft.dashboard-api/v1",
  "generatedAt": "2026-05-13T12:00:00Z",
  "projectRoot": "/abs/path",
  "commandHints": ["shrk doctor"],
  "warnings": [],
  "data": { ... }
}
```

Adding new optional fields is non-breaking. Renaming or removing fields
requires a major bump (`sharkcraft.dashboard-api/v2` etc.).

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET    | `/api/health`                 | `IDashboardHealthResponse` (readOnly: true) |
| GET    | `/api/capabilities`           | `IDashboardCapabilitiesResponse` |
| GET    | `/api/overview`               | `IDashboardOverviewResponse` |
| GET    | `/api/doctor`                 | `IDashboardDoctorResponse` |
| GET    | `/api/quality`                | `IDashboardQualityResponse` |
| GET    | `/api/safety`                 | `IDashboardSafetyResponse` |
| GET    | `/api/commands`               | `IDashboardCommandsResponse` |
| GET    | `/api/packs`                  | `IDashboardPacksResponse` |
| GET    | `/api/presets`                | `IDashboardPresetsResponse` |
| GET    | `/api/pipelines`              | `IDashboardPipelinesResponse` |
| GET    | `/api/sessions`               | `IDashboardSessionsResponse` |
| GET    | `/api/sessions/:id`           | `IDashboardSessionDetailResponse` |
| GET    | `/api/architecture`           | `IDashboardArchitectureResponse` |
| GET    | `/api/architecture/boundaries`| `IDashboardBoundaryResponse` |
| GET    | `/api/architecture/drift`     | `IDashboardDriftResponse` |
| GET    | `/api/architecture/coverage`  | `IDashboardCoverageResponse` |
| GET    | `/api/graph`                  | `IDashboardGraphResponse` |
| GET    | `/api/graph/node/:id`         | `IDashboardGraphNodeResponse` |
| GET    | `/api/graph/why?from=&to=`    | `IDashboardGraphPathResponse` |
| GET    | `/api/onboarding`             | `IDashboardOnboardingResponse` |
| GET    | `/api/onboarding/adoption`    | `IDashboardAdoptionResponse` |
| GET    | `/api/reports`                | `IDashboardReportsResponse` |
| GET    | `/api/review`                 | `IDashboardReviewResponse` |
| GET    | `/api/scaffolds`              | `IDashboardScaffoldsResponse` |
| GET    | `/api/schemas`                | `IDashboardSchemasResponse` |
| GET    | `/api/mcp`                    | `IDashboardMcpResponse` |

Any other method or path returns 405 / 404 with a JSON error body — there
are **no write endpoints**.

## Safety guarantees

These guarantees are unconditional and exercised by tests:

- `req.method !== 'GET' && req.method !== 'HEAD'` → `405 Method Not Allowed`
  with `Allow: GET, HEAD`.
- `/api/health` always returns `readOnly: true` and `apiVersion: "1"`.
- `/api/capabilities.writeEndpoints` is the empty array.
- `/api/capabilities.dangerousActions` is the empty array.
- The server binds `127.0.0.1` by default. Any other host emits a stderr
  warning before listening.
- No endpoint reads request bodies, applies plans, mutates source, or runs
  shell.

## CLI

```bash
shrk dashboard serve                       # 127.0.0.1, random port
shrk dashboard serve --port 9876           # fixed port
shrk dashboard serve --host 0.0.0.0        # WARN logged; you opt in
shrk dashboard serve --open                # macOS: opens default browser
```

## Future dashboard usage

A future dashboard (React/Vite) imports types only:

```ts
import type {
  IDashboardApiEnvelope,
  IDashboardOverviewResponse,
} from '@shrkcrft/dashboard-api';

const env = (await fetch('/api/overview').then((r) => r.json())) as
  IDashboardApiEnvelope<IDashboardOverviewResponse>;
```

The server stays in the CLI package; the contract package is shipped
separately so the UI never depends on engine internals.
