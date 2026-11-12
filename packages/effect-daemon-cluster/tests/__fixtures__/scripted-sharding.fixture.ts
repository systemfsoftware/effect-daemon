/**
 * A scripted sharding: the `Sharding.Sharding` port double the cluster medium's conformance
 * checks drive the real medium and its conformance driver through.
 *
 * It models what `registerSingleton` documents — a name is registered for the caller's scope, a
 * second registration of a held name defects, the registered program runs while this runner owns
 * the name's shard, and releasing that scope interrupts the program and frees the name — and
 * nothing else. A scenario grants or revokes a name's shard through the `ShardScript`, and the
 * double starts or interrupts the run as `Sharding` does when a shard moves. Every other member
 * defects, naming the part of sharding the double does not model, so a check that reaches one
 * fails loudly instead of reading a made-up answer.
 */
import { Array as Arr, Context, Data, Effect, Fiber, Layer, MutableHashMap, Option, Ref, Stream } from 'effect'
import { ShardId, Sharding } from 'effect/cluster'
import type * as Scope from 'effect/Scope'

/** A singleton name the run registered and never released. */
export class RegistrationLeftHeld extends Data.TaggedError('RegistrationLeftHeld')<{
  readonly names: ReadonlyArray<string>
}> {}

export class ChildReportedOtherThanShutdown extends Data.TaggedError('ChildReportedOtherThanShutdown')<{
  readonly observed: string
}> {}

export class RunningChildAnsweredDead extends Data.TaggedError('RunningChildAnsweredDead')<{}> {}

export class ChildNotReportedAsInferredDeath extends Data.TaggedError('ChildNotReportedAsInferredDeath')<{
  readonly observed: string
}> {}

/** What the scripted sharding held, readable after a run without holding the run's environment. */
export class RegistrationLedger extends Context.Service<
  RegistrationLedger,
  {
    readonly held: Effect.Effect<ReadonlyArray<string>>
  }
>()('@systemfsoftware/effect-daemon-cluster/tests/cluster-medium.conformance.test/RegistrationLedger') {}

/** The release probe: no name the run registered is still held. */
export const nothingLeftRegistered: Effect.Effect<void, RegistrationLeftHeld, RegistrationLedger> = Effect.flatMap(
  Effect.service(RegistrationLedger),
  (ledger) =>
    Effect.flatMap(
      ledger.held,
      (names) => names.length === 0 ? Effect.void : Effect.fail(new RegistrationLeftHeld({ names })),
    ),
)

export class ShardScript extends Context.Service<
  ShardScript,
  {
    readonly grant: (name: string) => Effect.Effect<void>
    readonly revoke: (name: string) => Effect.Effect<void>
  }
>()('@systemfsoftware/effect-daemon-cluster/tests/cluster-medium.conformance.test/ShardScript') {}

const unmodelled = (member: string): Effect.Effect<never> =>
  Effect.die(new globalThis.Error(`the scripted sharding does not model ${member}`))

const holding = (
  held: Ref.Ref<ReadonlyArray<string>>,
  name: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      const added = yield* Ref.modify(held, (names) =>
        Arr.contains(names, name) ? [false, names] as const : [true, [...names, name]] as const)
      if (!added) {
        return yield* Effect.die(`Singleton '${name}' is already registered`)
      }
    }),
    () =>
      Ref.update(held, (names) => Arr.filter(names, (registered) => registered !== name)),
  )

interface Registration {
  readonly start: Effect.Effect<Fiber.Fiber<void>>
  running: Option.Option<Fiber.Fiber<void>>
}

export const scriptedShardingOwning = (
  ownedAtStart: boolean,
): Layer.Layer<Sharding.Sharding | RegistrationLedger | ShardScript> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const held = yield* Ref.make<ReadonlyArray<string>>([])
      const shardNames: Array<string> = []
      const owned = MutableHashMap.empty<string, boolean>()
      const registrations = MutableHashMap.empty<string, Registration>()
      const shardNumberOf = (name: string): number => {
        const known = shardNames.indexOf(name)
        return known === -1 ? shardNames.push(name) : known + 1
      }
      const isOwned = (name: string): boolean => Option.getOrElse(MutableHashMap.get(owned, name), () => ownedAtStart)
      const idle = (name: string): Option.Option<Registration> =>
        Option.filter(MutableHashMap.get(registrations, name), (registration) => Option.isNone(registration.running))
      const startIfOwned = (name: string): Effect.Effect<void> =>
        Effect.suspend(() =>
          Option.match(Option.filter(idle(name), () => isOwned(name)), {
            onNone: () => Effect.void,
            onSome: (registration) =>
              Effect.map(registration.start, (fiber) => {
                registration.running = Option.some(fiber)
              }),
          })
        )
      const stopRunning = (name: string): Effect.Effect<void> =>
        Effect.suspend(() =>
          Option.match(MutableHashMap.get(registrations, name), {
            onNone: () => Effect.void,
            onSome: (registration) => {
              const running = registration.running
              registration.running = Option.none()
              return Option.match(running, { onNone: () => Effect.void, onSome: Fiber.interrupt })
            },
          })
        )
      const registered = <E, R>(name: string, run: Effect.Effect<void, E, R>) =>
        Effect.gen(function*() {
          yield* holding(held, name)
          const scope = yield* Effect.scope
          const context = yield* Effect.context<R>()
          MutableHashMap.set(registrations, name, {
            start: Effect.forkIn(Effect.orDie(Effect.provideContext(run, context)), scope),
            running: Option.none(),
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(registrations, name)))
          yield* startIfOwned(name)
        })
      return Layer.mergeAll(
        Layer.succeed(
          Sharding.Sharding,
          Sharding.Sharding.of({
            getRegistrationEvents: Stream.empty,
            getShardId: (entityId, group) => ShardId.make(group, shardNumberOf(entityId)),
            hasShardId: (shardId) => {
              const name = shardNames[shardId.id - 1]
              return name !== undefined && isOwned(name)
            },
            getSnowflake: unmodelled('snowflake generation'),
            isShutdown: Effect.succeed(false),
            makeClient: () => unmodelled('entity clients'),
            registerEntity: () => unmodelled('entity registration'),
            registerSingleton: (name, run) => registered(name, run),
            send: () => unmodelled('message routing'),
            sendOutgoing: () => unmodelled('outgoing messages'),
            notify: () => unmodelled('message notification'),
            reset: () => Effect.succeed(false),
            pollStorage: Effect.void,
            activeEntityCount: Effect.succeed(0),
          }),
        ),
        Layer.succeed(RegistrationLedger, {
          held: Ref.get(held),
        }),
        Layer.succeed(ShardScript, {
          grant: (name) => Effect.andThen(Effect.sync(() => MutableHashMap.set(owned, name, true)), startIfOwned(name)),
          revoke: (name) =>
            Effect.andThen(Effect.sync(() => MutableHashMap.set(owned, name, false)), stopRunning(name)),
        }),
      )
    }),
  )

export const scriptedSharding: Layer.Layer<Sharding.Sharding | RegistrationLedger | ShardScript> =
  scriptedShardingOwning(true)
