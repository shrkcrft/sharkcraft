# MCP batch read-only tools

Round 8 added several read-only MCP tools so agents can pull richer state
in one round-trip:

| Tool                                    | Description                                      |
|-----------------------------------------|--------------------------------------------------|
| `get_dashboard_summary`                 | Compact dashboard (readiness, coverage, drift)   |
| `list_feature_bundles`                  | All feature workflow bundles                     |
| `get_feature_bundle`                    | One feature workflow bundle by id                |
| `get_impact_analysis`                   | Architecture impact for a task / files           |
| `get_test_impact`                       | Test impact for changed files                    |
| `get_policy_report`                     | Aggregated policy engine output                  |
| `get_quality_baseline_comparison`       | Current quality vs. saved baseline               |
| `get_review_packet_v2`                  | Enriched review packet                           |
| `get_repo_area_map`                     | Repository area map                              |
| `get_import_graph_analysis`             | Cycles, fan-in/out, orphans                      |
| `get_ownership`                         | Loaded ownership rules                           |
| `match_owners`                          | Match files against ownership rules              |

Every tool is read-only. MCP never writes — bundles, baselines, etc. are
created via the CLI, then MCP can read them back.
