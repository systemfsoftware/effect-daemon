@repos/constitution/WORKING.md

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

## Dependencies on core

`@systemfsoftware` packages come from npm like any other dependency: package manifests and catalogs name caret ranges and `pnpm-lock.yaml` holds the exact versions. Take newer ones with `pnpm update '@systemfsoftware/*'`. `flake.nix` pins core at a full commit (input `core`) only for its dprint build and its nixpkgs.

Local setup:

```bash
nix develop --accept-flake-config --command pnpm install
```

## Gate

- `pnpm check:local` before delivery: dprint, build, lint, typecheck, type tests, API reports, attw, tests at the
  local conformance profile.
- CI (`.github/workflows/ci.yml`) calls core's reusable checks at a pinned core commit. A pull request runs
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

| Doc                                                                         | Trigger                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `repos/constitution/CODING_STANDARDS.md` and `repos/constitution/REVIEW.md` | you plan, write, review or propose a test                                    |
| `repos/constitution/GRADERS.md`                                             | you build or change a check (a lint rule, CI job, hook, threshold or rubric) |
