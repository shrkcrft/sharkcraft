# Graph export

`shrk graph` produces the full SharkCraft knowledge graph (nodes + edges)
in the format you want:

```bash
shrk graph --format text       # default
shrk graph --format json
shrk graph --format dot
shrk graph --format mermaid
```

## Single node

```bash
shrk graph my-rule-id --format mermaid
shrk graph my-template-id --format dot --output /tmp/template.dot
```

The single-node view renders the node plus its outgoing and incoming
edges. Use it to embed a focused diagram in docs.

## Export subcommand

```bash
shrk graph export --format dot --output graph.dot
shrk graph export --format mermaid --output graph.mmd
shrk graph export --format json --output graph.json
```

## Rendering

```bash
dot -Tsvg graph.dot > graph.svg     # GraphViz
# or paste graph.mmd into any Mermaid-aware renderer
```

## Type filter

```bash
shrk graph --type rule --format mermaid     # only rule nodes
shrk graph --type template --format dot
```

The filtered export keeps every edge that touches a node of the given
kind. Useful for "show me everything connected to my templates".
