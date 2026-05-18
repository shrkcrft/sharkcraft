# Task execution graph

`shrk agent graph "<task>"` builds a typed node/edge graph that ties
intent → risk → memory → contract → constructs → policies → boundaries →
playbooks → templates → plans → review gates → human approval →
validations → report artefacts → done.

## Usage

```
shrk agent graph "<task>" \
  [--role developer|reviewer|architect|release-manager|security|ai-agent] \
  [--mode conservative|balanced|aggressive] \
  [--files a,b,c] [--since <ref>] [--staged] \
  [--format text|markdown|html|json|mermaid] [--output <file>]
```

## Output schema

`sharkcraft.execution-graph/v1` — see `packages/inspector/src/execution-graph.ts`.

### Node kinds

`task / intent / risk / memory / contract / construct / policy / boundary
/ playbook / template / plan / review-gate / human-approval / validation
/ report-artifact / done`.

### Edge kinds

`requires / informs / blocks / validates / produces / reviews / forbids /
recommends`.

## Renderers

- `text` — quick CLI scan.
- `markdown` — for PR comments and reports.
- `json` — programmatic.
- `mermaid` — copy/paste into any Markdown viewer with Mermaid support.
- `dot` (R24) — Graphviz `digraph`. Pipe to `dot -Tsvg` to render. R25 adds `--cluster` to group nodes by kind in subgraph clusters (intent/risk/memory, contract/gates, constructs/policies/boundaries, plans/simulation, validations, done) with stable colors + shapes.
- `html` — wraps the Mermaid source inside a static HTML page (no JS,
  no remote scripts).

The `--graph-format` flag is an alias for `--format` honouring `mermaid`
and `dot`. `--graph-output <file>` is an alias for `--output`.

## Query (R24)

```
shrk agent graph query <graph.json> "<filter>:<value>"
```

| Filter | Behaviour |
| --- | --- |
| `blocks:<nodeId>` | Walks edges of kind `requires / blocks / validates` upstream of the target node. |
| `kind:<kind>` | Returns all nodes of that kind (e.g. `kind:human-approval`). |
| `edge:<kind>` | Returns all edges of that kind (e.g. `edge:blocks`). |
| `text:<substring>` | Returns nodes whose id / label / detail contains the substring. |

MCP: `query_execution_graph` (read-only).

## Composition

The graph is a deterministic combination of the agent contract surface
(R23.1), repo memory (when an index exists), task risk (R20), and intent
(R18). It is not a separate model.

## Safety

- Read-only. No execution, no writes.
- Mermaid labels are escaped — pipes and quotes are normalised so the
  source renders cleanly.
- MCP: `create_execution_graph` is read-only.
