// `shrk` is published purely as a `bin` wrapper around @shrkcrft/cli. This
// file exists so the shared build pipeline (which expects every package to
// emit `dist/index.js`) has something to compile. It re-exports the same
// public surface so `import { runCli } from "shrk"` also works for anyone
// who wants to call the CLI programmatically without depending on the
// scoped name.
export { runCli, buildRegistry } from '@shrkcrft/cli';
