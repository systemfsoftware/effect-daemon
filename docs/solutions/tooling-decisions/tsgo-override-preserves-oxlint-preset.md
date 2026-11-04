---
title: Preserve the tsgo override while the lint preset lags
date: 2026-11-04
category: tooling-decisions
module: Workspace lint tooling
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Upgrading Effect or @effect/tsgo while the organization lint preset depends on an older tsgo release
retire_when: "SYS-990 delivers an organization lint preset whose tsgo dependency is compatible with the workspace version; check the released preset metadata."
tags: [effect, tsgo, oxlint, pnpm, dependency-resolution]
---

# Preserve the tsgo override while the lint preset lags

## Context

The organization oxlint preset imports rule sets from its own `@effect/tsgo` dependency. At the Effect 4.1.2 upgrade, the pinned preset declared `@effect/tsgo: ^0.51.1`, while the workspace used 0.64.1. Caret ranges below 1.0 do not span those minor versions. The conductor reported that removing the existing override causes lint rules to disappear; a successful lint exit alone does not establish equivalent coverage.

## Guidance

Keep the existing workspace-wide `@effect/tsgo` override aligned with the workspace catalog while the preset's dependency range excludes that version. This is a targeted exception for the lint toolchain, not a reason to add overrides for Effect runtime packages or unrelated transitive dependencies.

When the preset is updated upstream, inspect its released dependency metadata and the resolved lockfile before removing the override. Compare the effective lint rule count and lint results before and after removal; do not infer preservation from a green exit alone.

## Why This Matters

The preset loads `correctness` and `recommended` from `@effect/tsgo/oxlint-presets` and incorporates their rules into its library configuration. A separately resolved tsgo version can therefore change which rules the preset supplies. The override makes the preset and workspace resolve the same tsgo version rather than leaving the preset on the older range.

## When to Apply

- An Effect or tsgo upgrade changes the tsgo version but an inherited preset still declares an incompatible pre-1.0 range.
- A dependency cleanup proposes removing a tsgo override or a lint run passes with fewer rules.

## Examples

For this upgrade, the catalog and existing override resolve tsgo to 0.64.1. With the override in place, lint reported 345 rules per package before the upgrade and 350 after it, with zero warnings and errors. These observations do not measure the rule count without the override.

## Related

- SYS-990 tracks the upstream preset dependency fix.
