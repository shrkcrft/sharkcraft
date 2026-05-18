# Review packet v2

Enhanced review packet with first-class fields for area map impact, test
impact, ownership impact, policy report, and quality-baseline comparison.

```bash
shrk review packet --since origin/main --v2 --format json
shrk review render-comment review-packet.json --format github
shrk review render-comment review-packet.json --format gitlab
shrk review render-comment review-packet.json --format markdown
```

`render-comment` auto-detects v2 packets by `schema`. Available flags:

- `--max-files N` / `--max-items N` — section caps
- `--output <file>` — write to disk

Rendered sections:

1. Risk score
2. Summary
3. Changed areas
4. Changed files (`<details>` on github/gitlab)
5. Suggested reviewers (from ownership)
6. Boundary / policy concerns
7. Test impact
8. Quality regressions (when a baseline was passed)
9. Suggested commands
10. AI reviewer instructions

## MCP

`get_review_packet_v2` exposes the full payload, read-only.
