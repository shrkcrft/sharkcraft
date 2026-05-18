# Test impact analysis

`shrk tests impact --files a,b` / `shrk tests impact --plan` /
`shrk tests impact --bundle` answers: *"given these files changed, which
tests probably matter, and which tests are missing?"*

## Heuristics

- `src/foo.ts` → `tests/foo.spec.ts`, `src/foo.spec.ts`
- `*.tsx` → `*.test.tsx`
- `__tests__/<name>.test.ts` co-located conventions
- Reads `package.json scripts.test / test:unit / test:int / test:e2e`

## Output

`likelyTestFiles`, `missingTestFiles`, `testCommands`, `verificationCommands`,
`riskAreas`, `confidence`.

## Helpers

- `shrk tests suggest <file>` → idiomatic test path for a file
- `shrk tests missing --files a,b` → just the missing list

## MCP

`get_test_impact` exposes the same payload.
