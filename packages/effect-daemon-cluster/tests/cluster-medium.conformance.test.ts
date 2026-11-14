import { Conformance } from '@systemfsoftware/conformance-spec'
import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Conformance as Medium } from '@systemfsoftware/effect-daemon-conformance'
import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { Duration, Effect, Layer, Match, Option, Ref, Schedule } from 'effect'
import type { Scope } from 'effect'
import type { Sharding } from 'effect/cluster'
import {
  ChildNotReportedAsInferredDeath,
  ChildReportedOtherThanShutdown,
  nothingLeftRegistered,
  RunningChildAnsweredDead,
  scriptedSharding,
  scriptedShardingOwning,
  ShardScript,
} from './__fixtures__/scripted-sharding.fixture.js'

const Feature = makeFeature({ it })

type Project = ClusterMedium.ClusterMediumPort | Sharding.Sharding | Scope.Scope

const liveReason =
  'each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run'

const becomeReady: Medium.ChildStep = { _tag: 'BecomeReady' }

const shutdownOnly = (
  reason: Supervisor.Medium.TerminationReason,
): Effect.Effect<void, ChildReportedOtherThanShutdown> =>
  Match.value(reason).pipe(
    Match.tag('Shutdown', () => Effect.void),
    Match.tag('Normal', () => new ChildReportedOtherThanShutdown({ observed: 'Normal' })),
    Match.tag('Abnormal', () => new ChildReportedOtherThanShutdown({ observed: 'Abnormal' })),
    Match.exhaustive,
  )

const superviseScriptedSingleton: Effect.Effect<
  void,
  ChildReportedOtherThanShutdown | RunningChildAnsweredDead,
  Project
> = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const launched = yield* ClusterMedium.conformanceDriver.launch('worker', [becomeReady])
  yield* launched.control.advance(becomeReady, 0)
  const evidence = yield* medium.start(launched.program)
  yield* evidence.ready
  const alive = yield* medium.probe(evidence)
  if (!alive) return yield* new RunningChildAnsweredDead()
  yield* medium.stop(evidence, { _tag: 'Brutal' })
  yield* shutdownOnly(yield* medium.report(evidence))
})

const superviseScriptedEntity: Effect.Effect<void, RunningChildAnsweredDead, Project> = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const evidence = yield* medium.start(
    ClusterMedium.entityChild({
      entityId: 'orders/scripted',
      register: Effect.void,
      probe: Effect.succeed(true),
    }),
  )
  yield* evidence.ready
  const alive = yield* medium.probe(evidence)
  if (!alive) return yield* new RunningChildAnsweredDead()
})

const inferredDeathOnly = (
  reason: Supervisor.Medium.TerminationReason,
): Effect.Effect<void, ChildNotReportedAsInferredDeath> =>
  Match.value(reason).pipe(
    Match.tag('Abnormal', (abnormal) =>
      Match.value(abnormal.report).pipe(
        Match.tag('InferredReport', () => Effect.void),
        Match.orElse(() => new ChildNotReportedAsInferredDeath({ observed: 'a report other than inferred' })),
      )),
    Match.orElse(() => new ChildNotReportedAsInferredDeath({ observed: 'a termination other than abnormal' })),
  )

const superviseDyingEntity: Effect.Effect<void, ChildNotReportedAsInferredDeath, Project> = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const evidence = yield* medium.start(
    ClusterMedium.entityChild({
      entityId: 'orders/dying',
      register: Effect.die(new globalThis.Error('the entity died before it became ready')),
      probe: Effect.succeed(false),
    }),
  )
  yield* inferredDeathOnly(yield* medium.report(evidence))
})

const SINGLETON = 'orders/settlement'

const countedSingleton = Effect.map(Ref.make(0), (runs) => ({
  runs,
  program: ClusterMedium.singletonChild({
    name: SINGLETON,
    run: (ready) => Ref.update(runs, (count) => count + 1).pipe(Effect.andThen(ready), Effect.andThen(Effect.never)),
  }),
}))

const runsReach = (runs: Ref.Ref<number>, count: number) =>
  Ref.get(runs).pipe(
    Effect.repeat({ until: (seen) => seen >= count, schedule: Schedule.spaced(Duration.millis(10)) }),
    Effect.timeoutOption(Duration.seconds(2)),
    Effect.map(Option.isSome),
  )

const reportedWithin = <R>(report: Effect.Effect<Supervisor.Medium.TerminationReason, never, R>) =>
  Effect.timeoutOption(report, Duration.millis(200))

const standbyThenOwned = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const shards = yield* ShardScript
  const { runs, program } = yield* countedSingleton
  const evidence = yield* medium.start(program)
  yield* evidence.ready
  const aliveAsStandby = yield* medium.probe(evidence)
  const runsAsStandby = yield* Ref.get(runs)
  yield* shards.grant(SINGLETON)
  const startedOnceOwned = yield* runsReach(runs, 1)
  const reported = yield* reportedWithin(medium.report(evidence))
  return { aliveAsStandby, runsAsStandby, startedOnceOwned, reported }
})

