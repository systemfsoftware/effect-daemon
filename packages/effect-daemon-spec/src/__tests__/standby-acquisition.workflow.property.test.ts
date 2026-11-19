import { it } from '@systemfsoftware/vitest'
import { Array as Arr, Match, Result } from 'effect'
import { absurd } from 'effect/Function'
import { evolveSupervisor, SupervisionEvolution } from '../kernel/evolve-supervisor.workflow.js'
import {
  interpretSupervisionEvent,
  type SupervisionDecision,
  SupervisionStep,
} from '../kernel/interpret-supervision-event.workflow.js'
import type { SupervisionEvent } from '../kernel/SupervisionEvent.schema.js'
import { EventTime, Generation } from '../kernel/SupervisionLimits.schema.js'
import type { SupervisorArm } from '../kernel/SupervisorCommand.schema.js'
import { SupervisionPolicy } from '../kernel/SupervisorPolicy.schema.js'
import type { RestartType } from '../kernel/SupervisorPolicy.schema.js'
import type { ChildInstance, SupervisorCore } from '../kernel/SupervisorState.schema.js'
import { Restarting, Running } from '../kernel/SupervisorState.schema.js'
import type { SupervisorState } from '../kernel/SupervisorState.schema.js'
import type { TerminationReason } from '../kernel/TerminationReport.schema.js'

type Interpret = typeof interpretSupervisionEvent

const PERIOD_MILLIS = 100
const START_TIMEOUT_MILLIS = 50
const LIVENESS_TICK_MILLIS = 10

const policyWith = (
  strategy: 'one_for_one' | 'rest_for_one' | 'one_for_all',
  childDeclarations: ReadonlyArray<{
    readonly childId: string
    readonly restartType: RestartType
  }>,
): SupervisionPolicy => ({
  strategy,
  intensity: 8,
  periodMillis: PERIOD_MILLIS,
  autoShutdown: 'never',
  coolDown: { _tag: 'NoCoolDown' },
  backoff: { baseMillis: 0, multiplier: 2, capMillis: 0 },
  dynamic: { _tag: 'NoDynamicChildren' },
  livenessTickMillis: LIVENESS_TICK_MILLIS,
  childDeclarations: Arr.map(childDeclarations, (child) => ({
    childId: child.childId,
    restartType: child.restartType,
    shutdown: { _tag: 'Brutal' } as const,
    significant: false,
    startTimeoutMillis: START_TIMEOUT_MILLIS,
    probeFailureThreshold: 2,
  })),
})

const childOf = (
  childId: string,
  generation: Generation,
  status: ChildInstance['status'],
  epoch = 0,
): ChildInstance => ({
  childId,
  generation,
  status,
  epoch,
  consecutiveRestarts: 0,
  probeFailures: 0,
})

const coreWith = (
  policy: SupervisionPolicy,
  children: ReadonlyArray<ChildInstance>,
  awaiting: ReadonlyArray<{ readonly childId: string; readonly generation: Generation }>,
): SupervisorCore => ({ policy, children, restartStamps: [], nextOrdinal: 0, awaiting })

const runningOf = (core: SupervisorCore): SupervisorState => new Running({ core })

const decidedOf = (interpret: Interpret, step: SupervisionStep): SupervisionDecision =>
  Result.match(interpret(step), {
    onFailure: (error: never): never => absurd(error),
    onSuccess: (decision) => decision,
  })

const stepOf = (state: SupervisorState, event: SupervisionEvent): SupervisionStep =>
  new SupervisionStep({ state, event })

const startDeadlineTimerOf = (
  childId: string,
  generation: Generation,
  epoch: number,
  at: EventTime,
): SupervisionEvent => ({
  _tag: 'TimerElapsed',
  at,
  kind: 'start_deadline',
  target: { _tag: 'ChildTimer', childId, generation, epoch },
})

const acquiredEventOf = (childId: string, generation: Generation, at: EventTime): SupervisionEvent => ({
  _tag: 'ChildAcquired',
  at,
  childId,
  generation,
})

const releasedEventOf = (childId: string, generation: Generation, at: EventTime): SupervisionEvent => ({
  _tag: 'ChildReleased',
  at,
  childId,
  generation,
})

const readyEventOf = (childId: string, generation: Generation, at: EventTime): SupervisionEvent => ({
  _tag: 'ChildReady',
  at,
  childId,
  generation,
})

const terminatedEventOf = (
  childId: string,
  generation: Generation,
  at: EventTime,
  reason: TerminationReason,
): SupervisionEvent => ({ _tag: 'ChildTerminated', at, childId, generation, reason })

