# @systemfsoftware/effect-daemon-cluster

The `@systemfsoftware/effect-daemon-spec` medium over `effect/cluster`: cluster entities
and single-owner singletons are supervised with inferred death and eventual group stop.

## Installation

This package is not on npm: take `@systemfsoftware/effect-daemon-cluster` from nix.systemfsoftware.com, the package registry for `@systemfsoftware` packages, through a flake input (see the repository README).

## Features

- **Entities and single-owner singletons**: a child is either an entity reached by a direct liveness
  call, or a `Singleton.make`-style single-owner effect whose registration lifetime is the
  incarnation.
- **Inferred death, never `RunnerHealth`**: the medium's liveness probe calls the child directly;
  a failing singleton `run` becomes a defect, and a death the medium cannot observe is reported as
  an inferred failure.
- **The declared loss**: the medium declares `{ reporting: 'inferred', groupStop: 'eventual' }`, so
  the conformance kit holds it only to what it can observe and honour.
- **Standby and handoff**: a singleton whose shard another runner owns is announced ready at once
  and waits; it starts when the shard arrives. A run interrupted because its shard moved away is a
  handoff, not a termination: the child stays registered and nothing is reported.
- **Singletons across processes over Postgres**: `ClusterMedium.sqlRunnerLayer` runs `Sharding`
  over `SqlRunnerStorage` with no-op runner transport, health and message storage. The oldest live
  runner owns every shard, so a joining process waits as a standby, and a runner whose sessions are
  gone leaves at the next assignment poll instead of after its heartbeat expires.
- **Proven, not asserted**: `ClusterMedium.conformanceDriver` runs the whole scenario catalogue
  against the fiber reference.

## Usage

```ts
import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import { Effect } from 'effect'
import { SingleRunner } from 'effect/cluster'

const handleOrders = (ready: Effect.Effect<void>) => Effect.andThen(ready, serveOrders)

const spec = Supervisor.make('cluster-workers').pipe(
  Supervisor.children([
    Supervisor.ChildSpecs.on(ClusterMedium.port)(
      'orders',
      ClusterMedium.singletonChild({ name: 'orders', run: handleOrders }),
      { restartType: 'permanent' },
    ),
  ]),
)

// `ClusterRunner` is `SingleRunner.layer(options)` provided with a `SqlClient` and `Crypto`.
const program = work.pipe(
  Effect.provide(spec.layer),
  Effect.provide(ClusterMedium.layer()),
  Effect.provide(ClusterRunner),
)
```

`ClusterMedium.layer(options?)` binds the port at the composition root, so a tree can mix media;
`options.shardGroup` sets the shard group singleton children register under. An entity child is
declared with `ClusterMedium.entityChild({ entity, entityId, register, probe })`, where `probe` is
the direct liveness call to the entity.

### Singletons across processes

```ts
import { PgClient } from '@effect/sql-pg'
import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Layer, Redacted } from 'effect'

const address = { host: `worker-${crypto.randomUUID().slice(0, 8)}`, port: 1 }

const ClusterRunner = ClusterMedium.sqlRunnerLayer.pipe(
  Layer.provide(Layer.succeed(ClusterMedium.SqlRunnerSettings, {
    prefix: 'cluster',
    runnerAddress: address,
    sharding: { refreshAssignmentsInterval: '1 second' },
  })),
  Layer.provide(PgClient.layer({
    url: Redacted.make(databaseUrl),
    applicationName: `${address.host}:${address.port}`,
    maxConnections: 2,
  })),
)
```

- The `SqlClient` must open every session with the runner address `host:port` as its
  `application_name`; the layer fails with `RunnerSessionsUnnamed` otherwise. A runner is live while
  any session carries its address, so give each process its own address.
- The runner and lock tables are `<prefix>_runners` and `<prefix>_locks` (a dotted prefix names a
  schema). The layer never creates them: apply `SqlRunnerStorage.migrations` with an owner role
  first. No message tables are needed.
- One process uses two sessions: the reserved lock session, whose `idle_session_timeout` is the
  shard lock expiration, and one pooled session for the polls.
- On a clean stop the owner's singletons end, it unregisters and releases its locks, and the next
  oldest runner starts them at its next poll. A runner whose sessions all end leaves at the next
  poll; a frozen one leaves when its heartbeat and lock session expire (`shardLockExpiration`).
- Placement is fixed: the live runner with the lowest `machine_id` owns every shard.

## Conformance

```ts
import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Conformance } from '@systemfsoftware/effect-daemon-conformance'
import { Effect } from 'effect'

const report = yield* Conformance.prove(ClusterMedium.conformanceDriver)
Conformance.isConforming(report)
```

## License

Apache-2.0
