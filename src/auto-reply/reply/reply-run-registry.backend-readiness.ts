import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyBackendHandle,
  type ReplyOperation,
} from "./reply-run-registry.contracts.js";
import {
  getAttachedBackend,
  replyRunState,
  type ReplyOperationBackendReadiness,
} from "./reply-run-registry.state.js";

// Publication and capture share one owner across transformed SDK module graphs.
const readinessByOperation = (replyRunState.backendReadinessByOperation ??= new WeakMap<
  ReplyOperation,
  ReplyOperationBackendReadiness
>());

function getReadiness(operation: ReplyOperation): ReplyOperationBackendReadiness {
  const existing = readinessByOperation.get(operation);
  if (existing) {
    return existing;
  }
  const ready = createDeferredCore<ReplyBackendHandle | undefined>();
  const state: ReplyOperationBackendReadiness = {
    promise: ready.promise,
    settled: false,
    closed: false,
    resolve(backend) {
      if (state.settled) {
        return;
      }
      state.settled = true;
      state.backend = backend;
      ready.resolve(backend);
    },
  };
  readinessByOperation.set(operation, state);
  return state;
}

export function publishReplyOperationBackend(
  operation: ReplyOperation,
  backend: ReplyBackendHandle,
): void {
  const state = getReadiness(operation);
  if (state.settled && state.backend !== backend) {
    state.closed = true;
  }
  state.resolve(backend);
}

export function closeReplyOperationBackendReadiness(
  operation: ReplyOperation,
  force = false,
): void {
  // Terminal freeze must remain closed even if no input captured startup yet.
  // Ordinary pre-capture lane adoption still permits a fresh capture at its destination.
  const state =
    readinessByOperation.get(operation) ?? (force ? getReadiness(operation) : undefined);
  if (!state) {
    return;
  }
  state.closed = true;
  state.resolve();
}

/** Capture the original owner before FIFO admission can outlive provider startup. */
export function captureReplyOperationBackendReadiness(operation: ReplyOperation) {
  const key = operation.key;
  const sessionId = operation.sessionId;
  const sourceTurnId = replyRunState.sourceTurnByKey.get(key);
  const state = getReadiness(operation);
  const isCurrent = () =>
    !state.closed &&
    !operation.result &&
    !operation.abortSignal.aborted &&
    operation.key === key &&
    operation.sessionId === sessionId &&
    replyRunState.activeRunsByKey.get(key) === operation &&
    replyRunState.sourceTurnByKey.get(key) === sourceTurnId;
  return {
    isCurrent,
    isBackendCurrent: (backend: ReplyBackendHandle) =>
      isCurrent() && getAttachedBackend(operation) === backend,
    async wait(signal?: AbortSignal, timeoutMs = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS) {
      signal?.throwIfAborted();
      if (!isCurrent()) {
        return undefined;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      });
      try {
        const backend = await racePromiseWithAbortSignal(
          Promise.race([state.promise, timeout]),
          signal,
        );
        signal?.throwIfAborted();
        return backend && isCurrent() && getAttachedBackend(operation) === backend
          ? backend
          : undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
