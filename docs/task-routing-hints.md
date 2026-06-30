# Task routing hints (R33)

Packs and local config bias SharkCraft's recommender toward their
playbooks / templates / helpers / profiles / conventions / knowledge
through `taskRoutingHintFiles[]`. The engine ships no hints.

## Shape

```ts
interface ITaskRoutingHint {
  id: string;
  title: string;
  description?: string;
  match: { keywords?; phrases?; regexes?; languages?; fileGlobs?;
           constructKinds? };
  recommends: { commands?; templates?; playbooks?; helpers?;
                profiles?; conventions?; knowledge?; policies? };
  confidenceBoost?: number;
  explanation?: string;
  safetyNotes?: readonly string[];
  tags?: readonly string[];
}
```

## Commands

> **CLI verbs retired — MCP-only surface.** The standalone `routing` CLI
> verbs (`routing hints list`, `routing hints doctor`, `routing explain`)
> were removed. The deterministic engine survives as the read-only MCP
> tools `list_task_routing_hints` and `explain_task_routing` (see below).
> No CLI write path, no execution — the hints are read-only data.

## MCP

- `list_task_routing_hints`, `explain_task_routing` — read-only.

## Integrations

- `shrk search "<query>"` — best actions section pulls top-scoring
  routing hints.
- `prepare_agent_task` MCP tool — includes routing hints with reasons.

## Schemas

- Hint shape: described by `ITaskRoutingHint` (no schema marker).
- Registry: `sharkcraft.task-routing-hint-registry/v1`.