const handedOffAndBack = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const shards = yield* ShardScript
  const { runs, program } = yield* countedSingleton
  const evidence = yield* medium.start(program)
  yield* evidence.ready
  yield* shards.revoke(SINGLETON)
  const aliveWhileAway = yield* medium.probe(evidence)
  const reportedWhileAway = yield* reportedWithin(medium.report(evidence))
  yield* shards.grant(SINGLETON)
  const ranAgain = yield* runsReach(runs, 2)
  return { aliveWhileAway, reportedWhileAway, ranAgain }
})

const standbyStopped = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const { program } = yield* countedSingleton
  const evidence = yield* medium.start(program)
  yield* evidence.ready
  yield* medium.stop(evidence, { _tag: 'Brutal' })
  const reported = yield* reportedWithin(medium.report(evidence))
  yield* nothingLeftRegistered
  return { reported }
})

const standbyEnvironment = () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false)))
const ownedEnvironment = () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(true)))

Feature('Supervising children hosted by the cluster', { timeout: 120_000 })
  .withLayer(Layer.empty)
  .live(liveReason)
  .body(({ scenario }) => {
    scenario(
      'A singleton whose shard is on another runner waits as a standby and starts when the shard arrives',
      Gherkin.Do.pipe(
        Given('a cluster medium on a runner that owns no shard yet')('environment', standbyEnvironment),
        When('a singleton is supervised and its shard then moves to this runner')(
          'observed',
          (s) => Effect.provide(standbyThenOwned, s.environment),
        ),
        Then('it was ready and alive without running, ran once its shard arrived, and nothing ended')((s, expect) =>
          expect(s.observed).toEqual({
            aliveAsStandby: true,
            runsAsStandby: 0,
            startedOnceOwned: true,
            reported: Option.none(),
          })
        ),
      ),
    )

    scenario(
      'A singleton whose shard moves away and comes back keeps its place and runs again',
      Gherkin.Do.pipe(
        Given('a cluster medium on a runner that owns every shard')('environment', ownedEnvironment),
        When('a running singleton loses its shard and later gets it back')(
          'observed',
          (s) => Effect.provide(handedOffAndBack, s.environment),
        ),
        Then('it stayed alive with nothing ended while away, and ran a second time on return')((s, expect) =>
          expect(s.observed).toEqual({ aliveWhileAway: true, reportedWhileAway: Option.none(), ranAgain: true })
        ),
      ),
    )

    scenario(
      'A standby singleton that is stopped ends as shut down and frees its name',
      Gherkin.Do.pipe(
        Given('a cluster medium on a runner that owns no shard yet')('environment', standbyEnvironment),
        When('a waiting singleton is stopped')('observed', (s) => Effect.provide(standbyStopped, s.environment)),
        Then('it ended as shut down and no name stays held')((s, expect) =>
          expect(s.observed).toEqual({ reported: Option.some({ _tag: 'Shutdown' }) })
        ),
      ),
    )
    scenario(
      'A scripted singleton child is gone once the supervision that started it stops',
      Gherkin.Do.pipe(
        Given('a cluster medium bound to a scripted sharding that holds each registered name')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedSharding)),
        ),
        When('a scripted singleton is supervised and the supervision is stopped at every step')(
          'checked',
          (s) =>
            Conformance.released(Effect.provide(superviseScriptedSingleton, s.environment), {
              probe: Effect.provide(nothingLeftRegistered, s.environment),
            }),
        ),
        Then('the child answered its liveness probe and no name stays held once the supervision stops')((s, expect) =>
          expect(s.checked, Conformance.render(s.checked)).toMatchObject({ _tag: 'Pass' })
        ),
      ),
    )

    scenario(
      'An entity child that finishes registering is announced ready',
      Gherkin.Do.pipe(
        Given('a cluster medium bound to a scripted sharding that holds each registered name')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedSharding)),
        ),
        When('a child that finishes registering is supervised and the supervision is stopped at every step')(
          'checked',
          (s) =>
            Conformance.released(Effect.provide(superviseScriptedEntity, s.environment), {
              probe: Effect.provide(nothingLeftRegistered, s.environment),
            }),
        ),
        Then('the child was announced ready and no name stays held once the supervision stops')((s, expect) =>
          expect(s.checked, Conformance.render(s.checked)).toMatchObject({ _tag: 'Pass' })
        ),
      ),
    )

    scenario(
      'An entity child that dies before it becomes ready is reported as an inferred death',
      Gherkin.Do.pipe(
        Given('a cluster medium bound to a scripted sharding that holds each registered name')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedSharding)),
        ),
        When('a child that dies before it becomes ready is supervised and the supervision is stopped at every step')(
          'checked',
          (s) =>
            Conformance.released(Effect.provide(superviseDyingEntity, s.environment), {
              probe: Effect.provide(nothingLeftRegistered, s.environment),
            }),
        ),
        Then(
          'the death the medium cannot observe is reported as inferred, and no name stays held once the supervision stops',
        )((s, expect) => expect(s.checked, Conformance.render(s.checked)).toMatchObject({ _tag: 'Pass' })),
      ),
    )
  })
