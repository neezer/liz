import * as most from "@most/core";
import { newDefaultScheduler } from "@most/scheduler";
import { Action, ActionTypeMap, from } from "@neezer/action";
import { ofType } from "@neezer/action-combinators";
import { Bus, IMakeBus, MakeSimpleEmit } from ".";
import { Emit } from "./update";

type CorrelationId = string;

interface IInjects {
  emit: Emit<Action>;
  emitError: Emit<Error>;
  [name: string]: any;
}

export type MatchingActionMap = Record<CorrelationId, ActionTypeMap>;
export type Handler = (prevAction: Action, bus: Bus, injects: IInjects) => void;

export interface IHandler {
  types: string[];
  handler: Handler;
}

type Accumulator = (
  seed: MatchingActionMap,
  action: Action
) => most.SeedValue<MatchingActionMap, ActionTypeMap>;

export function bind(
  makeBus: IMakeBus,
  handlers: IHandler[],
  inject: Record<string, any> = {}
) {
  const { stream, emitError } = makeBus;

  function handleTypes(params: IHandler) {
    const { types, handler } = params;
    const ofTypes = most.mergeArray(types.map(type => ofType(type, stream)));
    const numTypes = types.length;

    const accumulator: Accumulator = (seed, action) => {
      const latestSeed = scrubOutdatedSeedKeys(seed);
      const noop = { seed: latestSeed, value: {} };
      const correlationId = action.meta.correlationId;

      if (correlationId === undefined) {
        return noop;
      }

      const matchingSeedKey = findMatchingSeedKey(latestSeed, correlationId);
      const newSeedKey = makeSeedKey(correlationId);
      const matchingTypes = latestSeed[matchingSeedKey || ""];
      const numMatching = Object.keys(matchingTypes || {}).length;
      const isComplete = numMatching + 1 === numTypes;

      if (matchingSeedKey === undefined && !isComplete) {
        return {
          seed: {
            ...latestSeed,
            [newSeedKey]: { [action.type]: action }
          },
          value: {}
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
        value: {}
      };
    };

    const sources = most.loop<Action, ActionTypeMap, MatchingActionMap>(
      accumulator,
      {},
      ofTypes
    );

    const effects = most.map(async (actionsMap: ActionTypeMap) => {
      const action = from(actionsMap);
      const { prefixes, emit } = makeBus;

      const bus: Bus = Object.keys(prefixes).reduce((memo, key) => {
        const fn = prefixes[key] as MakeSimpleEmit;

        return { ...memo, [key]: fn(action) };
      }, {});

      await handler(action, bus, { emit, emitError, ...inject });
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
  correlationId: CorrelationId
) {
  const keys = Object.keys(seed);

  return keys.find(key => {
    const { correlationId: seedCorrelationId } = dissectSeedKey(key);

    return seedCorrelationId === correlationId;
  });
}

function makeSeedKey(correlationId: CorrelationId) {
  return `${correlationId},${Date.now()}`;
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
    timestamp: Number(parts[1])
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
