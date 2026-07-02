# Context system

The context builder turns a task into a short, AI-ready, **token-budgeted** package.

## API

```ts
import { buildContext } from '@shrkcrft/context';

const result = buildContext(entries, {
  task: 'generate a TypeScript service',
  framework: 'typescript',
  area: 'backend',
  tags: ['service'],
  maxTokens: 3000,
  includeExamples: true,
  includeRules: true,
  includePaths: true,
  includeTemplates: true,
  includeDocs: false,
  projectOverview: '...',
});
```

The result contains:

- `sections` — each one is a labelled chunk (`Relevant Rules`, `Relevant Path Conventions`, …) with `entryIds`, body, and approximate token count.
- `body` — concatenation of all sections in priority order.
- `totalTokens` / `maxTokens` — bookkeeping.
- `omittedSections` — what was dropped because of the budget.

## Token estimation

Approximate (chars / 4, words × 1.3, whichever is larger). Designed to be conservative so we stay under budget. Replaceable later with a real tokenizer if needed.

## Section priority

```
Project Overview            100
Important Warnings           95
Relevant Rules               90
Architecture Constraints     80
Relevant Path Conventions    70
Relevant Templates           65
Technical Stack              50
Testing Guidelines           45
Security Guidelines          44
Commands                     40
Current Tasks                30
Reference Docs               10
```

Sections are added in priority order until the budget runs out. The last partial section is truncated rather than dropped if it can fit a useful slice.

## CLI text-mode fidelity

In text mode `shrk context` / `shrk task` render the **full body by default**
(parity with `why` / `reuse` / `knowledge get`) and auto-widen `maxTokens` so the
high-priority sections above aren't dropped to fit a terse cap. Pass `--summary`
(alias `--brief`) for the terse, budget-capped view, or `--commands-first` /
`--actions-only` for the commands-only view.
