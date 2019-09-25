import * as most from "@most/core";
import { newDefaultScheduler } from "@most/scheduler";
import { Action, ActionTypeMap, from } from "@neezer/action";
import { ofType } from "@neezer/action-combinators";
import nanoid from "nanoid";
import { Bus, IMakeBus, MakeSimpleEmit } from ".";
import { Emit } from "./update";

type CorrelationId = string;
type HandlerId = string;

interface IBaseInjects {
  emit: Emit<Action>;
  emitError: Emit<Error>;
}

type Injects<T = {}> = IBaseInjects & T;

export type MatchingActionMap = Record<CorrelationId, ActionTypeMap>;

export type Handler<T = {}> = (
  prevAction: Action,
  bus: Bus,
  injects: Injects<T>
) => Promise<void>;

export interface IHandler<T = {}> {
  types: string[];
  handler: Handler<T>;
}

type Accumulator = (
  seed: MatchingActionMap,
  action: Action
) => most.SeedValue<MatchingActionMap, ActionTypeMap | undefined>;

export function bind<T = {}>(
  makeBus: IMakeBus,
  handlers: IHandler[],
  inject: T
) {
  const { stream, emitError } = makeBus;

  function handleTypes(params: IHandler<T>) {
    const { types, handler } = params;
    const ofTypes = most.mergeArray(types.map(type => ofType(type, stream)));
    const numTypes = types.length;
    const handlerId = nanoid();

    const accumulator: Accumulator = (seed, action) => {
      const latestSeed = scrubOutdatedSeedKeys(seed);
      const noop = { seed: latestSeed, value: undefined };
      const correlationId = action.meta.correlationId;

      if (correlationId === undefined) {
        return noop;
      }

      const matchingSeedKey = findMatchingSeedKey(
        latestSeed,
        correlationId,
        handlerId
      );

      const newSeedKey = makeSeedKey(correlationId, handlerId);
      const matchingTypes = latestSeed[matchingSeedKey || ""];
      const numMatching = Object.keys(matchingTypes || {}).length;
      const isComplete = numMatching + 1 === numTypes;

      if (matchingSeedKey === undefined && !isComplete) {
        return {
          seed: {
            ...latestSeed,
            [newSeedKey]: { [action.type]: action }
          },
          value: undefined
        };
      }

      const updatedCorrelated = { ...matchingTypes, [action.type]: action };

      if (isComplete) {
        const { [matchingSeedKey as string]: _, ...newSeed } = latestSeed;

        return {
          seed: newSeed,
          value: updatedCorrelated
        };
      }

      return {
        seed: {
          ...omit([matchingSeedKey as string], latestSeed),
          [newSeedKey]: updatedCorrelated
        },
        value: undefined
      };
    };

    const sources = most.loop<
      Action,
      ActionTypeMap | undefined,
      MatchingActionMap
    >(accumulator, {}, ofTypes);

    const effects = most.map(async (actionsMap: ActionTypeMap | undefined) => {
      if (actionsMap === undefined) {
        return Promise.resolve();
      } else {
        const action = from(actionsMap);
        const { prefixes, emit } = makeBus;

        const bus: Bus = Object.keys(prefixes).reduce((memo, key) => {
          const fn = prefixes[key] as MakeSimpleEmit;

          return { ...memo, [key]: fn(action) };
        }, {});

        await handler(action, bus, { emit, emitError, ...inject });
      }
    }, sources);

    const recover = (error: Error) => {
      emitError(error);

      return most.awaitPromises(effects);
    };

    most.runEffects(
      most.recoverWith(recover, most.awaitPromises(effects)),
      newDefaultScheduler()
    );
  }

  handlers.forEach(({ types, handler }) => {
    handleTypes({ types, handler });
  });
}

function findMatchingSeedKey(
  seed: MatchingActionMap,
  correlationId: CorrelationId,
  handlerId: HandlerId
) {
  const keys = Object.keys(seed);

  return keys.find(key => {
    const {
      correlationId: seedCorrelationId,
      handlerId: seedHandlerId
    } = dissectSeedKey(key);

    return seedHandlerId === handlerId && seedCorrelationId === correlationId;
  });
}

function makeSeedKey(correlationId: CorrelationId, handlerId: HandlerId) {
  return `${correlationId},${handlerId},${Date.now()}`;
}

function isSeedKeyExpired(seedKey: string) {
  const now = Date.now();
  const { timestamp } = dissectSeedKey(seedKey);

  return now - timestamp > 10000; // TODO extract to config
}

function dissectSeedKey(seedKey: string) {
  const parts = seedKey.split(",");

  return {
    correlationId: parts[0],
    handlerId: parts[1],
    timestamp: Number(parts[2])
  };
}

function scrubOutdatedSeedKeys(seed: MatchingActionMap): MatchingActionMap {
  const keys = Object.keys(seed);
  const outdatedKeys = keys.filter(isSeedKeyExpired);

  return omit(outdatedKeys, seed);
}

function omit(keys: string[], obj: Record<string, any>) {
  return keys.reduce((memo, key) => omitKey(key, memo), obj);
}

function omitKey(key: string, obj: Record<string, any>) {
  const { [key]: _, ...rest } = obj;

  return rest;
}
