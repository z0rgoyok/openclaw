import { AsyncLocalStorage } from "node:async_hooks";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import type { CliBackendMessageInjection } from "../../plugins/cli-backend.types.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";

/** One host turn owns native admission, canonical input commitment, and FIFO dispatch. */
export function createCliPluginMessageInjection(params: {
  assertCurrent: () => void;
  abortSignal: AbortSignal;
  sessionId?: string;
  cwd: string;
  onDispatched?: () => void;
  activeToolCount?: () => number;
}) {
  type Registration = {
    sink: CliBackendMessageInjection;
    closed: Deferred;
  };
  let registration: Registration | undefined;
  let closed = false;
  let dispatchTail = Promise.resolve();
  const receiptWaits = new Set<() => void>();
  const refreshReceiptWaits = () => {
    for (const refresh of receiptWaits) {
      refresh();
    }
  };
  const closeRegistration = (owner: Registration) => {
    if (registration === owner) {
      registration = undefined;
    }
    owner.closed.resolve();
  };
  const close = () => {
    closed = true;
    if (registration) {
      closeRegistration(registration);
    }
    params.abortSignal.removeEventListener("abort", close);
  };
  params.abortSignal.addEventListener("abort", close, { once: true });
  if (params.abortSignal.aborted) {
    close();
  }
  const assertActive = () => {
    params.assertCurrent();
    params.abortSignal.throwIfAborted();
    if (closed) {
      throw new Error("CLI message injection turn is closed.");
    }
  };
  const registerMessageInjection = (sink: CliBackendMessageInjection) => {
    assertActive();
    if (registration) {
      throw new Error("CLI message injection already has a native owner.");
    }
    const owner: Registration = {
      sink: AsyncLocalStorage.bind(sink),
      closed: createDeferredCore(),
    };
    registration = owner;
    return () => closeRegistration(owner);
  };
  // Inbound callers carry another turn's async scope. Canonical CLI appends
  // retain the exact active account writer captured by the execution host.
  const persistInputInHostContext = AsyncLocalStorage.bind(persistInput);
  const messageInjectionV2: ReplyBackendMessageInjectionV2 = {
    version: 2,
    isAvailable: () => {
      try {
        assertActive();
        return registration !== undefined;
      } catch {
        return false;
      }
    },
    queueMessage(text, options, assertSourceCurrent) {
      const owner = registration;
      const predecessor = dispatchTail;
      const dispatchedOrRejected = createDeferredCore();
      dispatchTail = dispatchedOrRejected.promise;
      let admissionOpen = true;
      let receiptExpired = false;
      const assertCurrent = () => {
        assertSourceCurrent();
        assertActive();
        options?.abortSignal?.throwIfAborted();
        if (receiptExpired) {
          throw new Error("CLI native message injection receipt timed out.");
        }
        if (!admissionOpen || !owner || registration !== owner) {
          throw new Error("CLI message injection native owner is no longer current.");
        }
      };
      return (async (): Promise<void | ReplyBackendQueueMessageResult> => {
        let dispatched = false;
        const cancelled = createDeferredCore();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remainingMs = resolvePositiveTimerTimeoutMs(options?.deliveryTimeoutMs ?? 120_000, 1);
        let countingSince: number | undefined;
        const refreshReceiptWait = () => {
          if ((params.activeToolCount?.() ?? 0) > 0) {
            if (countingSince !== undefined) {
              remainingMs -= Math.max(0, Date.now() - countingSince);
              countingSince = undefined;
              clearTimeout(timer);
              timer = undefined;
            }
          } else if (countingSince === undefined && !receiptExpired) {
            countingSince = Date.now();
            timer = setTimeout(
              () => {
                receiptExpired = true;
                cancelled.resolve();
              },
              Math.max(0, remainingMs),
            );
            timer.unref?.();
          }
        };
        const onAbort = () => cancelled.resolve();
        options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          await predecessor;
          assertCurrent();
          if (!owner) {
            throw new Error("CLI message injection has no native owner.");
          }
          if (hasPromptImageInput(options)) {
            throw new Error("CLI native message injection supports text input only.");
          }
          const committedText = await persistInputInHostContext(text, options);
          assertCurrent();
          // A current parsed tool can keep native input queued until its result.
          // Count only tool-free receipt time; the run/tool watchdog still bounds work.
          receiptWaits.add(refreshReceiptWait);
          refreshReceiptWait();
          const receipt = owner.sink({
            text: committedText,
            assertCurrent,
            onDispatched: () => {
              assertCurrent();
              if (!dispatched) {
                dispatched = true;
                params.onDispatched?.();
                options?.userTurnTranscriptRecorder?.markSentToProvider?.();
                dispatchedOrRejected.resolve();
                options?.onQueueAccepted?.(true);
              }
            },
          });
          await Promise.race([
            receipt,
            owner.closed.promise.then(() => {
              throw new Error("CLI native message injection closed before its receipt.");
            }),
            cancelled.promise.then(() => {
              throw new Error(
                receiptExpired
                  ? "CLI native message injection receipt timed out."
                  : "CLI native message injection was cancelled before its receipt.",
              );
            }),
          ]);
          if (!dispatched) {
            throw new Error("CLI native message injection did not report dispatch.");
          }
        } catch (error) {
          if (dispatched) {
            return { transcriptCommit: "unconfirmed", errorMessage: String(error) };
          }
          options?.onQueueAccepted?.(false);
          throw error;
        } finally {
          admissionOpen = false;
          clearTimeout(timer);
          receiptWaits.delete(refreshReceiptWait);
          dispatchedOrRejected.resolve();
          options?.abortSignal?.removeEventListener("abort", onAbort);
        }
      })();
    },
  };
  async function persistInput(text: string, options: ReplyBackendQueueMessageOptions | undefined) {
    const recorder = options?.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("CLI steering input requires a canonical transcript recorder.");
    }
    const originalContent = JSON.stringify((await recorder.resolveMessage())?.content);
    const persisted = await recorder.persistApproved({
      cwd: params.cwd,
      ...(params.sessionId ? { expectedSessionId: params.sessionId } : {}),
    });
    if (recorder.isBlocked() || !recorder.hasPersisted()) {
      throw new Error("CLI steering input was not committed to its canonical transcript.");
    }
    const committed = recorder.getPersistedMessage?.() ?? persisted?.message;
    if (!committed) {
      throw new Error("CLI steering input has no committed message.");
    }
    if (JSON.stringify(committed.content) === originalContent) {
      // The host envelope adds attribution to unchanged authored content.
      return text;
    }
    if (typeof committed.content !== "string") {
      recorder.markBlocked();
      throw new Error("CLI steering write hook produced unsupported non-text input.");
    }
    // A write-hook redaction must replace every copy of the original prompt.
    return committed.content;
  }
  return { messageInjectionV2, registerMessageInjection, refreshReceiptWaits, close };
}
