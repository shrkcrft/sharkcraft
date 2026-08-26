# Which template for which task

A doc citing template ids, one of which has drifted from the registry. The
phantom is the ONLY finding: the real ids resolve, the prose mention is not a
reference, and the marked example is an acknowledged non-reference.

| Task | Command |
|---|---|
| A handler | `shrk gen gmc.handler` |
| An entry  | `shrk gen gmc.registry-entry` |
| A ghost   | `shrk gen gmc.phantom-renderer` |

The full flow is the `gmc.add-handler` playbook — a PLAYBOOK id, resolved
against a different registry than the template ids above.

A sentence mentioning gmc.in-prose outside backticks is prose, not a reference.
An acknowledged example: `gmc.example-only`. <!-- ref-allow -->
