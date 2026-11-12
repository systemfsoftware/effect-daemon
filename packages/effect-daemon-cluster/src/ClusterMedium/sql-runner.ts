import { Array as Arr, Context, Duration, Effect, Layer, Option } from 'effect'
import {
  ClusterError,
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  SqlRunnerStorage,
} from 'effect/cluster'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import { RunnerSessionsUnnamed } from './RunnerSessionsUnnamed.schema.js'

export interface SqlRunnerOptions {
  readonly prefix: string
  readonly runnerAddress: { readonly host: string; readonly port: number }
  readonly sharding?: Partial<Omit<ShardingConfig.ShardingConfig['Service'], 'runnerAddress' | 'runnerListenAddress'>>
}

export class SqlRunnerSettings extends Context.Service<SqlRunnerSettings, SqlRunnerOptions>()(
  '@systemfsoftware/effect-daemon-cluster/SqlRunnerSettings',
) {}

const addressText = (address: { readonly host: string; readonly port: number }): string =>
  `${address.host}:${address.port}`

const persisted = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ClusterError.PersistenceError, R> =>
  Effect.mapError(effect, (cause) => new ClusterError.PersistenceError({ cause }))

const sessionsNamed = (address: string): Effect.Effect<void, RunnerSessionsUnnamed | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly name: string }>`SELECT current_setting('application_name') AS name`
    const applicationName = Option.map(Arr.head(rows), (row) => row.name)
    if (!Option.contains(applicationName, address)) {
      return yield* new RunnerSessionsUnnamed({ runnerAddress: address, applicationName })
    }
  })

const shardingConfig = Layer.unwrap(
  Effect.gen(function*() {
    const settings = yield* SqlRunnerSettings
    const address = RunnerAddress.make(settings.runnerAddress.host, settings.runnerAddress.port)
    return ShardingConfig.layer({
      ...settings.sharding,
      runnerAddress: Option.some(address),
      runnerListenAddress: Option.some(address),
    })
  }),
)
const sqlStorage = Layer.unwrap(
  Effect.gen(function*() {
    const settings = yield* SqlRunnerSettings
    return SqlRunnerStorage.layerStorage({ prefix: settings.prefix })
  }),
)

const standbyStorage = Layer.effect(
  RunnerStorage.RunnerStorage,
  Effect.gen(function*() {
    const settings = yield* SqlRunnerSettings
    const self = addressText(settings.runnerAddress)
    yield* sessionsNamed(self)
    const storage = yield* RunnerStorage.RunnerStorage
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const config = yield* ShardingConfig.ShardingConfig
    const runners = sql(`${settings.prefix}_runners`)
    const expirationSeconds = Math.ceil(Duration.toSeconds(Duration.fromInputUnsafe(config.shardLockExpiration)))
    const dropDeadRunners = sql`
      DELETE FROM ${runners} r
      WHERE r.last_heartbeat < NOW() - ${expirationSeconds} * INTERVAL '1 second'
        OR NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.application_name = r.address)
    `
    const incumbent = sql<{ readonly address: string }>`
      SELECT address FROM ${runners} WHERE healthy ORDER BY machine_id LIMIT 1
    `
    const placed = Effect.gen(function*() {
      yield* dropDeadRunners
      const owner = Option.map(Arr.head(yield* incumbent), (row) => row.address)
      const listed = yield* storage.getRunners
      return Arr.map(listed, ([runner]) => [runner, Option.contains(owner, addressText(runner.address))] as const)
    })
    return RunnerStorage.RunnerStorage.of({ ...storage, getRunners: persisted(placed) })
  }),
).pipe(Layer.provide(sqlStorage))

const noopTransport = Layer.provideMerge(Runners.layerNoop, MessageStorage.layerNoop)

export const sqlRunnerLayer: Layer.Layer<
  Sharding.Sharding,
  RunnerSessionsUnnamed | SqlError,
  SqlClient.SqlClient | SqlRunnerSettings
> = Sharding.layer.pipe(
  Layer.provide([noopTransport, standbyStorage, RunnerHealth.layerNoop]),
  Layer.provide(shardingConfig),
)
