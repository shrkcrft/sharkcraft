# Polyglot dependency scanner (R25)

`shrk languages deps [--language all|java|csharp|python|go|rust]` scans
the repo and returns a deterministic dependency graph per language. Pure
regex — no AST library, no compiler integration.

## How internal vs external is decided

| Language | Internal classification |
| --- | --- |
| Java | `package com.foo;` declarations indexed first; any matching `import com.foo.*` is treated as internal. |
| C# | `namespace X;` (file-scoped) or block `namespace X { … }`. |
| Python | Heuristic: top-level directories + any `src/<pkg>` dir become local modules. Relative imports (`from .x`) are always internal. |
| Go | `module example.com/foo` from `go.mod` is the internal prefix. |
| Rust | Crate name from `Cargo.toml` plus `crate::`, `super::`, `self::` heads. |

External heads are surfaced under `externalDeps[]`, deduplicated and
sorted. Unresolved relative imports surface under `unresolvedDeps[]`.

## Output schema

`sharkcraft.polyglot-dependency-graph/v1`. Per language entry:

```json
{
  "language": "java",
  "filesScanned": 7,
  "imports": [{ "from": "src/main/java/com/foo/A.java", "to": "java.util.List", "external": true }, …],
  "internalEdges": [...],
  "externalDeps": [...],
  "unresolvedDeps": [],
  "confidence": "medium",
  "limitations": ["Java imports parsed by regex; star imports collapsed."]
}
```

## CLI

```bash
shrk languages deps --language java --format json --output /tmp/deps.json
```

## MCP

`get_polyglot_dependency_graph` — read-only. Accepts `language: all | java | csharp | python | go | rust`.

## Limitations

- Regex only — conditional / dynamic imports may be missed.
- Grouped Rust `use foo::{a, b};` only records `foo` head.
- C# alias usings (`using X = Y;`) are not categorised.
- Python `import` lines on the same physical line (rare) may merge.
