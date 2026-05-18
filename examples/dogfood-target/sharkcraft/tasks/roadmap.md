---
id: tasks.roadmap
title: Roadmap
type: task
priority: medium
tags: roadmap
---

# Roadmap

## Now
- [ ] Implement `UserProfileService` with `findById` returning user + extended profile.
- [ ] Add `POST /users` route with input validation.
- [ ] Wire a real logger in `src/observability/logger.ts`.

## Next
- [ ] Persistence adapter under `src/storage/` (in-memory + sqlite).
- [ ] Add a feature folder under `src/features/audit/`.

## Later
- [ ] OpenAPI generator from service signatures.
- [ ] Decide whether to introduce Hono (needs ADR).
