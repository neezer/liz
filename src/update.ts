import { multicast } from "@most/core";
import { currentTime } from "@most/scheduler";
import { Scheduler, Sink, Stream, Time } from "@most/types";
import EventEmitter from "eventemitter3";

export type Emit = <T>(value: T) => void;

export interface IUpdate<T> {
  emit: Emit;
  stream: Stream<T>;
}

class Update {
  private emitter: EventEmitter;
  private event: string;

  constructor(emitter: EventEmitter, event: string) {
    this.emitter = emitter;
    this.event = event;
  }

  public run<T>(sink: Sink<T>, scheduler: Scheduler) {
    const send = (value: T) => tryEvent(currentTime(scheduler), value, sink);

    const dispose = () => {
      this.emitter.removeListener(this.event, send);
    };

    this.emitter.on(this.event, send);

    return { dispose };
  }
}

function tryEvent<T>(t: Time, x: T, sink: Sink<T>) {
  try {
    sink.event(t, x);
  } catch (e) {
    sink.error(t, e);
  }
}

/**
 * Returns a stream bound to the given EventEmitter and a pre-bound emit
 * function. This emit function will only ever emit the event defined by the
 * `UPDATE` constant, pushing the new event onto the stream.
 *
 * We've multicasted the stream here too, since we'll be adding lots of
 * subscriptions down the road and we want to efficiently share this stream
 * among them.
 *
 * @param EventEmitter
 */
export function fromUpdate<T>(emitter: EventEmitter): IUpdate<T> {
  const emit = emitter.emit.bind(emitter, "update");
  const stream = new Update(emitter, "update");

  return { stream: multicast(stream), emit };
}
