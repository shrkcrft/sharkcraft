# Repository statistics

`shrk stats` produces a deterministic, read-only snapshot of the
repository: per-language file counts, line totals broken down into
code/comment/blank, byte totals, averages, and the largest files.

The data lives in `packages/inspector/src/repository-stats.ts`; the same
shape is surfaced via the `get_repository_stats` MCP tool and the
`/api/stats` route of the local dashboard.

---

## CLI

```bash
shrk stats                          # text table (totals + per-language + largest files)
shrk stats --json                   # JSON envelope (schema: sharkcraft.repository-stats/v1)
shrk stats --top 25                 # surface the 25 largest files (default 10)
shrk stats --language typescript    # filter to a single language
```

The `--cwd <dir>` global flag is honoured. The command is a pure read —
it never writes.

---

## MCP

`get_repository_stats` (read-only) accepts:

```jsonc
{
  "maxTopFiles": 10,        // optional, default 10
  "language": "typescript"  // optional
}
```

and returns an `IRepositoryStats` payload with schema id
`sharkcraft.repository-stats/v1`.

---

## Dashboard

The dashboard's **Statistics** page (under the "Codebase" sidebar group)
consumes `/api/stats` and renders:

- Four top-line metrics: total files, total size, lines of code, dominant
  language.
- A per-language table with files, code/comment/blank lines, bytes, and
  average lines per file.
- A largest-files table (top 25 by default).
- The list of directories excluded from the walk.

The Overview page's **Repo size** tile is a one-click jump into this
page.

---

## Schema

```ts
schema:        'sharkcraft.repository-stats/v1'
projectRoot:   string         // absolute path of the inspected root
generatedAt:   string         // ISO 8601
truncated:     boolean        // true if the file cap was reached
totals: {
  files, bytes, totalLines, codeLines, commentLines, blankLines
}
byLanguage: [
  {
    language:           'typescript' | 'java' | 'python' | …
    extensions:         readonly string[]
    files, bytes, totalLines, codeLines, commentLines, blankLines
    averageFileBytes, averageFileLines
    largestFile:        { path, bytes, lines } | null
  }
]
topFiles: [ { path, language, bytes, lines } ]   // sorted desc by bytes
ignoredDirectories: readonly string[]
```

`byLanguage` is sorted by `files` desc, breaking ties by `bytes` desc.

---

## Excluded directories

Stats deliberately ignore generated / vendored / IDE / tooling directories
so the numbers reflect *your* code:

```
node_modules · .git · .nx · .sharkcraft · .claude · .idea · .vscode
.next · .nuxt · .svelte-kit · .turbo · dist · build · out · target
bin · obj · __pycache__ · .venv · venv · vendor · coverage
.gradle · .mvn
```

Files inside any directory whose name matches the list are skipped, no
matter where they live in the tree.

---

## Comment detection

Comment counting is **prefix-based**, not parser-based:

- C-family (`.ts`, `.tsx`, `.js`, `.java`, `.cs`, `.go`, `.rs`, `.cpp`,
  `.c`, `.kt`, `.scala`, `.swift`, `.php`, `.dart`, `.css`/`.scss`,
  `.groovy`): `//`, `/* … */`, and a leading `*` continuation line.
- Hash (`.py`, `.rb`, `.sh`, `.yaml`, `.toml`, `.ini`, `.ex`, …): `#`.
- HTML/XML (`.html`, `.xml`, `.vue`, `.svelte`): `<!-- … -->`.
- SQL: `--` line + `/* … */` block.
- Lua: `--` line.
- Lisp/Clojure: `;`.

This is not a real parser. Inline trailing comments (`x = 1; // note`)
count as **code**, not comment — only lines whose first non-whitespace
character starts a comment are counted as comments. Block comments
opened on one line and closed on another are accounted for correctly.

Files larger than 4 MB skip line counting (still counted toward `files`
and `bytes`) so the walk stays fast on monorepos.

---

## Determinism

Two consecutive runs on the same project produce identical output modulo
`generatedAt`. There is no random ordering, no caching, and the
file-system walk uses a fixed exclusion list.
