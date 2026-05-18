# SharkCraft 0.1.0-alpha.2 — launch copy

Drop-in copy for the launch announcements. Every claim here is something
we can demonstrate with the bundled commands. Keep this file the source of
truth for public-facing wording.

---

## 1. Short GitHub description (≤120 chars)

> Structured project intelligence for AI coding agents.

## 2. Longer description (≤280 chars)

> SharkCraft turns repository-specific rules, path conventions, templates,
> workflows, and knowledge packs into precise CLI commands and MCP tools
> for AI coding agents. MCP is read-only. The CLI is the only write path.

## 3. One-liner (homepage hero)

> Make your repository AI-readable without dumping all your docs into the
> prompt.

## 4. Tweet / X draft

```
Shipped SharkCraft 0.1.0-alpha.2 — structured project intelligence for
AI coding agents.

• MCP server with ~34 tools (read-only)
• CLI is the only write path
• Plan-first generation, signed plans
• Knowledge packs with HMAC signatures
• Pipelines that render runnable bash scripts
• Bun-native, @modelcontextprotocol/sdk

Not a replacement for Claude Code / Cursor — a sharper context layer
under them. Alpha; pin exact versions.

bunx @shrkcrft/cli@alpha init && shrk doctor
```

## 5. LinkedIn draft

```
After several months of dogfooding, I'm shipping SharkCraft 0.1.0-alpha.2.

What it is: a Bun-native toolkit that gives AI coding agents structured,
typed access to a repository's rules, paths, templates, and workflows —
served through a `shrk` CLI for humans and an MCP server for agents.

What it isn't: a coding agent. It complements Claude Code, Cursor, Aider,
and similar tools by replacing the "stuff the whole README into the
context window" pattern with deterministic, token-budgeted retrieval.

Highlights:
  • The MCP server is read-only by design — the CLI is the only path that
    writes files, and every generation is plan-first with optional HMAC
    signatures.
  • Knowledge packs: third-party npm packages that ship rules + paths +
    templates + pipelines. Discoverable, signable, verifiable.
  • Declarative pipelines render copy-pasteable bash for an agent or a
    human to walk.
  • Imports parse existing AGENTS.md / CLAUDE.md / .cursor/rules into
    structured drafts.
  • A real-world adopter pack ships 60+ entries for a complex monorepo
    and verifies under --require-signatures.

This is alpha. Pin exact versions; expect breaking changes before 0.1.0.

GitHub: <link>
Demo: docs/demo.md
```

## 6. Hacker News / Reddit-style draft

```
Show HN: SharkCraft — structured project intelligence for AI coding agents

I've been frustrated for a while with how coding agents handle
repository-specific conventions. Today the standard answer is "write a big
CLAUDE.md / AGENTS.md and hope the agent reads it." The agent then dumps
the whole thing into the context window every turn.

SharkCraft replaces that with:

  - Typed knowledge entries (id, type, priority, scope, appliesWhen, tags).
  - A `shrk` CLI that retrieves only the relevant slice for a given task,
    budgeted by token count.
  - An MCP server (built on the official @modelcontextprotocol/sdk) that
    exposes ~34 read-only tools and resources to any MCP client.
  - A pack system so teams can publish their conventions as npm packages.
  - HMAC signing for both generation plans and pack manifests.
  - Declarative pipelines that render runnable shell scripts.

Important: the MCP server never writes files. The CLI is the only write
path. Generation is plan-first; dry-run by default; paths refused outside
the project root. Knowledge files are treated as trusted local config —
same model as vite.config.ts / eslint.config.js.

It's Bun-native and 0.1.0-alpha.2, so pin versions if you try it. I'd love
feedback on the trust model and pack-signing UX.

GitHub: <link>
```

## 7. Demo script

The full copy-paste demo lives in
[`docs/demo.md`](demo.md). Three flows:

1. **Generic repo:** `init → doctor → context → pipelines list → gen
   --dry-run → apply`.
2. **MCP:** `mcp serve` over stdio + a Claude Code config snippet; expected
   tools/resources listing.
3. **Complex repo:** `packs verify --required → doctor →
   context for plugin dev → pipelines script plugin-dev → plan-first
   generation`.

## 8. FAQ

**Is this an AI coding agent?**
No. SharkCraft holds a repository's knowledge and serves it to whatever
coding agent you use (Claude Code, Cursor, Aider, etc.). It does not
generate code on its own — generation always goes through the
`shrk gen → shrk apply` CLI flow with a human in the loop.

**Does MCP write files?**
No. The MCP server is read-only by design. `create_generation_plan` and
`render_template_preview` return data; they never modify disk.
`shrk apply` on the CLI is the only path that writes.

**Is it safe?**
The safety model is documented in
[`docs/security.md`](security.md). Highlights:
generation is dry-run by default; target paths refused outside the project
root; plans can be HMAC-signed and verified on apply; pack manifests can
also be HMAC-signed; MCP inputs are zod-validated; knowledge files are
trusted local TypeScript config (same trust model as
`vite.config.ts`/`eslint.config.js`).

**Why not just CLAUDE.md?**
CLAUDE.md / AGENTS.md / `.cursor/rules` work — for small projects with
short context windows and homogeneous tasks. They scale poorly: as the
codebase grows, you dump more prose into the context, the agent skims
more and follows less, and you can't selectively retrieve "only the rules
that apply to generating a service in this layer." SharkCraft typed
entries give you that selective retrieval — and you can `shrk export
claude-md --write` for tools that only read flat markdown.

**Why packs?**
A pack is just an npm package that ships SharkCraft contributions. They
let an organization publish its conventions once and have every consuming
repo inherit them. Local entries always win on duplicate ids, so a team
can override the pack where they need to.

**What does "alpha" mean here?**
APIs may shift between alpha tags. Pin exact versions
(`@shrkcrft/cli@0.1.0-alpha.2`, not `^0.1.0`). Expect a few breaking
changes before `0.1.0`. The safety model and the public CLI surface are
stable goals; everything else is fair game.

**Does it work without AI?**
Yes. `shrk` is useful as a deterministic context retriever and a
plan-first generator on its own. AI isn't a hard dependency — the MCP
server is optional.

**Does it replace Cursor / Claude Code?**
No. It complements them. Use Cursor or Claude Code for the actual coding;
use SharkCraft to give those tools precise, repo-specific context and a
plan-first write path.

**Can I use it with any repo?**
Yes. `shrk init` scaffolds a `sharkcraft/` folder you customize. The CLI
works with any language; the dogfood example is Bun + TypeScript, but
nothing in SharkCraft cares about that.

---

## House rules for launch copy

- Don't overhype. This is alpha.
- Don't claim "fully automated" anything. The human is always in the
  apply loop.
- Don't imply MCP writes files. It doesn't.
- Don't compare via insults to other tools. SharkCraft sits under them.
- If unsure whether a claim is supported, run the demo in `docs/demo.md`
  and reword to match observed behavior.
