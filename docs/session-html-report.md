# Session HTML report

A self-contained HTML view of a dev session — generated from the same
deterministic `session.json` as `shrk dev report`. No external assets, no
JavaScript, no network calls. Works as a `file://` URL or via a tiny local
HTTP server.

## Static generation

```bash
shrk dev report <sessionId> --html        # writes final-report.html alongside .md
shrk dev open   <sessionId> --html        # writes final-report.html only
```

The HTML inlines its CSS, so you can email it, attach it to a Linear/Jira
ticket, or stash it as a CI artifact without worrying about CDN failures.

## Local server

```bash
shrk dev open <sessionId> --serve                 # 127.0.0.1, random port
shrk dev open <sessionId> --serve --port 8765
shrk dev open <sessionId> --serve --host 0.0.0.0  # exposes — only if you really mean it
shrk dev open <sessionId> --serve --live          # SSE + auto-refresh
shrk dev open <sessionId> --serve --live --open   # also open the URL (macOS)
shrk dev open <sessionId> --serve --live --port 0 # random port
```

The default bind is `127.0.0.1`. The server re-renders on every request
(no caching), so editing `session.json` in another window surfaces
immediately. Press Ctrl+C to stop.

With `--live`, the server exposes a `GET /events` Server-Sent Events
endpoint and injects a tiny inline script + meta-refresh fallback into
the rendered HTML so the browser reloads when the session changes. A
file watcher monitors `session.json`, `plans/`, and `reports/`, debounced
at ≈200ms. SSE messages have form `event: change\ndata: <reason>\nid: <n>`.

The server refuses every non-`GET`/`HEAD` request with `405 Method Not
Allowed`. There are no write endpoints; the server is intentionally
minimal — no auth, no telemetry, no static asset serving.

## What gets rendered

- Task and phase (color-coded)
- Plans with status / signed / missing variables
- Applied plans with signature status, divergence flag, changed files
- Validations with command-by-command pass/fail
- Reports on disk (linked via `file://`)
- Commands cheat sheet (plan / apply / validate / report)
- Remaining risks
- Next action

## Tests

`packages/inspector/src/__tests__/dev-session-html.test.ts` asserts:

- the rendered HTML escapes `<`/`>`/`"` in task strings
- it includes the phase, plans table, applied plans, and validations
- the doc is a complete HTML document (`<!doctype html>`)
- the timeline reflects state transitions
