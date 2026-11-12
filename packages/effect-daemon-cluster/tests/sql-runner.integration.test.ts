import { PgClient } from '@effect/sql-pg'
import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Scope,
} from 'effect'
import { type Sharding, SqlRunnerStorage } from 'effect/cluster'
import * as SqlClient from 'effect/sql/SqlClient'
import { GenericContainer, Wait } from 'testcontainers'

const Feature = makeFeature({ it })

const PREFIX = 'singletons'
const NAMES = Arr.makeBy(8, (index) => `orders/settlement-${index}`)
const POLL = Duration.millis(500)
const EXPIRATION = Duration.seconds(6)
const RUNNER_PASSWORD = 'runner'

interface Database {
  readonly host: string
  readonly port: number
  readonly admin: Context.Context<SqlClient.SqlClient>
}

interface RunEvent {
  readonly runner: string
  readonly name: string
  readonly phase: 'start' | 'end'
  readonly at: number
}

interface Runner {
  readonly name: string
  readonly scope: Scope.Closeable
  readonly context: Context.Context<ClusterMedium.ClusterMediumPort | Sharding.Sharding>
}

class RunnerTarget extends Context.Service<RunnerTarget, {
  readonly database: Database
  readonly name: string
  readonly applicationName: string
}>()('RunnerTarget') {}

const runnerClient = Layer.unwrap(
  Effect.gen(function*() {
    const target = yield* RunnerTarget
    return PgClient.layer({
      host: target.database.host,
      port: target.database.port,
      database: 'postgres',
      username: `runner_${target.name}`,
      password: Redacted.make(RUNNER_PASSWORD),
      applicationName: target.applicationName,
      maxConnections: 2,
    })
  }),
)

const runnerSettings = Layer.unwrap(
  Effect.gen(function*() {
    const target = yield* RunnerTarget
    return Layer.succeed(ClusterMedium.SqlRunnerSettings, {
      prefix: PREFIX,
      runnerAddress: { host: target.name, port: 1 },
      sharding: {
        refreshAssignmentsInterval: POLL,
        shardLockRefreshInterval: Duration.seconds(2),
        shardLockExpiration: EXPIRATION,
      },
    })
  }),
)

const runnerLayer = Layer.merge(ClusterMedium.layer(), ClusterMedium.sqlRunnerLayer).pipe(
  Layer.provide([runnerSettings, runnerClient]),
)

const startedPostgres = Effect.acquireRelease(
  Effect.promise(() =>
    new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'postgres' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
  ),
  (container) => Effect.promise(() => container.stop()),
)

