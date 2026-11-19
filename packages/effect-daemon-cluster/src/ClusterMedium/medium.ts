import { Supervisor } from '@systemfsoftware/effect-daemon-spec'
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
} from 'effect'
import { Sharding } from 'effect/cluster'
import { absurd } from 'effect/Function'
import type { ClusterProgram, ClusterProgramRequirements, EntityChild, SingletonChild } from './ClusterProgram.js'

export type ClusterMediumRequirement = ClusterProgramRequirements

export const declaration: Supervisor.Medium.MediumDeclaration = {
  reporting: 'inferred',
  groupStop: 'eventual',
}

const LIVENESS_PROBE_MILLIS = 1_000

const ClusterStartedTypeId: unique symbol = Symbol.for('@systemfsoftware/effect-daemon-cluster/ClusterMedium/Started')
type ClusterStartedTypeId = typeof ClusterStartedTypeId

interface ClusterStarted extends Supervisor.Medium.Started {
  readonly [ClusterStartedTypeId]: ClusterStartedTypeId
  readonly registration: Scope.Closeable
  readonly ended: Deferred.Deferred<Supervisor.Medium.TerminationReason>
  readonly stopping: Ref.Ref<boolean>
  readonly probe: Effect.Effect<boolean, never, ClusterMediumRequirement>
  readonly activityQueue?: Queue.Queue<Supervisor.Medium.MediumActivity> | undefined
}

const activityExtras = (
  activity?: Supervisor.Medium.StartedActivity,
  activityQueue?: Queue.Queue<Supervisor.Medium.MediumActivity>,
): {
  readonly activity?: Supervisor.Medium.StartedActivity
  readonly activityQueue?: Queue.Queue<Supervisor.Medium.MediumActivity> | undefined
} => activity === undefined ? {} : { activity, activityQueue }

const clusterStarted = (
  ready: Effect.Effect<void>,
  registration: Scope.Closeable,
  ended: Deferred.Deferred<Supervisor.Medium.TerminationReason>,
  stopping: Ref.Ref<boolean>,
  probe: Effect.Effect<boolean, never, ClusterMediumRequirement>,
  activity?: Supervisor.Medium.StartedActivity,
  activityQueue?: Queue.Queue<Supervisor.Medium.MediumActivity>,
): ClusterStarted => ({
  ...Supervisor.Medium.started(ready),
  [ClusterStartedTypeId]: ClusterStartedTypeId,
  registration,
  ended,
  stopping,
  probe,
  ...activityExtras(activity, activityQueue),
})

const isClusterStarted = (evidence: Supervisor.Medium.Started): evidence is ClusterStarted =>
  ClusterStartedTypeId in evidence

const clusterOf = (evidence: Supervisor.Medium.Started): Option.Option<ClusterStarted> =>
  Option.liftPredicate(evidence, isClusterStarted)

const shutdownTermination: Supervisor.Medium.TerminationReason = { _tag: 'Shutdown' }
const normalTermination: Supervisor.Medium.TerminationReason = { _tag: 'Normal' }
const inferredDeath: Supervisor.Medium.TerminationReason = {
  _tag: 'Abnormal',
  report: { _tag: 'InferredReport', failedProbes: 1 },
}
const terminationOf = (stopping: boolean, exit: Exit.Exit<void, never>): Supervisor.Medium.TerminationReason =>
  Match.value(
    Result.match(Supervisor.classifyChildExit(new Supervisor.ClassifyChildExit({ stopping, exit })), {
      onFailure: (error: never): never => absurd(error),
      onSuccess: (decision) => decision,
    }),
  ).pipe(
    Match.tag('Normal', () => normalTermination),
    Match.tag('Shutdown', () => shutdownTermination),
    Match.tag('Abnormal', () => inferredDeath),
    Match.exhaustive,
  )

const lostItsShard = (stopping: boolean, exit: Exit.Exit<void, never>): boolean =>
  !stopping && Exit.match(exit, { onSuccess: () => false, onFailure: Cause.hasInterruptsOnly })

const reportedOnExit = (
  ended: Deferred.Deferred<Supervisor.Medium.TerminationReason>,
  stopping: Ref.Ref<boolean>,
) =>
(exit: Exit.Exit<void, never>): Effect.Effect<void> =>
  Effect.flatMap(
    Ref.get(stopping),
    (stopped) =>
      lostItsShard(stopped, exit) ? Effect.void : Effect.asVoid(Deferred.succeed(ended, terminationOf(stopped, exit))),
  )

const announceAcquire = (changes: Queue.Queue<Supervisor.Medium.MediumActivity>): Effect.Effect<void> =>
  Queue.offer(changes, { _tag: 'Acquired' }).pipe(Effect.asVoid)

const singletonReady = (
  signalled: Deferred.Deferred<void>,
  changes: Queue.Queue<Supervisor.Medium.MediumActivity>,
): Effect.Effect<void> =>
  Effect.flatMap(
    Deferred.isDone(signalled),
    (alreadySignalled) => alreadySignalled ? Effect.void : Effect.asVoid(Deferred.succeed(signalled, void 0)),
  ).pipe(
    Effect.andThen(Queue.offer(changes, { _tag: 'Ready' })),
    Effect.asVoid,
  )

