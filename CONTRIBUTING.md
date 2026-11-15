# Contributing

## Requirements

- Nix with flakes
- GNU coreutils: the setup command uses `cp -L --no-preserve=mode`
- Node.js 24
- pnpm (the version pinned in `package.json`'s `packageManager`)

The dev shell (`nix develop`, or direnv) puts every tool on PATH, `bin/dprint` included; on a bare
shell that has nix the wrapper scripts resolve what they need themselves.

## Dependencies on core

`@systemfsoftware` packages come from npm like any other dependency: package manifests and catalogs name caret ranges and `pnpm-lock.yaml` holds the exact versions. Take newer ones with `pnpm update '@systemfsoftware/*'`. `flake.nix` pins core at a full commit (input `core`) only for its dprint build and its nixpkgs.

## Setup and workflow

```bash
nix develop --accept-flake-config --command pnpm install
pnpm format
pnpm check:local
```

`pnpm check:local` runs what the required CI checks run: dprint, build, lint, typecheck, type tests, API reports,
attw and the tests. Run it before pushing.

## Pull requests

Open pull requests against `main` in systemfsoftware/effect-daemon. Commit messages follow Conventional Commits
(`commitlint.config.ts`), and a change to a publishable package carries a changeset intent.
