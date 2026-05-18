---
id: doc.architecture
title: Architecture
type: architecture
priority: medium
scope: backend
tags: architecture
---

# Architecture

The service runs as a single Bun process exposing HTTP via `Bun.serve()`.

```
src/server.ts      → routing / request parsing
   ↓
src/services/*     → business logic
   ↓
src/storage/*      → persistence adapters (interface + impl)
src/utils/*        → pure helpers
src/observability/ → logger / metrics
```

## Rules

- Routes are thin; they parse and call a service. No DB calls in route handlers.
- Each service exposes a small typed surface. Constructors only wire deps; `init()` runs setup.
- Tests target services and utilities, never the HTTP layer.

## Decisions

- **No HTTP framework** for v0.1. Bun.serve() is enough. Switching needs an ADR
  — see knowledge entry `decision.no-framework`.
