# Scaffold coverage gaps

R31 surfaces missing scaffolds before the agent hand-writes 60% of the
work.

## Commands

```bash
shrk coverage scaffolds --task "<task>" [--json]
shrk coverage scaffolds --domain <domain> [--json]
shrk task "<task>" --show-coverage-gaps
```

`--domain` accepts free-form labels (e.g. `angular`, `service`,
`polyglot`, `runtime`).

## Axes

- **knowledge** — matching knowledge entries
- **rules** — matching rules
- **path-conventions** — matching path conventions
- **templates** — matching templates
- **scaffold-patterns** — matching scaffold patterns
- **playbooks** — matching playbooks
- **helpers** — matching helper plan generators
- **validation-commands** — declared verification commands on related rules
- **contract-templates** — matching agent-contract templates
- **constructs** — matching constructs (when defined)

## Grade

Derived from the matched-axis ratio: `full ≥ 0.85`, `partial ≥ 0.55`,
`weak ≥ 0.25`, `missing < 0.25`.

## Schema

`sharkcraft.scaffold-coverage/v1`.

## MCP

`get_scaffold_coverage_report` — read-only.
