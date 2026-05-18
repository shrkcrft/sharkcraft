# Knowledge loading

This document describes how SharkCraft turns the files under `sharkcraft/`
into structured entries and what the trust model is.

## What gets loaded

The config (`sharkcraft.config.ts`) declares which files to load. Defaults:

| Field | Default | Loader |
|---|---|---|
| `knowledgeFiles` | `['knowledge.ts', 'knowledge/index.ts']` | TypeScript |
| `ruleFiles` | `['rules.ts', 'knowledge/rules.ts']` | TypeScript |
| `pathFiles` | `['paths.ts', 'knowledge/paths.ts']` | TypeScript |
| `templateFiles` | `['templates.ts', 'knowledge/templates.ts']` | TypeScript (separate registry) |
| `docsFiles` | `['docs/overview.md', 'docs/architecture.md', 'docs/quick-start.md']` | Markdown |

All paths are relative to `sharkcraft/`. Missing files are silently skipped.

## TypeScript loader

`TypeScriptKnowledgeLoader` does a single dynamic `import()` of each file and
then **harvests** anything that looks like a knowledge entry:

- Any named export with a `string id`, `string title`, and `string content` is
  picked up.
- Any exported **array** of such objects is unrolled.
- Any exported `{ entries: [...] }` shape is unrolled.

This means a file can do:

```ts
export const a = defineKnowledgeEntry({...});
export const b = defineKnowledgeEntry({...});
export default [a, b];           // also fine — both forms are deduped by id
```

Duplicate ids: first-seen wins; subsequent occurrences are surfaced as
`duplicate-id` warnings via `validateKnowledgeEntries`. They show up in
`shrk doctor` as warnings.

## Markdown loader

`MarkdownKnowledgeLoader` reads each `.md` file and produces **one** entry:

- YAML-lite frontmatter (between `---` markers) overrides the entry id /
  title / type / priority / scope / tags / appliesWhen / summary.
- Without frontmatter, the id defaults to `doc.<filename-kebab>` and title is
  taken from the first `#` heading.
- The body becomes the entry `content`.

Markdown is passive — it never executes code. Use it for narrative depth and
ADRs; use TypeScript files for the structured entries the agent actually
queries.

## Validation pass

After loading, `validateKnowledgeEntries` runs over the merged list:

- `missing-id` → error.
- `invalid-id-format` → error. Ids must match `/^[a-z0-9]+([.-][a-z0-9]+)*$/`.
- `missing-title`, `missing-content`, `missing-type` → error.
- `invalid-type` → warning. Unknown types are allowed but flagged; set
  `type: 'custom'` to silence.
- `invalid-priority` → error. Must be `critical|high|medium|low`.
- `duplicate-id` → warning. First occurrence wins.

Issues surface in `shrk doctor` and in the inspector's `validationIssues`
array. The CLI does not refuse to run on warnings, only on errors that empty
out the registry.

## Trust model

`sharkcraft/*.ts` files run via the standard JS module loader at the moment
the CLI/MCP server starts up. They are **trusted local project config** in
the same sense as:

- `vite.config.ts`
- `eslint.config.js`
- `playwright.config.ts`
- `tsconfig.json` (via its `extends`)

That means:

- ✅ Files written by the repo's maintainers, reviewed in PRs, the same way
  you treat any other config.
- ❌ Files from untrusted contributors merged without review. If you run
  `shrk` against such a tree, you're effectively trusting that author's
  TypeScript to execute — same risk as running `bun install` and any
  arbitrary `postinstall`.

SharkCraft itself:

- Never fetches knowledge over the network.
- Never reads beyond the configured file list.
- Never installs anything implicitly.

If a `sharkcraft/*.ts` file imports an unfamiliar third-party package, the
risk is on that import. Keep knowledge files dependency-light — most should
import only from `@shrkcrft/*`.

## What about template execution?

Templates are typed functions that return file contents (`content(values) =>
string` or `files(values) => ITemplateFile[]`). They run at planning time but
they cannot:

- Execute shell commands.
- Read files outside the template's own logic.
- Write files (the generator does that, only inside the project root, only
  when `--write` is passed against a clean plan).

A malicious template could still emit garbage content; the same way a
malicious schematic could in any code-gen tool. Review templates the same way
you'd review a codemod.
