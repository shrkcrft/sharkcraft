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

```bash
shrk routing hints list [--source pack|local]
shrk routing hints doctor
shrk routing explain "<task>"
```

## MCP

- `list_task_routing_hints`, `explain_task_routing` — read-only.

## Integrations

- `shrk search "<query>"` — best actions section pulls top-scoring
  routing hints.
- `prepare_agent_task` MCP tool — includes routing hints with reasons.

## Schemas

- Hint shape: described by `ITaskRoutingHint` (no schema marker).
- Registry: `sharkcraft.task-routing-hint-registry/v1`.
