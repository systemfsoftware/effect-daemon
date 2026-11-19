import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { Array as Arr, Effect, Layer, Match, Ref, Stream } from 'effect'
import { RegistrationLedger, scriptedShardingOwning, ShardScript } from './__fixtures__/scripted-sharding.fixture.js'

const Feature = makeFeature({ it })

const SINGLETON = 'orders/settlement'
const DEPENDENT = 'orders/receipts'

type Statuses = ReadonlyArray<readonly [string, number, string]>

const statusesOf = (handle: Supervisor.RunningSupervisor): Effect.Effect<Statuses> =>
  Effect.map(Supervisor.statusOf(handle), (state) =>
    Match.value(state).pipe(
      Match.tag('Terminated', () => Arr.empty<readonly [string, number, string]>()),
      Match.orElse((running) =>
        Arr.map(running.core.children, (child) => [child.childId, child.generation, child.status] as const)
      ),
    ))

const heldNames: Effect.Effect<ReadonlyArray<string>, never, RegistrationLedger> = Effect.flatten(
  Effect.map(Effect.service(RegistrationLedger), (ledger) => ledger.held),
)

interface LifecycleState {
  readonly handle: Supervisor.RunningSupervisor
  readonly trace: Ref.Ref<ReadonlyArray<Supervisor.TraceEntry>>
  readonly runs: Ref.Ref<number>
  readonly initialized: Ref.Ref<boolean>
  readonly dependentSaw: Ref.Ref<boolean | null>
}

const lifecycleTree = Effect.gen(function*() {
  const runs = yield* Ref.make(0)
  const initialized = yield* Ref.make(false)
  const dependentSaw = yield* Ref.make<boolean | null>(null)
  const singleton = ClusterMedium.singletonChild({
    name: SINGLETON,
    run: (ready) =>
      Effect.gen(function*() {
        yield* Ref.update(runs, (count) => count + 1)
        yield* Ref.set(initialized, true)
        yield* ready
        return yield* Effect.never
      }),
  })
  const dependent = ClusterMedium.singletonChild({
    name: DEPENDENT,
    run: (ready) =>
      Effect.gen(function*() {
        const saw = yield* Ref.get(initialized)
        yield* Ref.set(dependentSaw, saw)
        yield* ready
        return yield* Effect.never
      }),
  })
  const handle = yield* Supervisor.make('standby-tree').pipe(
    Supervisor.strategy('rest_for_one'),
    Supervisor.intensity(1, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('settlement', singleton, { startTimeoutMillis: 2_000 }),
      Supervisor.ChildSpecs.on(ClusterMedium.port)('dependent', dependent, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  const trace = yield* Ref.make<ReadonlyArray<Supervisor.TraceEntry>>([])
  yield* Stream.runForEach(Supervisor.traceOf(handle), (entry) => Ref.update(trace, (seen) => [...seen, entry])).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )
  return { handle, trace, runs, initialized, dependentSaw } satisfies LifecycleState
})

const eventLabel = (entry: Supervisor.TraceEntry): string =>
  Match.value(entry.event).pipe(
    Match.tag('ChildStarted', (started) => `started:${started.childId}:${started.generation}`),
    Match.tag('ChildStandby', (standby) => `standby:${standby.childId}:${standby.generation}`),
    Match.tag('ChildAcquired', (acquired) => `acquired:${acquired.childId}:${acquired.generation}`),
    Match.tag('ChildReady', (ready) => `ready:${ready.childId}:${ready.generation}`),
    Match.tag('ChildReleased', (released) => `released:${released.childId}:${released.generation}`),
    Match.tag('ChildTerminated', (terminated) => `terminated:${terminated.childId}:${terminated.generation}`),
    Match.orElse(() => 'other'),
  )

const traceLabelsOf = (state: LifecycleState): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(Ref.get(state.trace), (entries) => Arr.map(entries, eventLabel))

const countOf = (labels: ReadonlyArray<string>, prefix: string): number =>
  Arr.filter(labels, (label) => label.startsWith(prefix)).length

const firstIndexOf = (labels: ReadonlyArray<string>, wanted: string): number =>
  Arr.findFirstIndex(labels, (label) => label === wanted).pipe(
    Match.value,
    Match.tag('Some', ({ value }) => value),
    Match.tag('None', () => -1),
    Match.exhaustive,
  )

const standbyToHandoffAndBack = Effect.gen(function*() {
  const state = yield* lifecycleTree
  const shards = yield* ShardScript
  yield* Effect.sleep('50 millis')
  const bootStatuses = yield* statusesOf(state.handle)
  const bootHeld = yield* heldNames
  yield* shards.grant(SINGLETON)
  yield* shards.grant(DEPENDENT)
  yield* Effect.sleep('50 millis')
  const activeStatuses = yield* statusesOf(state.handle)
  const activeHeld = yield* heldNames
  const runsAfterPromotion = yield* Ref.get(state.runs)
  const dependentSawInitialized = yield* Ref.get(state.dependentSaw)
  const activeLabels = yield* traceLabelsOf(state)
  const dependentStartedAfterSingletonReady = firstIndexOf(activeLabels, 'ready:settlement:0') < firstIndexOf(
    activeLabels,
    'started:dependent:0',
  )
  yield* shards.revoke(SINGLETON)
  yield* Effect.sleep('50 millis')
  const handedOffStatuses = yield* statusesOf(state.handle)
  const handedOffLabels = yield* traceLabelsOf(state)
  const handoffLeftDependentRunning = countOf(handedOffLabels, 'terminated') === 0 &&
    countOf(handedOffLabels, 'started:dependent') === 1 &&
    countOf(handedOffLabels, 'released:settlement') === 1
  yield* shards.grant(SINGLETON)
  yield* Effect.sleep('50 millis')
  const repromotedStatuses = yield* statusesOf(state.handle)
  const repromotedLabels = yield* traceLabelsOf(state)
  const runsAfterRepromotion = yield* Ref.get(state.runs)
  const supervisorRunning = Arr.length(repromotedStatuses) > 0
  yield* Supervisor.shutdown(state.handle)
  return {
    bootStatuses,
    bootHeld,
    activeStatuses,
    activeHeld,
    runsAfterPromotion,
    dependentSawInitialized,
    dependentStartedAfterSingletonReady,
    handedOffStatuses,
    handoffLeftDependentRunning,
    repromotedStatuses,
    supervisorRunning,
    runsAfterRepromotion,
    acquisitions: countOf(repromotedLabels, 'acquired:settlement'),
    dependentStarts: countOf(repromotedLabels, 'started:dependent'),
    terminated: countOf(repromotedLabels, 'terminated'),
  }
})

const timeoutEventsOf = (entries: ReadonlyArray<Supervisor.TraceEntry>): ReadonlyArray<string> =>
  Arr.map(entries, (entry) =>
    Match.value(entry.event).pipe(
      Match.tag('SupervisorStarted', () => 'supervisor-started'),
      Match.tag('ChildStarted', () => 'started'),
      Match.tag('ChildStandby', () => 'standby'),
      Match.tag('ChildAcquired', () => 'acquired'),
      Match.tag('ChildTerminated', () => 'terminated'),
      Match.tag('TimerElapsed', () => 'timer'),
      Match.orElse(() => 'other'),
    ))

const postAcquisitionTimeout = Effect.gen(function*() {
  const neverReady = ClusterMedium.singletonChild({
    name: 'orders/hanging',
    run: () => Effect.never,
  })
  const handle = yield* Supervisor.make('timeout-tree').pipe(
    Supervisor.strategy('one_for_one'),
    Supervisor.intensity(0, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('hanging', neverReady, { startTimeoutMillis: 200 }),
    ]),
  ).scoped
  const trace = yield* Ref.make<ReadonlyArray<Supervisor.TraceEntry>>([])
  yield* Stream.runForEach(Supervisor.traceOf(handle), (entry) => Ref.update(trace, (seen) => [...seen, entry])).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )
  yield* Effect.sleep('400 millis')
  const standbyStatuses = yield* statusesOf(handle)
  const shards = yield* ShardScript
  yield* shards.grant('orders/hanging')
  yield* Effect.sleep('2 seconds')
  const afterTimeoutStatuses = yield* statusesOf(handle)
  const events = yield* Effect.map(Ref.get(trace), timeoutEventsOf)
  const acquiredAt = firstIndexOf(events, 'acquired')
  const fromAcquisition = acquiredAt === -1 ? events : Arr.drop(events, acquiredAt)
  return { standbyStatuses, afterTimeoutStatuses, fromAcquisition }
})