const abnormalOf = (cause: string): TerminationReason => ({
  _tag: 'Abnormal',
  report: { _tag: 'CauseReport', cause },
})

const isStale = (decision: SupervisionDecision): boolean =>
  Match.value(decision).pipe(
    Match.tag('Stale', () => true),
    Match.orElse(() => false),
  )

const statusOf = (decision: SupervisionDecision, childId: string): string | null =>
  Match.value(decision).pipe(
    Match.tag('Continue', ({ core }) =>
      Match.value(Arr.findFirst(core.children, (child) =>
        child.childId === childId)).pipe(
          Match.tag('Some', ({ value }) => value.status),
          Match.tag('None', () => null),
          Match.exhaustive,
        )),
    Match.orElse(() =>
      null
    ),
  )

const epochOf = (decision: SupervisionDecision, childId: string): number | null =>
  Match.value(decision).pipe(
    Match.tag('Continue', ({ core }) =>
      Match.value(Arr.findFirst(core.children, (child) =>
        child.childId === childId)).pipe(
          Match.tag('Some', ({ value }) => value.epoch),
          Match.tag('None', () => null),
          Match.exhaustive,
        )),
    Match.orElse(() =>
      null
    ),
  )

const startedIdsOf = (decision: SupervisionDecision): ReadonlyArray<string> =>
  Match.value(decision).pipe(
    Match.tag('Continue', ({ commands }) => Arr.map(commands.starts, (start) => start.childId)),
    Match.tag('StartChildren', ({ commands }) => Arr.map(commands.starts, (start) => start.childId)),
    Match.orElse((): ReadonlyArray<string> => []),
  )

const isStartDeadlineFor = (arm: SupervisorArm, childId: string, epoch: number, at: EventTime): boolean =>
  Match.value(arm).pipe(
    Match.tag(
      'ArmChildTimer',
      (timer) =>
        timer.kind === 'start_deadline' && timer.childId === childId && timer.epoch === epoch &&
        timer.deadline === at + START_TIMEOUT_MILLIS,
    ),
    Match.orElse(() => false),
  )

const armedDeadlineFor = (decision: SupervisionDecision, childId: string, epoch: number, at: EventTime): boolean =>
  Match.value(decision).pipe(
    Match.tag(
      'Continue',
      ({ commands }) => Arr.some(commands.arms, (arm) => isStartDeadlineFor(arm, childId, epoch, at)),
    ),
    Match.orElse(() => false),
  )

it.prop(
  '∀s_StandbyDeadline_=Stale',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'standby')], []))
    return isStale(decidedOf(subject, stepOf(state, startDeadlineTimerOf('c0', generation, 0, at))))
  },
)

it.prop(
  '∀a_Acquired_=StartingWithEpochDeadline',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'standby')], []))
    const decision = decidedOf(subject, stepOf(state, acquiredEventOf('c0', generation, at)))
    return statusOf(decision, 'c0') === 'starting' && epochOf(decision, 'c0') === 1 &&
      armedDeadlineFor(decision, 'c0', 1, at)
  },
)

it.prop(
  '∀r_Released_=StandbyWithoutTermination',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'ready')], []))
    const decision = decidedOf(subject, stepOf(state, releasedEventOf('c0', generation, at)))
    return Match.value(decision).pipe(
      Match.tag(
        'Continue',
        ({ commands }) =>
          statusOf(decision, 'c0') === 'standby' && commands.stops.length === 0 && commands.starts.length === 0 &&
          commands.terminates.length === 0,
      ),
      Match.orElse(() => false),
    )
  },
)

it.prop(
  '∀r_ReadyWhileStandby_=Held',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'standby')], []))
    const decision = decidedOf(subject, stepOf(state, readyEventOf('c0', generation, at)))
    return statusOf(decision, 'c0') === 'standby' && isStale(decision) === false
  },
)

