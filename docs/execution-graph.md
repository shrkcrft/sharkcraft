# Task execution graph

A task execution graph is a typed node/edge structure that ties
intent → risk → memory → contract → constructs → policies → boundaries →
playbooks → templates → plans → review gates → human approval →
validations → report artefacts → done.

> **CLI verb retired — MCP-only surface.** The former `shrk agent graph`
> CLI command (and its `query` subcommand) were removed. The
> deterministic builder survives as the read-only MCP tools
> `create_execution_graph` and `query_execution_graph`. No CLI write
> path, no execution — the graph is data only.

## Surface

`create_execution_graph` (read-only) takes:

- `task` (required) — the task description.
- `role` — `developer | reviewer | architect | release-manager | security | ai-agent`.
- `mode` — `conservative | balanced | aggressive`.
- `files` — explicit file list.
- `since` — a git ref to scope the change-set.
- `staged` — scope to the staged change-set.

It returns the graph body (`sharkcraft.execution-graph/v1`).

## Output schema

`sharkcraft.execution-graph/v1` — see `packages/inspector/src/execution-graph.ts`.

### Node kinds

`task / intent / risk / memory / contract / construct / policy / boundary
/ playbook / template / plan / review-gate / human-approval / validation
/ report-artifact / done`.

### Edge kinds

`requires / informs / blocks / validates / produces / reviews / forbids /
recommends`.

## Query

`query_execution_graph` (read-only) queries a saved or rebuilt graph with
a `<filter>:<value>` expression:

| Filter | Behaviour |
| --- | --- |
| `blocks:<nodeId>` | Walks edges of kind `requires / blocks / validates` upstream of the target node. |
| `kind:<kind>` | Returns all nodes of that kind (e.g. `kind:human-approval`). |
| `edge:<kind>` | Returns all edges of that kind (e.g. `edge:blocks`). |
| `text:<substring>` | Returns nodes whose id / label / detail contains the substring. |

## Composition

The graph is a deterministic combination of the agent contract surface
(R23.1), repo memory (when an index exists), task risk (R20), and intent
(R18). It is not a separate model.

## Safety

- Read-only. No execution, no writes.
- Both `create_execution_graph` and `query_execution_graph` are read-only
  MCP tools.
