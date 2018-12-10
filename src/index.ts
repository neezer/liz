import { Stream } from "@most/types";
import { Action, make as makeAction, next } from "@neezer/action";
import * as combinators from "@neezer/action-combinators";
import EventEmitter from "eventemitter3";
import { Emit, fromUpdate } from "./update";

export { bind, Handler, IHandler } from "./bind";
export { Action, makeAction, Emit, combinators };

type PrefixValue = string;
type DefaultCheckin = string;

export type Prefix = [PrefixValue, DefaultCheckin?];
export type ActionStream = Stream<Action>;
export type Combinator = (stream: ActionStream) => ActionStream;
export type On = (type: string, combinator: Combinator) => void;

export type SimpleEmit = (
  type: string,
  payload?: any,
  checkin?: string
) => void;

export type MakeSimpleEmit = (action: Action, appId?: string) => SimpleEmit;
export type Bus = Record<string, SimpleEmit>;

export interface IMakeBus {
  emit: Emit;
  stream: ActionStream;
  prefixes: Record<string, MakeSimpleEmit>;
}

export function makeUpdater<T>() {
  const emitter = new EventEmitter();

  return fromUpdate<T>(emitter);
}

export function make(emitDerivativePrefixes: Prefix[]): IMakeBus {
  const { stream, emit } = makeUpdater<Action>();

  const boundEmits = emitDerivativePrefixes.reduce(
    (memo, [prefix, defaultCheckin]) => {
      const prefixFn = (type: string) => `${prefix}.${type}`;

      return {
        ...memo,
        [prefix]: makeEmitDerivative({ emit, prefixFn, defaultCheckin })
      };
    },
    {}
  );

  return { emit, stream, prefixes: boundEmits };
}

interface IMakeEmitDerivative {
  emit: Emit;
  prefixFn: (prefix: string) => string;
  defaultCheckin?: string;
}

function makeEmitDerivative(props: IMakeEmitDerivative): MakeSimpleEmit {
  const { emit, prefixFn, defaultCheckin } = props;

  return (prevAction: Action, appId?: string) => {
    return (type: string, payload?: any, checkin?: string) => {
      if (checkin === undefined) {
        checkin = defaultCheckin;
      }

      // TODO allow passing in checkin message
      const nextAction = next(prevAction, prefixFn(type), payload, appId);

      emit(nextAction);
    };
  };
}