it.prop(
  '∀p_AcquiredInRestarting_=KeepsPending',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('one_for_all', [
      { childId: 'c0', restartType: 'permanent' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const core = coreWith(policy, [
      childOf('c0', generation, 'standby'),
      childOf('c1', generation, 'starting'),
    ], [])
    const state = new Restarting({ core, pending: [{ childId: 'c1', generation: generation + 1 }] })
    const decision = decidedOf(subject, stepOf(state, acquiredEventOf('c0', generation, at)))
    return Result.match(
      evolveSupervisor(new SupervisionEvolution({ state, decision })),
      {
        onFailure: () => false,
        onSuccess: (evolved) =>
          Match.value(evolved).pipe(
            Match.tag('Restarting', (restarting) =>
              restarting.pending.length === 1 &&
              Match.value(Arr.findFirst(restarting.core.children, (child) => child.childId === 'c0')).pipe(
                Match.tag('Some', ({ value }) => value.status === 'starting' && value.epoch === 1),
                Match.tag('None', () => false),
                Match.exhaustive,
              )),
            Match.orElse(() => false),
          ),
      },
    )
  },
)

it.prop(
  '∀e_StaleEpochDeadline_=Stale',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('one_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'starting', 2)], []))
    return isStale(decidedOf(subject, stepOf(state, startDeadlineTimerOf('c0', generation, 1, at))))
  },
)

it.prop(
  '∀e_CurrentEpochDeadline_=Missed',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('one_for_one', [{ childId: 'c0', restartType: 'permanent' }])
    const state = runningOf(coreWith(policy, [childOf('c0', generation, 'starting', 2)], []))
    const decision = decidedOf(subject, stepOf(state, startDeadlineTimerOf('c0', generation, 2, at)))
    return isStale(decision) === false &&
      Arr.some(startedIdsOf(decision), (childId) => childId === 'c0')
  },
)

it.prop(
  '∀o_OneForOneRestart_=Ungated',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('one_for_one', [
      { childId: 'c0', restartType: 'permanent' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const state = runningOf(coreWith(policy, [
      childOf('c0', generation, 'standby'),
      childOf('c1', generation, 'ready'),
    ], []))
    const decision = decidedOf(
      subject,
      stepOf(state, terminatedEventOf('c1', generation, at, abnormalOf('boom'))),
    )
    return Arr.contains(startedIdsOf(decision), 'c1')
  },
)

it.prop(
  '∀q_AcquisitionBlocksAwaiting_=NoStart',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [
      { childId: 'c0', restartType: 'permanent' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const state = runningOf(coreWith(policy, [
      childOf('c0', generation, 'standby'),
      childOf('c1', generation, 'starting'),
    ], [{ childId: 'c1', generation }]))
    const acquired = decidedOf(subject, stepOf(state, acquiredEventOf('c0', generation, at)))
    return statusOf(acquired, 'c0') === 'starting' && Arr.contains(startedIdsOf(acquired), 'c1') === false
  },
)

it.prop(
  '∀q_ReadinessDrainsAwaiting_=StartNext',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [
      { childId: 'c0', restartType: 'permanent' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const state = runningOf(coreWith(policy, [
      childOf('c0', generation, 'starting', 1),
      childOf('c1', generation, 'starting'),
    ], [{ childId: 'c1', generation }]))
    const readied = decidedOf(subject, stepOf(state, readyEventOf('c0', generation, at)))
    return statusOf(readied, 'c0') === 'ready' && Arr.contains(startedIdsOf(readied), 'c1') &&
      armedDeadlineFor(readied, 'c1', 0, at)
  },
)

it.prop(
  '∀q_RemovedPredecessor_=UnblocksAwaiting',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [
      { childId: 'c0', restartType: 'temporary' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const state = runningOf(coreWith(policy, [
      childOf('c0', generation, 'ready'),
      childOf('c1', generation, 'starting'),
    ], [{ childId: 'c1', generation }]))
    const terminated = decidedOf(
      subject,
      stepOf(state, terminatedEventOf('c0', generation, at, { _tag: 'Normal' })),
    )
    return Arr.contains(startedIdsOf(terminated), 'c1')
  },
)

it.prop(
  '∀d_DeadEntry_=PrunedOnDrain',
  { of: [EventTime, Generation], subject: interpretSupervisionEvent },
  (subject, [at, generation]) => {
    const policy = policyWith('rest_for_one', [
      { childId: 'c0', restartType: 'permanent' },
      { childId: 'c1', restartType: 'permanent' },
    ])
    const state = runningOf(coreWith(policy, [
      childOf('c0', generation, 'starting'),
      childOf('c1', generation, 'starting'),
    ], [{ childId: 'gone', generation: 5 }, { childId: 'c1', generation }]))
    const readied = decidedOf(subject, stepOf(state, readyEventOf('c0', generation, at)))
    return Match.value(readied).pipe(
      Match.tag('Continue', ({ core }) => Arr.contains(startedIdsOf(readied), 'c1') && core.awaiting.length === 0),
      Match.orElse(() => false),
    )
  },
)
