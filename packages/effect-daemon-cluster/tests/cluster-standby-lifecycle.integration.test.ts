import { ClusterMedium } from '@systemfsoftware/effect-daemon-cluster'
import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import { Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { Array as Arr, Duration, Effect, Layer, Match, Queue, Ref, Stream } from 'effect'
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

const readyAfter = (millis: Duration.Input, ready: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.sleep(millis).pipe(Effect.andThen(ready), Effect.asVoid)

const traceCollector = (handle: Supervisor.RunningSupervisor) =>
  Effect.map(Ref.make<ReadonlyArray<Supervisor.TraceEntry>>([]), (trace) => ({
    trace,
    collect: Stream.runForEach(Supervisor.traceOf(handle), (entry) => Ref.update(trace, (seen) => [...seen, entry]))
      .pipe(Effect.forkScoped, Effect.asVoid),
  }))

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

const countOf = (labels: ReadonlyArray<string>, prefix: string): number =>
  labels.filter((label) => label.startsWith(prefix)).length

const firstIndexOf = (labels: ReadonlyArray<string>, wanted: string): number => labels.indexOf(wanted)

const reacquiredTimerIsNotKilled = Effect.gen(function*() {
  const shards = yield* ShardScript
  const singleton = ClusterMedium.singletonChild({
    name: 'orders/epoch',
    run: (ready) =>
      Effect.gen(function*() {
        yield* readyAfter('250 millis', ready)
        return yield* Effect.never
      }),
  })
  const handle = yield* Supervisor.make('epoch-tree').pipe(
    Supervisor.strategy('one_for_one'),
    Supervisor.intensity(3, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('epoch', singleton, { startTimeoutMillis: 400 }),
    ]),
  ).scoped
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* Effect.sleep('50 millis')
  yield* shards.grant('orders/epoch')
  yield* Effect.sleep('300 millis')
  yield* shards.revoke('orders/epoch')
  yield* Effect.sleep('50 millis')
  yield* shards.grant('orders/epoch')
  yield* Effect.sleep('500 millis')
  const statuses = yield* statusesOf(handle)
  const labels = yield* Effect.map(Ref.get(collector.trace), (entries) => Arr.map(entries, eventLabel))
  return { statuses, terminated: countOf(labels, 'terminated'), readyEvents: countOf(labels, 'ready:epoch') }
})

const interruptedBeforeReadyStaysStandby = Effect.gen(function*() {
  const shards = yield* ShardScript
  const slow = ClusterMedium.singletonChild({
    name: 'orders/slow',
    run: (ready) =>
      Effect.gen(function*() {
        yield* readyAfter('100 millis', ready)
        return yield* Effect.never
      }),
  })
  const watchdog = ClusterMedium.singletonChild({
    name: 'orders/watchdog',
    run: (ready) => Effect.andThen(ready, Effect.never),
  })
  const handle = yield* Supervisor.make('interrupted-tree').pipe(
    Supervisor.strategy('rest_for_one'),
    Supervisor.intensity(3, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('slow', slow, { startTimeoutMillis: 2_000 }),
      Supervisor.ChildSpecs.on(ClusterMedium.port)('watchdog', watchdog, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* Effect.sleep('50 millis')
  yield* shards.grant('orders/slow')
  yield* Effect.sleep('20 millis')
  yield* shards.revoke('orders/slow')
  yield* Effect.sleep('150 millis')
  const statuses = yield* statusesOf(handle)
  const held = yield* heldNames
  const labels = yield* Effect.map(Ref.get(collector.trace), (entries) => Arr.map(entries, eventLabel))
  return {
    statuses,
    held,
    slowReadyEvents: countOf(labels, 'ready:slow'),
    watchdogStarts: countOf(labels, 'started:watchdog'),
    terminated: countOf(labels, 'terminated'),
  }
})

const oneForOneRestartIsUngated = Effect.gen(function*() {
  const crashes = yield* Queue.unbounded<void>()
  const shards = yield* ShardScript
  const gate = ClusterMedium.singletonChild({
    name: 'orders/gate',
    run: (ready) => Effect.andThen(ready, Effect.never),
  })
  const worker = ClusterMedium.singletonChild({
    name: 'orders/worker',
    run: (ready) =>
      Effect.gen(function*() {
        yield* ready
        yield* Queue.take(crashes)
        return yield* Effect.die('crashed')
      }),
  })
  const handle = yield* Supervisor.make('ungated-tree').pipe(
    Supervisor.strategy('one_for_one'),
    Supervisor.intensity(3, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('gate', gate, { startTimeoutMillis: 2_000 }),
      Supervisor.ChildSpecs.on(ClusterMedium.port)('worker', worker, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* shards.grant('orders/gate')
  yield* Effect.sleep('50 millis')
  yield* shards.grant('orders/worker')
  yield* Effect.sleep('100 millis')
  yield* shards.revoke('orders/gate')
  yield* Effect.sleep('50 millis')
  const standbyStatuses = yield* statusesOf(handle)
  yield* Queue.offer(crashes, void 0)
  yield* Effect.sleep('100 millis')
  const restartedStatuses = yield* statusesOf(handle)
  const labels = yield* Effect.map(Ref.get(collector.trace), (entries) => Arr.map(entries, eventLabel))
  return {
    standbyStatuses,
    restartedStatuses,
    workerStarts: countOf(labels, 'started:worker'),
    terminated: countOf(labels, 'terminated'),
  }
})

const acquisitionDuringBackoffIsKept = Effect.gen(function*() {
  const crashes = yield* Queue.unbounded<void>()
  const shards = yield* ShardScript
  const leader = ClusterMedium.singletonChild({
    name: 'orders/leader',
    run: (ready) =>
      Effect.gen(function*() {
        yield* readyAfter('150 millis', ready)
        return yield* Effect.never
      }),
  })
  const worker = ClusterMedium.singletonChild({
    name: 'orders/worker',
    run: (ready) =>
      Effect.gen(function*() {
        yield* ready
        yield* Queue.take(crashes)
        return yield* Effect.die('crashed')
      }),
  })
  const handle = yield* Supervisor.make('backoff-tree').pipe(
    Supervisor.strategy('one_for_all'),
    Supervisor.intensity(3, 60_000),
    Supervisor.backoff({ baseMillis: 100, multiplier: 1, capMillis: 100 }),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('leader', leader, { startTimeoutMillis: 2_000 }),
      Supervisor.ChildSpecs.on(ClusterMedium.port)('worker', worker, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* shards.grant('orders/leader')
  yield* shards.grant('orders/worker')
  yield* Effect.sleep('300 millis')
  yield* Queue.offer(crashes, void 0)
  yield* Effect.sleep('500 millis')
  const statuses = (yield* statusesOf(handle)).slice().sort((left, right) => left[0] < right[0] ? -1 : 1)
  const labels = yield* Effect.map(Ref.get(collector.trace), (entries) => Arr.map(entries, eventLabel))
  return {
    statuses,
    acquisitions: countOf(labels, 'acquired:leader'),
    terminated: countOf(labels, 'terminated'),
  }
})

const ownedAtRegistrationStillAnnouncesStandby = Effect.gen(function*() {
  const { medium } = yield* ClusterMedium.port
  const probe = ClusterMedium.singletonChild({
    name: 'orders/probe',
    run: (ready) => Effect.andThen(ready, Effect.never),
  })
  const evidence = yield* medium.start(probe)
  const declaredStandby = evidence.activity?.initiallyStandby === true
  yield* evidence.ready
  yield* medium.stop(evidence, { _tag: 'Brutal' })
  const singleton = ClusterMedium.singletonChild({
    name: 'orders/owned',
    run: (ready) => Effect.andThen(ready, Effect.never),
  })
  const handle = yield* Supervisor.make('owned-tree').pipe(
    Supervisor.strategy('one_for_one'),
    Supervisor.intensity(3, 60_000),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('owned', singleton, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  yield* Effect.sleep('200 millis')
  const statuses = yield* statusesOf(handle)
  return { declaredStandby, statuses }
})

const dynamicStartWaitsForDeclaredReadiness = Effect.gen(function*() {
  const shards = yield* ShardScript
  const gate = ClusterMedium.singletonChild({
    name: 'orders/dyn-gate',
    run: (ready) => Effect.andThen(ready, Effect.never),
  })
  const handle = yield* Supervisor.make('dynamic-tree').pipe(
    Supervisor.strategy('one_for_one'),
    Supervisor.intensity(3, 60_000),
    Supervisor.dynamic({ ceiling: 2, restartType: 'temporary' }),
    Supervisor.children([
      Supervisor.ChildSpecs.on(ClusterMedium.port)('gate', gate, { startTimeoutMillis: 2_000 }),
    ]),
  ).scoped
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* Effect.sleep('50 millis')
  const reply = yield* Supervisor.startChild(handle, Supervisor.readyOnStart(Effect.never))
  const heldWhileStandby = yield* heldNames
  yield* Effect.sleep('50 millis')
  yield* shards.grant('orders/dyn-gate')
  yield* Effect.sleep('100 millis')
  const statuses = yield* statusesOf(handle)
  const heldAfterGrant = yield* heldNames
  return { reply, heldWhileStandby, statuses, heldAfterGrant }
})

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
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  return {
    handle,
    trace: collector.trace,
    runs,
    initialized,
    dependentSaw,
  } satisfies LifecycleState
})

const traceLabelsOf = (state: LifecycleState): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(Ref.get(state.trace), (entries) => Arr.map(entries, eventLabel))

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
  const collector = yield* traceCollector(handle)
  yield* collector.collect
  yield* Effect.sleep('400 millis')
  const standbyStatuses = yield* statusesOf(handle)
  const shards = yield* ShardScript
  yield* shards.grant('orders/hanging')
  yield* Effect.sleep('2 seconds')
  const afterTimeoutStatuses = yield* statusesOf(handle)
  const events = yield* Effect.map(Ref.get(collector.trace), timeoutEventsOf)
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

    scenario(
      'A re-acquired singleton is not killed by the deadline armed before its shard moved away',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('the singleton is promoted, handed off, and promoted again past the first deadline')(
          'observed',
          (s) => Effect.provide(reacquiredTimerIsNotKilled, s.environment),
        ),
        Then('the stale deadline missed nothing and the singleton is ready')((s, expect) =>
          expect(s.observed).toEqual({
            statuses: [['epoch', 0, 'ready']],
            terminated: 0,
            readyEvents: 2,
          })
        ),
      ),
    )

    scenario(
      'A singleton interrupted before it signals ready stays standby and its dependent never starts',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('the shard is revoked while the singleton still initializes')(
          'observed',
          (s) => Effect.provide(interruptedBeforeReadyStaysStandby, s.environment),
        ),
        Then('nothing was announced ready, nothing terminated, and no dependent started')((s, expect) =>
          expect(s.observed).toEqual({
            statuses: [['slow', 0, 'standby'], ['watchdog', 0, 'starting']],
            held: ['orders/slow'],
            slowReadyEvents: 0,
            watchdogStarts: 0,
            terminated: 0,
          })
        ),
      ),
    )

    scenario(
      'An independent one-for-one child restarts immediately while its standby singleton waits',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('the singleton hands off and the fiber sibling crashes')(
          'observed',
          (s) => Effect.provide(oneForOneRestartIsUngated, s.environment),
        ),
        Then('the sibling restarted at once, ungated by the standby singleton')((s, expect) =>
          expect(s.observed).toEqual({
            standbyStatuses: [['gate', 0, 'standby'], ['worker', 0, 'ready']],
            restartedStatuses: [['gate', 0, 'standby'], ['worker', 1, 'ready']],
            workerStarts: 2,
            terminated: 1,
          })
        ),
      ),
    )

    scenario(
      'A singleton whose shard is already local still announces standby and then acquires',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns every shard')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(true))),
        ),
        When('a singleton is supervised on that runner')(
          'observed',
          (s) => Effect.provide(ownedAtRegistrationStillAnnouncesStandby, s.environment),
        ),
        Then('the medium declares standby regardless of ownership, and the singleton is ready')(
          (s, expect) =>
            expect(s.observed).toEqual({
              declaredStandby: true,
              statuses: [['owned', 0, 'ready']],
            }),
        ),
      ),
    )

    scenario(
      'A singleton acquiring during a group backoff keeps its acquisition and timer',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('a group restart is backoff-pending while the singleton re-acquires')(
          'observed',
          (s) => Effect.provide(acquisitionDuringBackoffIsKept, s.environment),
        ),
        Then('the acquisition during backoff was kept and both children came back')((s, expect) =>
          expect(s.observed).toEqual({
            statuses: [['leader', 1, 'ready'], ['worker', 1, 'ready']],
            acquisitions: 2,
            terminated: 2,
          })
        ),
      ),
    )

    scenario(
      'A dynamic child waits for the declared standby singleton before it starts',
      Gherkin.Do.pipe(
        Given('a cluster runner that owns no shard yet')(
          'environment',
          () => Layer.build(Layer.merge(ClusterMedium.layer(), scriptedShardingOwning(false))),
        ),
        When('a dynamic child is requested while the singleton is standby and the shard then arrives')(
          'observed',
          (s) => Effect.provide(dynamicStartWaitsForDeclaredReadiness, s.environment),
        ),
        Then('the request was accepted but the child only ran once the singleton was ready')((s, expect) =>
          expect(s.observed).toEqual({
            reply: { outcome: 'accepted', childId: 'd0', generation: 0 },
            heldWhileStandby: ['orders/dyn-gate'],
            statuses: [['gate', 0, 'ready'], ['d0', 0, 'ready']],
            heldAfterGrant: ['orders/dyn-gate'],
          })
        ),
      ),
    )
  })
