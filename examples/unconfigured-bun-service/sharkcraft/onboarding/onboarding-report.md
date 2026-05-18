# SharkCraft onboarding report

## Project summary

- Project root: `/Users/varadibence/IdeaProjects/sharkcraft2/examples/unconfigured-bun-service`
- Name: `@example/unconfigured-bun-service`
- Description: A small Bun + TS service used as a dogfood target for `shrk onboard`. No sharkcraft/ folder on purpose.
- Package manager: `unknown`
- SharkCraft folder present: yes
- Profiles: `has-bun`, `has-typescript`, `has-bun-test`, `has-tests`

## AI-readiness — current vs. expected

- Current: **poor** (score 19/100)
- Expected after drafts: **poor** (score ~38/100)

Top improvements:
- Create sharkcraft/sharkcraft.config.ts.
- Adopt 3 inferred rules.
- Adopt 4 inferred path conventions.
- Adopt 4 pipelines.
- Author boundary rules once your layer boundaries stabilise.

## Recommended presets

- **strict-typescript** (medium, score 13) — Strict TypeScript
  - matches profile: has-typescript
- **clean-architecture-ts** (medium, score 11) — Clean Architecture (TypeScript)
  - matches profile: has-typescript
- **typescript-library** (medium, score 9) — TypeScript library
  - matches profile: has-typescript
  - missing profile: is-library
- **node-service** (medium, score 9) — Node.js service (TypeScript)
  - matches profile: has-typescript
  - missing profile: is-service
- **npm-package** (medium, score 9) — npm package
  - matches profile: has-typescript
  - missing profile: is-library

## Suggested files

Drafts are written under `sharkcraft/onboarding/` only.
No existing rules.ts / paths.ts / templates.ts is overwritten.

- `sharkcraft/onboarding/onboarding-report.md`
- `sharkcraft/onboarding/inferred-rules.draft.ts`
- `sharkcraft/onboarding/inferred-paths.draft.ts`
- `sharkcraft/onboarding/inferred-templates.draft.ts`
- `sharkcraft/onboarding/inferred-boundaries.draft.ts`
- `sharkcraft/onboarding/inferred-pipelines.draft.ts`

## Suggested path conventions

- **paths.src** — Application source under src/
  - patterns: `src/**`
  - reason: src/ directory present
- **paths.services** — Services in src/services/
  - patterns: `src/services/**`, `**/*.service.ts`
  - reason: src/services/ directory present
- **paths.utils** — Utilities in src/utils/
  - patterns: `src/utils/**`
  - reason: src/utils/ directory present
- **paths.tests** — Tests live in tests/
  - patterns: `tests/**`, `**/*.spec.ts`, `**/*.test.ts`
  - reason: tests/ directory present

## Suggested rules

- **project.package-manager** (medium) — Use bun for install/run
  - reason: inferred from project signals (has-bun profile)
- **typescript.strict-mode** (high) — TypeScript strict mode enabled
  - reason: tsconfig strict=true
- **testing.runner** (medium) — Run tests with `bun test`
  - reason: bun test script detected

## Suggested boundary rules

_No boundary rules inferred — layer structure not clear enough._

## Suggested templates

- **inferred.service** (high) — Service
  - New service file under src/services/.
  - target: `src/services/<name>.service.ts`
  - sample: `src/services/order.service.ts`
  - reason: 3 matching file(s) found
- **inferred.util** (medium) — Utility
  - New utility module under src/utils/.
  - target: `src/utils/<name>.util.ts`
  - sample: `src/utils/format.util.ts`
  - reason: 2 matching file(s) found
- **inferred.spec** (medium) — Spec / test file
  - New spec/test file colocated with source.
  - target: `src/<area>/<name>.spec.ts`
  - sample: `tests/user.spec.ts`
  - reason: 2 matching file(s) found

## Suggested pipelines

- **unit-test** — Unit test pipeline
  - steps: `pick-target` → `write-spec` → `run-tests`
  - reason: test runner detected
- **safe-generation** — Safe generation pipeline
  - steps: `plan` → `review` → `apply`
  - reason: TypeScript project — codegen flows benefit from plan review
- **feature-dev** — Feature development pipeline
  - steps: `plan` → `scaffold` → `wire-up` → `add-tests` → `verify`
  - reason: src/ + test runner present
- **release-check** — Release readiness pipeline
  - steps: `typecheck` → `lint` → `test` → `build` → `boundaries`
  - reason: build + test scripts present

## Verification commands

- **test** — `bun run test`
  - reason: package.json scripts.test
- **typecheck** — `bun run typecheck`
  - reason: package.json scripts.typecheck
- **lint** — `bun run lint`
  - reason: package.json scripts.lint
- **build** — `bun run build`
  - reason: package.json scripts.build

## Next commands

- `shrk onboard --write-drafts  # write drafts under sharkcraft/onboarding/`
- `shrk onboard --write-drafts --scaffold-templates  # also draft runnable templates`
- `shrk onboard --write-drafts --import-agents       # also import existing agent rules`
- `shrk onboard --diff                              # compare drafts to live config`
- `shrk doctor                  # validate config + entries`
- `shrk coverage                # see what is still missing`
- `shrk task "<task>"           # try a focused task packet`

---

Drafts are advisory. SharkCraft never overwrites rules.ts / paths.ts / templates.ts — adopt by hand.