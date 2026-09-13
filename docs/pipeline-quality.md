# Pipeline quality

```bash
shrk check pipelines [--strict] [--min-score <0-100>] [--allow-empty] [--json]
```

`check pipelines` validates every registered pipeline: a pipeline with no
steps, or with a duplicate step id, is an error; one with no description is a
warning (`--strict` makes warnings fail). Zero registered pipelines is NOT
VERIFIED (exit 2) unless `--allow-empty` accepts it. The former
`shrk pipelines lint` / `shrk pipelines test` verbs were removed.
