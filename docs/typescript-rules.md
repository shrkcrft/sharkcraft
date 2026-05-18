# Strict TypeScript rule library

`strict-typescript` is a baseline rule pack for projects committed to strict
TypeScript. It composes `generic-safe-repo`.

Apply via:

```bash
shrk presets get strict-typescript
shrk ingest repository --preset strict-typescript --write-drafts
```

## Rules shipped

| Id | Category | Priority |
|---|---|---|
| `ts.no-any` | type safety | critical |
| `ts.prefer-satisfies` | type safety | high |
| `ts.discriminated-unions` | modeling | high |
| `ts.readonly-default` | immutability | medium |
| `ts.public-return-types` | API design | high |
| `ts.no-floating-promises` | async | critical |
| `ts.error-handling` | errors | critical |
| `ts.no-deep-imports` | modules | critical |
| `ts.no-circular-imports` | modules | critical |
| `ts.validate-boundary-input` | safety | high |
| `ts.branded-ids` | modeling | medium |
| `repo.architecture.interface-prefix` (composed) | code style | high |
| `repo.architecture.one-export` (composed) | code style | high |
| `repo.architecture.no-logic-constructors` (composed) | code style | high |
| `ts.agent.small-diffs` | agent | high |

## Categories

The full taxonomy described in the task body covers 10 categories: type
safety, API design, error handling, async, data modeling, functions/classes,
modules/imports, testing, monorepo, AI-agent safety. The preset ships a
representative subset above; the rest can be hand-picked from
`sharkcraft/ingestion/generated/rules.draft.ts` after running ingest.

## Composes

`node-service`, `npm-package`, `nestjs-service`, `express-service`,
`fastify-service`, `modern-angular`, `react-app`, `vue-app`,
`web-component-library`, `enterprise-review-gated` all compose
`strict-typescript`.

## Apply selectively

To take only one rule from the pack, copy its `defineKnowledgeEntry({...})`
block from `sharkcraft/ingestion/generated/rules.draft.ts` into your live
`sharkcraft/rules.ts`. `shrk ingest adopt --write-patch` produces a
reviewable patch under `sharkcraft/ingestion/adoption/` instead.
