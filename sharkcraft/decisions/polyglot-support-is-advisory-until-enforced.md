---
id: polyglot-support-is-advisory-until-enforced
title: Polyglot support is advisory until explicitly enforced
status: accepted
date: 2026-05-15
---

# Polyglot support is advisory until explicitly enforced

## Context

R27 added polyglot detection (Java, Python, Go, …) and a polyglot
boundary engine. The temptation: surface polyglot violations everywhere.

## Decision

Polyglot detection and impact analysis are *advisory* by default. The
polyglot boundary engine only runs in `enforce` mode when the user
explicitly opts in (`shrk boundaries enforce --polyglot`). Default
flows treat polyglot signal as guidance.

This keeps the engine usable on partially-typed multilanguage repos
without producing noise.

## Consequences

- Java/Python/Go consumers can opt in to enforcement once their config
  is tuned.
- The default user experience does not regress for TS-only repos.
- Future polyglot rule sets must respect this advisory-default rule.

## Related policies

- (none directly.)

## Related commands

- shrk boundaries enforce --polyglot
- shrk languages run
- shrk impact --polyglot-only
