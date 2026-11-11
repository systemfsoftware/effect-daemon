# effect-daemon

Erlang/OTP-style supervision trees for Effect. A supervisor starts its children in order, restarts the ones that fail, and stops them in reverse order. The children run as operating-system processes, socket connections or `effect/cluster` entities, and a conformance suite checks that each of those media behaves as the spec says.

## Packages

| Package                                      | What it is                                                                                                      | README                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@systemfsoftware/effect-daemon-spec`        | The supervision core: strategies, restart intensity, dynamic children and health latches, as a pure typed fold. | [README](packages/effect-daemon-spec/README.md)        |
| `@systemfsoftware/effect-daemon-process`     | A medium that runs each child as an operating-system process.                                                   | [README](packages/effect-daemon-process/README.md)     |
| `@systemfsoftware/effect-daemon-socket`      | A medium that supervises long-lived socket connections.                                                         | [README](packages/effect-daemon-socket/README.md)      |
| `@systemfsoftware/effect-daemon-cluster`     | A medium over `effect/cluster`: entities and single-owner singletons.                                           | [README](packages/effect-daemon-cluster/README.md)     |
| `@systemfsoftware/effect-daemon-conformance` | Checks a medium of your own against the spec with scripted child lifecycles.                                    | [README](packages/effect-daemon-conformance/README.md) |

## Install

`@systemfsoftware` packages are distributed as Nix tarballs from `nix.systemfsoftware.com`, not from npm, so do not run `npm install` or `pnpm add` for them. Take them through a flake. Third-party peers such as `effect` install from npm as usual.

Add the producer as a flake input in your project's `flake.nix`. Pin it to a full commit SHA or a release tag:

```nix
{
  nixConfig = {
    extra-substituters = "https://nix.systemfsoftware.com";
    extra-trusted-public-keys = "nix-cache-1:wXA8I4DayNW9q6enUyQA/P/nT38pGSTLt374t3gsn7M=";
    fallback = true;
  };

  inputs = {
    nixpkgs.follows = "effect-daemon/nixpkgs";
    effect-daemon.url = "github:systemfsoftware/effect-daemon/<rev>";
    pnpm-release-management.url = "github:systemfsoftware/pnpm-release-management";
  };

  outputs = { self, nixpkgs, effect-daemon, pnpm-release-management }: {
    packages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system:
      let pkgs = nixpkgs.legacyPackages.${system}; in rec {
        producer-tarballs = pnpm-release-management.lib.mkProducerTarballs {
          inherit pkgs;
          producers = { inherit effect-daemon; };
        };
        pnpm-store = pnpm-release-management.lib.mkPnpmConsumerStore {
          inherit pkgs;
          src = self;
          files.".deps" = producer-tarballs;
        };
      });

    devShells = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system:
      let pkgs = nixpkgs.legacyPackages.${system}; in {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 pkgs.pnpm_12 ];
          shellHook = self.packages.${system}.producer-tarballs.shellHook;
        };
      });
  };
}
```

Then, inside `nix develop`:

```sh
nix eval --raw .#producer-tarballs.overrides   # paste the output into pnpm-workspace.yaml
pnpm add effect
```

Declare each package you use in `package.json` as a tarball in `.deps/`, for example:

```json
"@systemfsoftware/effect-daemon-spec": "file:.deps/effect-daemon-spec.tgz"
```

Add `.deps/` to `.gitignore`. Add the medium you supervise children with (`effect-daemon-process`, `effect-daemon-socket` or `effect-daemon-cluster`), and `effect-daemon-conformance` to prove a medium of your own.

## Quick start

A child is an Effect. A bare Effect counts as started as soon as it runs; a function of `ready` counts as started when it calls `ready`, for example once a server is listening.

```ts
import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import { Effect, Layer } from 'effect'

const database = Effect.andThen(Effect.log('database connected'), Effect.never)

const httpServer = (ready: Effect.Effect<void>) =>
  Effect.gen(function*() {
    yield* Effect.log('listening on :8080')
    yield* ready
    return yield* Effect.never
  })

const app = Supervisor.make('app').pipe(
  Supervisor.strategy('rest_for_one'),
  Supervisor.intensity(3, 5_000),
  Supervisor.children([
    Supervisor.ChildSpecs.make('database', database),
    Supervisor.ChildSpecs.make('http', httpServer),
  ]),
)

Layer.launch(app.layer).pipe(Effect.runFork)
```

If the database fails, `rest_for_one` stops the HTTP server, restarts the database and starts the server again. A fourth restart within five seconds stops both children and terminates the supervisor. The [spec package README](packages/effect-daemon-spec/README.md) covers every strategy, child option and trace entry.

## Contributing

Development setup and contribution workflow are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. Each package ships its own `LICENSE` file; see [the spec package's](packages/effect-daemon-spec/LICENSE).
