# Contributing

## Requirements

- Nix with flakes
- GNU coreutils: the setup command uses `cp -L --no-preserve=mode`
- Node.js 24
- pnpm (the version pinned in `package.json`'s `packageManager`)

The dev shell (`nix develop`, or direnv) puts every tool on PATH, `bin/dprint` included; on a bare
shell that has nix the wrapper scripts resolve what they need themselves.

## Dependencies on core

nix.systemfsoftware.com is the package registry for `@systemfsoftware` packages: producers push package tarballs there from `main`, consumers substitute them through flake inputs, and nothing goes to npm. Core's tarballs reach this repository through the `core` flake input, and `pnpm-workspace.yaml` maps them to `file:.deps/*.tgz` overrides.

To take newer core packages:

1. Bump the `core` input.
2. Run `nix flake lock`.
3. Regenerate the overrides with `nix eval --raw .#packages.x86_64-linux.producer-tarballs.overrides` and replace the block in `pnpm-workspace.yaml`.
4. Run `pnpm install`.

Third-party dependencies come from the configured npm registry; `@systemfsoftware` packages come from nix.systemfsoftware.com, never from npm.

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
