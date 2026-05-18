import { SHARKCRAFT_VERSION } from '@shrkcrft/shared';

/**
 * Long-form `--about` rendering. Pulls from
 * `docs/overview.md` + `docs/philosophy.md` content, baked at build
 * time so it works offline.
 *
 * Keep this short — one screen. The authoritative docs live under
 * `docs/`; this is the in-binary summary.
 */
export function renderAbout(): string {
  return `SharkCraft v${SHARKCRAFT_VERSION}

What it is
  A deterministic, local-first toolkit that gives AI coding agents
  durable project context. Ships as a CLI (\`shrk\`) — the only write
  path — plus a read-only MCP server, plus a library of structured
  assets (knowledge, rules, paths, templates, pipelines, presets,
  boundaries).

What it is NOT
  There is no AI inside the engine. Every output is a pure function
  of the workspace + the asset registries. The agent uses the engine;
  the engine never calls a model.

The safety contract
  - All write paths are preview-first. \`--apply\` is opt-in, scoped,
    and idempotent.
  - MCP is read-only. Every MCP tool returns data + a next-command
    hint; the human runs the CLI for any write.
  - Apply requires \`--verify-signature\` for signed plans, refuses
    on divergence unless \`--allow-divergent\`.

Calibration to project size
  Surface tiers (\`shrk surface list\`):
    - core         always on
    - extended     visible in --help, callable
    - experimental hidden until enabled (\`shrk surface enable\`)
  Project shape (\`shrk doctor\`) drives the default surface for a
  fresh repo.

Where to read more
  docs/overview.md        what SharkCraft is and isn't
  docs/philosophy.md      the non-negotiable design rules
  docs/surface-tiers.md   the tier model
  docs/safety-model.md    plan / review / apply contract

Quick start
  shrk doctor             health check
  shrk task "<what>"      full task packet (rules + templates + commands)
  shrk recommend "<what>" what command should I reach for?
  shrk surface list       what is available in this repo
`;
}
