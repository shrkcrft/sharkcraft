# Modern Angular preset

`modern-angular` is a baseline Angular preset for signal-aware, standalone-
first, OnPush-driven, RxJS-disciplined apps. Sub-presets carve out granular
slices: signals-first, RxJS, standalone components, enterprise architecture,
performance, testing, accessibility, security.

Apply via:

```bash
shrk presets get modern-angular
shrk ingest repository --preset modern-angular --write-drafts
```

## Composed presets

`modern-angular` `composes` `strict-typescript` and `generic-safe-repo`.

## Rules shipped (representative)

The preset ships a curated subset of the full Modern Angular taxonomy
described below. Pair the preset with `shrk ingest repository --write-drafts`
to bring it into your repo as drafts.

### Architecture

- `angular.standalone-components`
- `angular.feature-folders`
- `angular.no-deep-lib-imports`
- `angular.domain.no-ui-imports`

### Signals

- `angular.signals-first`
- `angular.on-push`

### RxJS

- `angular.rxjs.no-nested-subscribe`
- `angular.rxjs.lifecycle-cleanup`

### Templates / components

- `angular.no-business-logic-in-template`
- `angular.track-by`

### Forms

- `angular.typed-reactive-forms`

### Routing

- `angular.lazy-routes`
- `angular.guards-small`

### Services

- `angular.no-god-services`

### Accessibility / security

- `angular.accessible`
- `angular.security.no-bypass`

## Adoption modes

Modern Angular ships an `angular-modes.md` task file describing four
adoption modes:

- **strict** — apply every rule.
- **gradual** — adopt boundaries + signals discipline first.
- **migration** — code transformation toward modern Angular.
- **greenfield** — new projects start strict.

## Sub-presets

| Id | Focus |
|---|---|
| `angular-signals-first` | `signal()` / `computed()` / `effect()` discipline. |
| `angular-rxjs-disciplined` | No nested `subscribe`; lifecycle-safe cleanup. |
| `angular-standalone-components` | Standalone over NgModule. |
| `angular-enterprise-architecture` | Library boundaries, public APIs, Nx tags. |
| `angular-performance` | OnPush + trackBy + lazy routes. |
| `angular-testing` | Behaviour over snapshots; deterministic async. |
| `angular-accessibility` | Semantic HTML + keyboard + focus management. |
| `angular-security` | No `bypassSecurityTrust*`; validate route params. |

## Transformational intent

If the workspace is not Angular yet (no `@angular/*` dependency) and you
still pass `--preset modern-angular`, the ingest pipeline records a
**transformational intent**: the preset is treated as adaptation guidance
for moving the repo toward Modern Angular, not as a strict match. See
`shrk ingest repository --preset modern-angular --json` and look for
`transformationalIntents`.
