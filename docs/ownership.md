# Ownership

SharkCraft can load ownership rules from two places:

1. `sharkcraft/ownership.ts` exporting either `default` or `ownershipRules`
   as an `IOwnershipRule[]`.
2. `CODEOWNERS` or `.github/CODEOWNERS` (basic parse).

Rules can also be supplied via `config.ownershipFiles`.

## Model

```ts
interface IOwnershipRule {
  id: string;
  title: string;
  paths: string[];
  owners: string[];
  reviewers: string[];
  tags: string[];
  notes?: string;
  severity?: 'info' | 'warning' | 'error';
  requiredReview?: boolean;
}
```

## CLI

```bash
shrk owners list
shrk owners match <file>
shrk owners impact --files a,b
shrk owners impact --plan <plan.json>
shrk owners impact --bundle <id>
```

## MCP

- `get_ownership`
- `match_owners`
