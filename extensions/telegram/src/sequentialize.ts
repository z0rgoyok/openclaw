import { getTelegramSpooledReplayLifecycle } from "./bot-processing-outcome.js";
import { getTelegramSequentialConstraints } from "./sequential-key.js";

export function createTelegramSequentializer() {
  const tails = new Map<string, Promise<void>>();
  return async (
    ctx: Parameters<typeof getTelegramSequentialConstraints>[0],
    next: () => Promise<void>,
  ): Promise<void> => {
    const constraints = getTelegramSequentialConstraints(ctx);
    const keys = Array.isArray(constraints) ? constraints : [constraints];
    const previous = keys.map((key) => tails.get(key)).filter((tail) => tail !== undefined);
    const signal = getTelegramSpooledReplayLifecycle()?.abortSignal;
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const cancelled = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Telegram replay aborted"),
            );
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    const stopWaitingForAbort = () => {
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const task = Promise.all(previous).then(() => {
      signal?.throwIfAborted();
      // Once entered, the handler owns cancellation and settlement. Releasing
      // its lane on abort could overlap write-capable work with a successor.
      stopWaitingForAbort();
      return next();
    });
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    // Reserve all keys before yielding, including keys whose previous work is still waiting.
    for (const key of keys) {
      tails.set(key, tail);
    }
    // A cancelled waiter still reserves the earlier work's ordering barrier;
    // remove its tail only once that barrier has drained, never at cancellation.
    void tail.then(() => {
      for (const key of keys) {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    });
    try {
      await (cancelled ? Promise.race([task, cancelled]) : task);
    } finally {
      stopWaitingForAbort();
    }
  };
}
