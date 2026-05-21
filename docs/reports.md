# Runtime reports

`shrk report` renders runtime artifacts in text / markdown / html / json.
It reuses the same renderers as the per-feature commands, but routes them
through a single group so consumers get one consistent surface.

```bash
shrk report adoption                                  # text by default
shrk report adoption --format markdown
shrk report adoption --format html --output adopt.html
shrk report session <id> --format html
shrk report quality --format html --output quality.html
shrk report safety --format html --output safety.html
shrk report review packet.json --format html
shrk report coverage --format markdown
shrk report drift --format json
shrk report graph
```

## Formats

| Format     | What you get                                                  |
|------------|---------------------------------------------------------------|
| `text`     | Compact terminal-friendly summary (default).                  |
| `markdown` | PR-ready markdown.                                            |
| `html`     | Self-contained HTML — inline CSS, dark-mode aware, no JS.     |
| `json`     | Versioned `sharkcraft.runtime-report/v1` envelope.            |

The JSON envelope:

```jsonc
{
  "schema": "sharkcraft.runtime-report/v1",
  "reportKind": "quality",
  "generatedAt": "2026-05-12T...",
  "payload": { /* underlying report */ }
}
```

Stable + versioned so a future dashboard can consume it directly.

## Output paths

`--output <path>` writes the rendered body to the given file. Relative
paths are resolved against the project root; absolute paths are honored
as-is. No format conversion happens at write time.

## Optional flags

- `--collapse-long-sections` — wrap long sections in `<details>` when
  rendering HTML (review packets).
- `--max-items N` — cap rendered list length per section (review).
- `--include-raw-json` — reserved for future use.

## MCP

Every report has a read-only MCP equivalent. The MCP version returns the
data and a `nextCommand` hint pointing to the CLI; it never writes files.

| Tool                              | Subject       |
|-----------------------------------|---------------|
| `get_adoption_report`             | adoption      |
| `get_session_html_report`         | dev session   |
| `get_quality_html_report`         | quality       |
| `get_safety_html_report`          | safety audit  |
| `get_review_html_report`          | review packet |
| `get_coverage_report_rendered`    | coverage      |
| `get_drift_report_rendered`       | drift         |

## Safety

- No external assets in any HTML output.
- HTML escapes user-supplied strings (rule titles, file names, …).
- The CLI is the only write path; MCP returns data only.
- Reports never execute shell commands.
