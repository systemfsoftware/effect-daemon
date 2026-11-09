# Contributing

## Requirements

- Nix with flakes
- GNU coreutils: the setup command uses `cp -L --no-preserve=mode`
- Node.js 24
- pnpm (the version pinned in `package.json`'s `packageManager`)

## Dependencies on core

Core packages are not installed from a registry. `flake.nix` pins core at a full commit (input `core`), and
`nix build .#sfs-deps` links the core tarballs this lockfile names. `pnpm-workspace.yaml` maps every core package
(and its transitive core closure) to `file:.sfs-deps/<name>-<version>.tgz` through `overrides`.

To take newer core packages:

1. Bump the `core` input.
2. Update the override versions.
3. Rebuild `.sfs-deps`.
4. Run `pnpm install`.

Other external dependencies come from the configured npm registry.

## Setup and workflow

```bash
mkdir -p .sfs-deps && cp -L --no-preserve=mode "$(nix build --no-link --print-out-paths .#sfs-deps)"/*.tgz .sfs-deps/
pnpm install
pnpm format
pnpm check:local
```

`pnpm check:local` runs what the required CI checks run: dprint, build, lint, typecheck, type tests, API reports,
attw and the tests. Run it before pushing.

## Pull requests

Open pull requests against `main` in systemfsoftware/effect-daemon. Commit messages follow Conventional Commits
(`commitlint.config.ts`), and a change to a published package carries a changeset intent.
