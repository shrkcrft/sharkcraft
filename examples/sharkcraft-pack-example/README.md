# @example/sharkcraft-pack-example

A demonstration of the SharkCraft **pack manifest** shape. A pack is an npm
package that ships SharkCraft assets — knowledge entries, rules, paths,
templates, pipelines — for consumers to opt into.

In a consumer repo, packs land in `node_modules/<pack-name>/`. The SharkCraft
discovery scanner (planned for v0.2) will look for `package.json` entries
with a `sharkcraft.manifest` field, import the manifest, validate it, and
register the listed contributions.

This example only ships the manifest. Real packs will also ship the asset
files (`assets/knowledge.ts` etc.).

## Manifest shape

See `src/sharkcraft.plugin.ts`. The full type lives in `@shrkcrft/plugin-api`:

```ts
import { definePackManifest, validatePackManifest } from '@shrkcrft/plugin-api';

export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: {
    name: '@yourscope/your-pack',
    version: '0.1.0',
    description: '...',
  },
  contributions: {
    knowledgeFiles: ['./assets/knowledge.ts'],
    templateFiles: ['./assets/templates.ts'],
    pipelineFiles: ['./assets/pipelines.ts'],
  },
});
```

The validator is dependency-light; it does not require zod. See
`docs/packs.md` for the discovery roadmap.
