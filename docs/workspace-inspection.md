# Workspace inspection

`inspectWorkspace()` returns an `IWorkspaceSummary`:

```ts
interface IWorkspaceSummary {
  projectRoot: string;
  hasPackageJson: boolean;
  packageName?: string;
  packageVersion?: string;
  packageManager: { manager: 'bun' | 'pnpm' | 'yarn' | 'npm' | 'unknown'; version?: string; evidence: string[] };
  frameworks: { id: string; name: string; version?: string; evidence: string[] }[];
  hasTypeScript: boolean;
  tsConfig: ITsConfig | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  topLevelDirs: string[];
  hasSharkcraftFolder: boolean;
  sharkcraftPath: string | null;
  raw: { packageJson: IPackageJson | null };
}
```

## Frameworks detected

Angular, React, Vue, Svelte, Next.js, Nuxt, NestJS, Express, Fastify, Nx, AWS Lambda, Electron, TypeScript, Bun. Detection is based on dependencies + file markers (`angular.json`, `nx.json`, etc.).

## Package managers detected

Bun, pnpm, Yarn, npm. Uses the `packageManager` field if present, then lockfile heuristics (`bun.lockb`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`).

## CLI

```bash
shrk inspect          # pretty
shrk inspect --json   # structured
shrk doctor           # validate sharkcraft setup
```