const database = Effect.gen(function*() {
  const container = yield* startedPostgres
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const admin = yield* Layer.build(
    PgClient.layer({ host, port, database: 'postgres', username: 'postgres', password: Redacted.make('postgres') }),
  )
  yield* Layer.build(SqlRunnerStorage.layerMigrations({ prefix: PREFIX })).pipe(Effect.provide(admin))
  yield* Effect.forEach(['a', 'b'], (name) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE ROLE runner_${name} LOGIN PASSWORD '${RUNNER_PASSWORD}'`)
      yield* sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO runner_${name}`)
      yield* sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO runner_${name}`)
    }).pipe(Effect.provide(admin)))
  return { host, port, admin }
}).pipe(Effect.orDie)

const asAdmin = <A, E>(db: Database, statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.flatMap(SqlClient.SqlClient, statement).pipe(Effect.provide(db.admin), Effect.orDie)

const recorded = (log: Ref.Ref<ReadonlyArray<RunEvent>>, runner: string, name: string, phase: RunEvent['phase']) =>
  Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.update(log, Arr.append({ runner, name, phase, at })))

const startedRunner = (db: Database, name: string, applicationName = `${name}:1`) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const context = yield* Layer.buildWithScope(runnerLayer, scope).pipe(
      Effect.provideService(RunnerTarget, { database: db, name, applicationName }),
    )
    return { name, scope, context }
  })

const supervising = (log: Ref.Ref<ReadonlyArray<RunEvent>>, runner: Runner) =>
  Effect.forEach(NAMES, (name) =>
    Effect.gen(function*() {
      const { medium } = yield* ClusterMedium.port
      const evidence = yield* medium.start(ClusterMedium.singletonChild({
        name,
        run: (ready) =>
          recorded(log, runner.name, name, 'start').pipe(
            Effect.andThen(ready),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => recorded(log, runner.name, name, 'end')),
          ),
      }))
      yield* evidence.ready
    }).pipe(Effect.provide(runner.context), Effect.provideService(Scope.Scope, runner.scope)), { discard: true })

const startsOf = (events: ReadonlyArray<RunEvent>, runner: string): ReadonlyArray<RunEvent> =>
  Arr.filter(events, (event) => event.runner === runner && event.phase === 'start')

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, within: Duration.Duration) =>
  check.pipe(
    Effect.repeat({ until: (done: boolean) => done, schedule: Schedule.spaced(Duration.millis(100)) }),
    Effect.timeoutOption(within),
    Effect.map(Option.isSome),
  )

const allStartedOn = (log: Ref.Ref<ReadonlyArray<RunEvent>>, runner: string) =>
  Effect.map(Ref.get(log), (events) => startsOf(events, runner).length >= NAMES.length)

const owning = (db: Database, log: Ref.Ref<ReadonlyArray<RunEvent>>, name: string) =>
  Effect.gen(function*() {
    const runner = yield* startedRunner(db, name)
    yield* supervising(log, runner)
    const owned = yield* eventually(allStartedOn(log, name), Duration.seconds(20))
    return { runner, owned }
  })

const sessionsPerAddress = (db: Database) =>
  asAdmin(db, (sql) =>
    sql<{ readonly sessions: number }>`
      SELECT count(*)::int AS sessions FROM pg_stat_activity
      WHERE application_name IN ('a:1', 'b:1') GROUP BY application_name
    `).pipe(Effect.map((rows) => Arr.reduce(rows, 0, (most, row) => Math.max(most, row.sessions))))

const firstAt = (events: ReadonlyArray<RunEvent>, runner: string, name: string, phase: RunEvent['phase']) =>
  Option.map(
    Arr.findFirst(events, (event) => event.runner === runner && event.name === name && event.phase === phase),
    (event) => event.at,
  )

Feature('Running singletons across processes over Postgres', { timeout: 180_000 })
  .withLayer(Layer.empty)
  .live('two runners poll real Postgres in a container on the live clock')
  .body(({ scenario }) => {
    scenario(
      'A runner that joins while another owns the singletons waits as a standby',
      Gherkin.Do.pipe(
        Given('a Postgres in a container with the runner tables and a login role per runner')('db', () => database),
        Given('a log of every singleton run')('log', () => Ref.make<ReadonlyArray<RunEvent>>([])),
        Given('runner "a" supervising eight singletons and running them all')('a', (s) => owning(s.db, s.log, 'a')),
        When('runner "b" joins and supervises the same eight singletons for six polls')(
          'joined',
          (s) =>
            Effect.gen(function*() {
              const b = yield* startedRunner(s.db, 'b')
              yield* supervising(s.log, b)
              const samples = yield* Effect.forEach(
                Arr.makeBy(6, () => Effect.andThen(Effect.sleep(POLL), sessionsPerAddress(s.db))),
                (sample) => sample,
              )
              return {
                mostSessions: Arr.reduce(samples, 0, (most, sessions) => Math.max(most, sessions)),
                events: yield* Ref.get(s.log),
              }
            }),
        ),
        Then('"a" ran every singleton, "b" ran none, and no runner held more than two sessions')((s, expect) =>
          expect({
            owned: s.a.owned,
            startedOnA: startsOf(s.joined.events, 'a').length,
            startedOnB: startsOf(s.joined.events, 'b').length,
            mostSessions: s.joined.mostSessions <= 2,
          }).toEqual({ owned: true, startedOnA: NAMES.length, startedOnB: 0, mostSessions: true })
        ),
      ),
    )

    scenario(
      "When the owner stops cleanly the standby starts every singleton only after the owner's run ended",
      Gherkin.Do.pipe(
        Given('a Postgres in a container with the runner tables and a login role per runner')('db', () => database),
        Given('a log of every singleton run')('log', () => Ref.make<ReadonlyArray<RunEvent>>([])),
        Given('runner "a" supervising eight singletons and running them all')('a', (s) => owning(s.db, s.log, 'a')),
        Given('runner "b" supervising the same singletons as a standby')(
          'b',
          (s) => Effect.tap(startedRunner(s.db, 'b'), (b) => supervising(s.log, b)),
        ),
        When('runner "a" stops')('stopped', (s) =>
          Effect.gen(function*() {
            yield* Scope.close(s.a.runner.scope, Exit.void)
            const taken = yield* eventually(allStartedOn(s.log, 'b'), Duration.seconds(20))
            return { taken, events: yield* Ref.get(s.log) }
          })),
        Then('each singleton started on "b" after it ended on "a", and within two seconds of that end')((s, expect) =>
          expect({
            taken: s.stopped.taken,
            handovers: Arr.map(NAMES, (name) =>
              Option.match(
                Option.all([
                  firstAt(s.stopped.events, 'a', name, 'end'),
                  firstAt(s.stopped.events, 'b', name, 'start'),
                ]),
                {
                  onNone: () => 'never handed over',
                  onSome: ([ended, started]) =>
                    started < ended ? 'overlapped' : started - ended <= 2_000 ? 'handed over' : 'late',
                },
              )),
          }).toEqual({ taken: true, handovers: Arr.map(NAMES, () => 'handed over') })
        ),
      ),
    )

    scenario(
      "When the owner's sessions are severed the standby takes over before the owner's heartbeat expires, and the owner rejoins as a standby",
      Gherkin.Do.pipe(
        Given('a Postgres in a container with the runner tables and a login role per runner')('db', () => database),
        Given('a log of every singleton run')('log', () => Ref.make<ReadonlyArray<RunEvent>>([])),
        Given('runner "a" supervising eight singletons and running them all')('a', (s) => owning(s.db, s.log, 'a')),
        Given('runner "b" supervising the same singletons as a standby')(
          'b',
          (s) => Effect.tap(startedRunner(s.db, 'b'), (b) => supervising(s.log, b)),
        ),
        When('every session of runner "a" is terminated and its role refuses new logins')(
          'severed',
          (s) =>
            Effect.gen(function*() {
              const severedAt = yield* Clock.currentTimeMillis
              yield* asAdmin(s.db, (sql) =>
                sql`ALTER ROLE runner_a NOLOGIN`.pipe(
                  Effect.andThen(
                    sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'runner_a'`,
                  ),
                ))
              const taken = yield* eventually(allStartedOn(s.log, 'b'), Duration.seconds(30))
              const takenAt = yield* Clock.currentTimeMillis
              return { taken, tookMillis: takenAt - severedAt }
            }),
        ),
        When('runner "a" may log in again and reconnects for six polls')('healed', (s) =>
          Effect.gen(function*() {
            yield* asAdmin(s.db, (sql) => sql`ALTER ROLE runner_a LOGIN`)
            const healedAt = yield* Clock.currentTimeMillis
            const reconnected = yield* eventually(
              asAdmin(s.db, (sql) =>
                sql<{ readonly sessions: number }>`
                  SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename = 'runner_a'
                `.pipe(Effect.map((rows) => Arr.some(rows, (row) => row.sessions > 0)))),
              Duration.seconds(20),
            )
            yield* Effect.sleep(Duration.times(POLL, 6))
            return { reconnected, healedAt, events: yield* Ref.get(s.log) }
          })),
        Then(
          '"b" took every singleton inside the heartbeat expiry, and after the heal "a" started none while "b" kept them',
        )(
          (s, expect) =>
            expect({
              taken: s.severed.taken,
              insideExpiry: s.severed.tookMillis < Duration.toMillis(EXPIRATION),
              reconnected: s.healed.reconnected,
              startedOnAAfterHeal: Arr.filter(startsOf(s.healed.events, 'a'), (event) => event.at >= s.healed.healedAt)
                .length,
              endedOnB: Arr.filter(s.healed.events, (event) => event.runner === 'b' && event.phase === 'end').length,
            }).toEqual({ taken: true, insideExpiry: true, reconnected: true, startedOnAAfterHeal: 0, endedOnB: 0 }),
        ),
      ),
    )

    scenario(
      'A runner whose sessions do not carry its address fails to start',
      Gherkin.Do.pipe(
        Given('a Postgres in a container with the runner tables and a login role per runner')('db', () => database),
        When('runner "a" starts with sessions named "someone-else:1"')(
          'started',
          (s) => Effect.exit(startedRunner(s.db, 'a', 'someone-else:1')),
        ),
        Then('it fails with RunnerSessionsUnnamed naming its address and the name its sessions carry')((s, expect) =>
          expect(Exit.match(s.started, {
            onSuccess: () => Option.none(),
            onFailure: (cause) =>
              Cause.findErrorOption(cause).pipe(
                Option.filter((error) => error instanceof ClusterMedium.RunnerSessionsUnnamed),
                Option.map((error) => ({ runnerAddress: error.runnerAddress, applicationName: error.applicationName })),
              ),
          })).toEqual(Option.some({ runnerAddress: 'a:1', applicationName: Option.some('someone-else:1') }))
        ),
      ),
    )
  })
