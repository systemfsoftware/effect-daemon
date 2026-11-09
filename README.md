# effect-daemon

Erlang/OTP-style supervision trees for Effect, and the media that run their children: operating-system processes, sockets and effect/cluster, with a pairwise conformance suite.

## Packages

- [`@systemfsoftware/effect-daemon-cluster`](packages/effect-daemon-cluster/README.md): The effect-daemon-spec medium over effect/cluster — entities and single-owner singletons supervised with inferred death and eventual group stop.
- [`@systemfsoftware/effect-daemon-conformance`](packages/effect-daemon-conformance/README.md): Pairwise conformance for effect-daemon-spec media — scripted child lifecycles, a medium-independent scenario catalogue, trace projection to a medium's declaration, and a fiber-reference comparison.
- [`@systemfsoftware/effect-daemon-process`](packages/effect-daemon-process/README.md): The effect-daemon-spec medium over operating-system child processes — a command spec spawned through ChildProcessSpawner, its exit code and terminating signal reported as observed, and its shutdown mapped to SIGTERM and SIGKILL.
- [`@systemfsoftware/effect-daemon-socket`](packages/effect-daemon-socket/README.md): The effect-daemon-spec medium over effect/socket — long-lived connections supervised with readiness conditions, close and refusal reported as received, and graceful-then-forced shutdown.
- [`@systemfsoftware/effect-daemon-spec`](packages/effect-daemon-spec/README.md): Supervision-tree daemons for Effect-TS — leader election, distributed locks, restart-intensity backoff, dynamic children, and health latches as a pure typed core.

## Install

```bash
pnpm add @systemfsoftware/effect-daemon-spec effect
```

Add the medium package you supervise children with (`effect-daemon-process`, `effect-daemon-socket` or
`effect-daemon-cluster`), and `effect-daemon-conformance` to prove a medium of your own.

The npm registry lags this repository's sources: `@systemfsoftware/effect-daemon-cluster` is 1.0.0 on npm and 1.0.3 here; `@systemfsoftware/effect-daemon-conformance` is 1.0.0 on npm and 1.0.3 here; `@systemfsoftware/effect-daemon-process` is 1.0.0 on npm and 1.0.3 here; `@systemfsoftware/effect-daemon-socket` is 1.0.0 on npm and 1.0.3 here; `@systemfsoftware/effect-daemon-spec` is 6.0.0 on npm and 6.0.3 here. Each package's README describes its current source.

## Usage

- [`@systemfsoftware/effect-daemon-cluster`](packages/effect-daemon-cluster/README.md)
- [`@systemfsoftware/effect-daemon-conformance`](packages/effect-daemon-conformance/README.md)
- [`@systemfsoftware/effect-daemon-process`](packages/effect-daemon-process/README.md)
- [`@systemfsoftware/effect-daemon-socket`](packages/effect-daemon-socket/README.md)
- [`@systemfsoftware/effect-daemon-spec`](packages/effect-daemon-spec/README.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## License

[Apache-2.0](packages/effect-daemon-cluster/LICENSE)
