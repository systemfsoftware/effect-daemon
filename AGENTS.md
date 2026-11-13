# effect-daemon

Effect daemons: the daemon spec and conformance suite, and the process, socket and cluster media.

Extracted from `systemfsoftware/systemfsoftware` (core); package history came with the move.

## Packages

| Package                                      | Version | Distributed |
| -------------------------------------------- | ------- | ----------- |
| `@systemfsoftware/effect-daemon-spec`        | 6.0.3   | yes         |
| `@systemfsoftware/effect-daemon-conformance` | 1.0.3   | yes         |
| `@systemfsoftware/effect-daemon-process`     | 1.0.3   | yes         |
| `@systemfsoftware/effect-daemon-socket`      | 1.0.3   | yes         |
| `@systemfsoftware/effect-daemon-cluster`     | 1.0.3   | yes         |

`effect-readiness` is a second producer in `flake.nix`, pinned to its repository's `main`, because core no longer ships it.

## Dependencies on core

nix.systemfsoftware.com is the package registry for `@systemfsoftware` packages: producers push package tarballs there from `main`, consumers substitute them through flake inputs, and nothing goes to npm.

Core is a flake input (`core`, pinned at a full commit). `flake.nix` takes its tarballs whole through
`lib.mkProducerTarballs`, and `pnpm-workspace.yaml` maps each one to `file:.deps/<name>.tgz` through `overrides`.
To take newer core packages: bump the `core` input, run `nix flake lock`, regenerate the overrides with
`nix eval --raw .#packages.x86_64-linux.producer-tarballs.overrides`, then run `pnpm install`.

Local setup (the dev shell copies the tarballs into `.deps/`):

```bash
nix develop --accept-flake-config --command pnpm install
```

## Gate

- `pnpm check:local` before delivery: dprint, build, lint, typecheck, type tests, API reports, attw, tests at the
  local conformance profile.
- CI (`.github/workflows/ci.yml`, SYS-1369) calls core's reusable checks at a pinned core commit. A pull request runs
  the static lane and the affected tests (`.github/ci/pr-tests.mjs`: `turbo --affected`, `vitest --changed`) and no
  packed test job. A Mergify queue draft (`mergify/merge-queue/*`) runs the full suite: the static lane and every
  package's whole suite. Main runs the full suite again after each merge, and a package whose content hash already
  passed whole is a cache hit, not left out by name. `nix.yml` builds the flake outputs on main only.
- Never start a local mutation run; mutation runs in CI only.
- Version bumps: every change to a publishable package's packed output advances its version at least a patch.

## Conventions

- Run `pnpm --filter <pkg> <cmd>` from the root; never `cd` into packages, never `npx`.
- Commits: `type(scope): subject` (commitlint).
- Tooling scripts are TypeScript run by the toolchain already in the workspace; no synchronous IO in new scripts.

## Routing

| Doc                                 | Trigger                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSTITUTION.md`                   | architecture changes, rule authoring, or design disputes                                                                                        |
| `repos/constitution/ENFORCEMENT.md` | building or changing an instrument that grades work (lint gates, stream rules, CI checks, thresholds, rubrics, advisors); situational read only |
