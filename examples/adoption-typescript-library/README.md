# adoption-typescript-library

R47 adoption fixture. A generic TypeScript library — `main` + `types`,
strict tsconfig, no framework dependencies. Used to verify that
`shrk init --zero-config` picks `typescript-library` for a basic TS
package.

Re-run the fixture sweep:

```bash
shrk --cwd examples/adoption-typescript-library inspect
shrk --cwd examples/adoption-typescript-library init --zero-config
shrk --cwd examples/adoption-typescript-library ci scaffold github-actions --quickstart
```