Feature('Standby singletons under shard movement', { timeout: 120_000 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario }) => {
    scenario(
      'A rest-for-one dependent starts only after the standby singleton owns its shard and runs ready, and handoff is not a failure',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('the singleton acquires its shard, hands off, and is promoted again')(
          'observed',
          (s) => Effect.provide(standbyToHandoffAndBack, s.environment),
        ),
        Then('standby, acquisition, ordering, handoff and re-promotion are all visible with no termination')(
          (s, expect) =>
            expect(s.observed).toEqual({
              bootStatuses: [['settlement', 0, 'standby'], ['dependent', 0, 'starting']],
              bootHeld: [SINGLETON],
              activeStatuses: [['settlement', 0, 'ready'], ['dependent', 0, 'ready']],
              activeHeld: [SINGLETON, DEPENDENT],
              runsAfterPromotion: 1,
              dependentSawInitialized: true,
              dependentStartedAfterSingletonReady: true,
              handedOffStatuses: [['settlement', 0, 'standby'], ['dependent', 0, 'ready']],
              handoffLeftDependentRunning: true,
              repromotedStatuses: [['settlement', 0, 'ready'], ['dependent', 0, 'ready']],
              supervisorRunning: true,
              runsAfterRepromotion: 2,
              acquisitions: 2,
              dependentStarts: 1,
              terminated: 0,
            }),
        ),
      ),
    )

    scenario(
      'A standby singleton has no start deadline until its shard arrives, and the post-acquisition start is bounded',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('a never-ready singleton waits standby longer than its start timeout and then acquires its shard')(
          'observed',
          (s) => Effect.provide(postAcquisitionTimeout, s.environment),
        ),
        Then('nothing fired while standby, and the deadline missed only after acquisition')((s, expect) =>
          expect(s.observed).toEqual({
            standbyStatuses: [['hanging', 0, 'standby']],
            afterTimeoutStatuses: [],
            fromAcquisition: ['acquired', 'timer', 'terminated'],
          })
        ),
      ),
    )
  })
