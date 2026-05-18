# dashboard-e2e-target

Fixture used by the Playwright dashboard E2E suite. Intentionally minimal:

- `package.json` so `inspectSharkcraft` has a valid workspace root.
- `src/app.ts` so onboarding inference has something to look at.
- `.sharkcraft/sessions/<id>/` with a `session.json`, intent, plan, and report
  — exercises the sessions list, session detail, and HTML report iframe.

Do **not** edit this fixture from inside Playwright tests directly. If a test
needs to mutate state, copy this directory to a tmpdir first.
