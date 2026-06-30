# MCP report surfaces

The MCP server exposes the same runtime reports as `shrk report ...` via
read-only tools. Each tool returns data plus a `nextCommand` hint pointing
to the CLI — the server never writes files, never runs shell commands,
and never embeds external assets in HTML responses.

## Tools

| Tool                              | Inputs                                                      | Output                              |
|-----------------------------------|-------------------------------------------------------------|-------------------------------------|
| `get_adoption_report`             | `format?`                                                   | adoption report (json/html/md/text) |
| `get_coverage_report_rendered`    | `format?`                                                   | coverage                            |
| `get_drift_report_rendered`       | `format?`                                                   | drift                               |

`format` accepts `text|markdown|html|json`. Default is `html` for the
HTML-shaped tools and `json` for the rendered tools.

## Response shape

HTML / markdown / text:

```jsonc
{ "text": "<rendered body>", "data": { "format": "html", "schema": "...", "nextCommand": "shrk report ...", "note": "MCP cannot write ..." } }
```

JSON:

```jsonc
{ "data": { "format": "json", "report": { /* … */ }, "nextCommand": "shrk report ... --format json" } }
```

## Safety contract

- `canWrite` is `false` for every tool.
- HTML never references external CSS or JS.
- HTML user-supplied strings are escaped.
- Tools never spawn child processes — no `git apply`, no shell.

The `shrk safety audit` command (and `get_safety_audit` MCP tool) keeps
this invariant under test: any tool that flips `canWrite=true` fails the
audit immediately.