const singletonRun = (
  program: SingletonChild<ClusterMediumRequirement>,
  signalled: Deferred.Deferred<void>,
  ended: Deferred.Deferred<Supervisor.Medium.TerminationReason>,
  stopping: Ref.Ref<boolean>,
  changes: Queue.Queue<Supervisor.Medium.MediumActivity>,
): Effect.Effect<void, never, ClusterMediumRequirement> =>
  Effect.gen(function*() {
    yield* announceAcquire(changes)
    yield* program.run(singletonReady(signalled, changes))
  }).pipe(
    Effect.onExit((exit) =>
      Effect.flatMap(Ref.get(stopping), (stopped) =>
        lostItsShard(stopped, exit)
          ? Effect.asVoid(Queue.offer(changes, { _tag: 'Released' }))
          : reportedOnExit(ended, stopping)(exit))
    ),
  )

const startSingleton = (
  program: SingletonChild<ClusterMediumRequirement>,
  shardGroup: string | undefined,
): Effect.Effect<ClusterStarted, never, ClusterMediumRequirement> =>
  Effect.gen(function*() {
    const evidenceScope = yield* Effect.scope
    const registration = yield* Scope.fork(evidenceScope)
    const signalled = yield* Deferred.make<void>()
    const ended = yield* Deferred.make<Supervisor.Medium.TerminationReason>()
    const stopping = yield* Ref.make(false)
    const sharding = yield* Sharding.Sharding
    const changes = yield* Queue.unbounded<Supervisor.Medium.MediumActivity>()
    const run = singletonRun(program, signalled, ended, stopping, changes)
    yield* sharding.registerSingleton(program.name, run, { shardGroup }).pipe(
      Effect.provideService(Scope.Scope, registration),
    )
    const probe = Deferred.isDone(ended).pipe(Effect.map((done) => done === false))
    return clusterStarted(
      Deferred.await(signalled),
      registration,
      ended,
      stopping,
      probe,
      { initiallyStandby: true, changes: Stream.fromQueue(changes) },
      changes,
    )
  })

const startEntity = (
  program: EntityChild<ClusterMediumRequirement>,
): Effect.Effect<ClusterStarted, never, ClusterMediumRequirement> =>
  Effect.gen(function*() {
    const evidenceScope = yield* Effect.scope
    const registration = yield* Scope.fork(evidenceScope)
    const signalled = yield* Deferred.make<void>()
    const ended = yield* Deferred.make<Supervisor.Medium.TerminationReason>()
    const stopping = yield* Ref.make(false)
    const watch = Effect.gen(function*() {
      const exit = yield* Effect.exit(program.register.pipe(Effect.provideService(Scope.Scope, registration)))
      yield* Exit.match(exit, {
        onSuccess: () => Effect.asVoid(Deferred.succeed(signalled, void 0)),
        onFailure: () => reportedOnExit(ended, stopping)(exit),
      })
      return yield* Effect.never
    })
    yield* Effect.forkIn(watch, evidenceScope)
    const probe = program.probe.pipe(
      Effect.timeoutOption(Duration.millis(LIVENESS_PROBE_MILLIS)),
      Effect.map((answered) => Option.getOrElse(answered, () => false)),
    )
    return clusterStarted(Deferred.await(signalled), registration, ended, stopping, probe)
  })

const startOf = (
  program: ClusterProgram,
  shardGroup: string | undefined,
): Effect.Effect<ClusterStarted, never, ClusterMediumRequirement> =>
  Match.value(program).pipe(
    Match.tag('Singleton', (child) => startSingleton(child, shardGroup)),
    Match.tag('Entity', (child) => startEntity(child)),
    Match.exhaustive,
  )

const reportOf = (evidence: Supervisor.Medium.Started) =>
  Option.match(clusterOf(evidence), {
    onNone: () => Effect.succeed(shutdownTermination),
    onSome: (self) => Deferred.await(self.ended),
  })

const probeOf = (
  evidence: Supervisor.Medium.Started,
): Effect.Effect<boolean, never, ClusterMediumRequirement> =>
  Option.match(clusterOf(evidence), {
    onNone: () => Effect.succeed(false),
    onSome: (self) => self.probe,
  })

const shutdownActivityOf = (self: ClusterStarted): Effect.Effect<void> =>
  self.activityQueue === undefined ? Effect.void : Queue.shutdown(self.activityQueue).pipe(Effect.ignore)

const stopOf = (
  evidence: Supervisor.Medium.Started,
): Effect.Effect<Supervisor.Medium.Stopped, never, ClusterMediumRequirement> =>
  Option.match(clusterOf(evidence), {
    onNone: () => Effect.succeed(Supervisor.Medium.stopped),
    onSome: (self) =>
      Ref.set(self.stopping, true).pipe(
        Effect.andThen(Scope.close(self.registration, Exit.void)),
        Effect.andThen(shutdownActivityOf(self)),
        Effect.andThen(Deferred.succeed(self.ended, shutdownTermination)),
        Effect.as(Supervisor.Medium.stopped),
      ),
  })

export interface ClusterMediumOptions {
  readonly shardGroup?: string | undefined
}

export const mediumFor = (
  options: ClusterMediumOptions,
): Supervisor.Medium.Medium<ClusterProgram, never, ClusterMediumRequirement> =>
  Supervisor.Medium.make<ClusterProgram, never, ClusterMediumRequirement>({
    declaration,
    start: (program) => startOf(program, options.shardGroup),
    report: reportOf,
    probe: probeOf,
    stop: stopOf,
  })

export type ClusterMediumPort = Supervisor.Medium.MediumPortShape<
  ClusterProgram,
  never,
  ClusterMediumRequirement
>

export const port = Supervisor.Medium.MediumPort<ClusterProgram, never, ClusterMediumRequirement>('ClusterMedium')

export const layer = (options?: ClusterMediumOptions): Layer.Layer<ClusterMediumPort> =>
  Layer.succeed(port, { medium: mediumFor(options ?? {}) })
