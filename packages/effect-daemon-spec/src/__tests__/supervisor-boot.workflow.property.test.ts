import { it } from '@systemfsoftware/vitest'
import { Array as Arr, Match, Result, Schema } from 'effect'
import { absurd } from 'effect/Function'
import {
  interpretSupervisionEvent,
  type SupervisionDecision,
  SupervisionStep,
} from '../kernel/interpret-supervision-event.workflow.js'
import { EventTime } from '../kernel/SupervisionLimits.schema.js'
import type { StartChild, SupervisorCommands } from '../kernel/SupervisorCommand.schema.js'
import { ChildDeclaration, SupervisionPolicy } from '../kernel/SupervisorPolicy.schema.js'
import type { RestartStrategy, ShutdownMode } from '../kernel/SupervisorPolicy.schema.js'
import { initialStateOf, Running } from '../kernel/SupervisorState.schema.js'

type Decide = typeof interpretSupervisionEvent

const noCommands: SupervisorCommands = { stops: [], starts: [], arms: [], replies: [], terminates: [] }

const shutdownBrutal: ShutdownMode = { _tag: 'Brutal' }

const policyOf = (
  strategy: RestartStrategy,
  declarations: ReadonlyArray<ChildDeclaration>,
): SupervisionPolicy => ({
  strategy,
  intensity: 8,
  periodMillis: 100,
  autoShutdown: 'never',
  coolDown: { _tag: 'NoCoolDown' },
  backoff: { baseMillis: 0, multiplier: 2, capMillis: 0 },
  dynamic: { _tag: 'NoDynamicChildren' },
  livenessTickMillis: 10,
  childDeclarations: declarations,
})

const decodableChildOf = (drawn: ChildDeclaration): ChildDeclaration => ({
  childId: drawn.childId,
  restartType: drawn.restartType,
  shutdown: shutdownBrutal,
  significant: false,
  startTimeoutMillis: 50,
  probeFailureThreshold: 2,
})

const declarationsOf = (drawn: ReadonlyArray<ChildDeclaration>): ReadonlyArray<ChildDeclaration> =>
  Arr.map(drawn, decodableChildOf)

const idsOf = (drawn: ReadonlyArray<ChildDeclaration>): ReadonlyArray<string> =>
  Arr.map(drawn, (child) => child.childId)

const bootsTo = (
  decide: Decide,
  policy: SupervisionPolicy,
  at: EventTime,
): SupervisionDecision =>
  Result.match(
    decide(
      new SupervisionStep({
        state: new Running({ core: initialStateOf(policy) }),
        event: { _tag: 'SupervisorStarted', at },
      }),
    ),
    { onFailure: (error: never): never => absurd(error), onSuccess: (decision) => decision },
  )

const bootCommandsOf = (
  decide: Decide,
  policy: SupervisionPolicy,
  at: EventTime,
): SupervisorCommands =>
  Match.value(bootsTo(decide, policy, at)).pipe(
    Match.tag('StartChildren', (started) => started.commands),
    Match.orElse(() => noCommands),
  )

const startIdOf = (start: StartChild): string => start.childId

const awaitingIdOf = (start: { readonly childId: string }): string => start.childId

it.prop(
  '∀b_BootStart_=FirstAndQueueRest',
  { of: [Schema.Array(ChildDeclaration), EventTime], subject: interpretSupervisionEvent },
  (subject, [drawn, at]) => {
    const ids = idsOf(drawn)
    if (Arr.dedupe(ids).length !== ids.length) return true
    const decision = bootsTo(subject, policyOf('one_for_one', declarationsOf(drawn)), at)
    return Match.value(decision).pipe(
      Match.tag(
        'StartChildren',
        (started) =>
          Arr.join(Arr.map(started.commands.starts, startIdOf), '|') === Arr.join(Arr.take(ids, 1), '|') &&
          Arr.join(Arr.map(started.core.awaiting, awaitingIdOf), '|') === Arr.join(Arr.drop(ids, 1), '|') &&
          started.commands.stops.length === 0 &&
          started.commands.replies.length === 0 &&
          started.commands.terminates.length === 0,
      ),
      Match.orElse(() => false),
    )
  },
)

it.prop(
  '∀b_BootArm_=StartDeadline',
  { of: [Schema.Array(ChildDeclaration), EventTime], subject: interpretSupervisionEvent },
  (subject, [drawn, at]) => {
    const ids = idsOf(drawn)
    if (Arr.dedupe(ids).length !== ids.length) return true
    const commands = bootCommandsOf(subject, policyOf('rest_for_one', declarationsOf(drawn)), at)
    const deadlineHolds = (arm: (typeof commands.arms)[number]): boolean =>
      Match.value(arm).pipe(
        Match.tag('ArmChildTimer', (timer) => timer.kind === 'start_deadline' && timer.deadline === at + 50),
        Match.tag('ArmSupervisorTimer', () => false),
        Match.exhaustive,
      )
    return commands.arms.length === Arr.length(Arr.take(ids, 1)) && Arr.every(commands.arms, deadlineHolds)
  },
)

it.prop(
  '∀b_BootSeed_=Starting',
  { of: [Schema.Array(ChildDeclaration)], subject: initialStateOf },
  (subject, [drawn]) => {
    const ids = idsOf(drawn)
    if (Arr.dedupe(ids).length !== ids.length) return true
    const core = subject(policyOf('one_for_all', declarationsOf(drawn)))
    return Arr.join(Arr.map(core.children, (child) => child.childId), '|') === Arr.join(ids, '|') &&
      Arr.every(core.children, (child) => child.status === 'starting' && child.generation === 0) &&
      core.restartStamps.length === 0 &&
      core.nextOrdinal === 0
  },
)
