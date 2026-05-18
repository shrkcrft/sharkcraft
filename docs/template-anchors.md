# Template anchors (R35)

Templates can declare anchors they **produce** in their rendered output
(`producedAnchors[]`) and anchors they **require** to exist somewhere in
the target file (`requiredAnchors[]`). Template drift cross-checks both.

## Why

R35 plan-v2 ops like `insert-enum-entry` and `insert-between-anchors`
need stable, predictable insertion sites. Without anchors, an update op
runs the risk of conflicting against an unfamiliar target. With anchors,
producers and consumers form a graph: the doctor surfaces gaps before
broken code ships.

## Metadata

```ts
template.metadata = {
  producedAnchors?: ITemplateAnchorDeclaration[];
  requiredAnchors?: ITemplateAnchorDeclaration[];
};

interface ITemplateAnchorDeclaration {
  anchor: string;            // literal anchor text
  in: string;                // file glob or literal path
  purpose?: string;
  usedBy?: ('insert-after'|'insert-before'|'insert-between-anchors'
            |'insert-before-closing-brace'|'insert-enum-entry'
            |'insert-object-entry')[];
}
```

## Drift checks (template-drift report)

- `missing-produced-anchor` — the template declares it produces anchor X
  but the rendered file does not contain X.
- `produced-anchor-target-missing` — anchor X declared in file Y but the
  template did not render anything matching Y.
- `missing-required-anchor` — anchor X is required by template T but no
  other template declares it as a producer.

## Example (a plugin pack)

```ts
// app.plugin-contract.metadata
producedAnchors: [
  { anchor: '// region:events:enum', in: 'packages/app/plugins/plugin-api/src/lib/plugins/*/events.ts', usedBy: ['insert-enum-entry'] },
  { anchor: '// region:events:body', in: '...', usedBy: ['insert-between-anchors'] },
  { anchor: '// region:events:module-augmentation', in: '...', usedBy: ['insert-between-anchors'] },
]

// app.event.metadata
requiredAnchors: [ <same three> ]
```

## Engine guarantees

- Anchor matching for `insert-between-anchors` is **line-bounded**:
  `// region:body` does not match inside `// region:body:end`.
- Idempotency: every anchor-based op accepts `ifMissing` and skips when
  the snippet (or marker) is already present.
- Conflicts are surfaced explicitly (`Conflict` change kind) rather than
  silently writing broken code.
