import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { clearSessionQueues, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { isFollowupRunAborted } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

afterEach(() => vi.restoreAllMocks());

it("consumes hook-blocked steering without followup replay or aborting its target", async () => {
  const key = "agent:main:blocked-native-steer";
  const run = createQueueTestRun({
    prompt: "suppressed clarification",
    messageId: "blocked-steer",
  });
  run.run.sessionKey = key;
  run.run.agentId = "main";
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: run.prompt },
    target: () => undefined,
  });
  run.userTurnTranscriptRecorder = recorder;
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  operation.setPhase("running");
  const cancel = vi.fn();
  const followup = vi.fn(async () => {});
  operation.attachBackend({
    kind: "cli",
    runId: "original-native-turn",
    toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
    cancel,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async () => {
        // The producer records a terminal write-hook decision before reporting rejection.
        recorder.markBlocked();
        throw new Error("Canonical input suppressed by its write hook.");
      },
    },
  });
  const typing = createMockTypingController();
  try {
    await expect(
      runActiveReplySteer({
        followupRun: run,
        opts: undefined,
        providedReplyOperation: operation,
        queueKey: key,
        releaseAdmissionTicket: () => {},
        replyOperationRunState: {},
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        restartRecoverySourceTurnId: run.messageId,
        runFollowup: followup,
        sessionCtx: {},
        sessionKey: key,
        touchActiveSessionEntry: async () => {},
        typing,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
        toolAuthorityFingerprint: operation.toolAuthorityFingerprint!,
      }),
    ).resolves.toBe("handled");
    expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(followup).not.toHaveBeenCalled();
  } finally {
    clearSessionQueues([key]);
    operation.complete();
  }
});

it.each(
  (["ready", "starting"] as const).flatMap((phase) =>
    (["required", "optional"] as const).map((expectation) => ({ phase, expectation })),
  ),
)(
  "steers the $expectation input into the original $phase backend exactly once",
  async ({ phase, expectation }) => {
    const key = `agent:main:startup-steer-${phase}-${expectation}`;
    const run = createQueueTestRun({
      prompt: "use the revised requirements",
      messageId: "new-input",
    });
    run.run.sessionKey = key;
    run.run.agentId = "main";
    run.run.terminalReplyExpectation = expectation;
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    // Production prepares policy before the running phase and provider startup.
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
    operation.setPhase("running");
    replyRunRegistry.bindSourceTurnId(operation, "original-input");
    const adopted = vi.fn();
    run.turnAdoptionLifecycle = { onAdopted: adopted };
    const cancel = vi.fn();
    const sinkEntered = createDeferred();
    const queueMessage = vi.fn(
      async (_text: string, _options: unknown, assertCurrent: () => void) => {
        assertCurrent();
        sinkEntered.resolve();
      },
    );
    const backend = {
      kind: "embedded" as const,
      runId: "original-native-turn",
      terminalReplyExpectation: expectation,
      toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
      cancel,
      messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage },
    };
    if (phase === "ready") {
      operation.attachBackend(backend);
    }
    const captured = createDeferred();
    const resolveTarget =
      replyRunRegistry.resolveCurrentMessageInjectionTarget.bind(replyRunRegistry);
    vi.spyOn(replyRunRegistry, "resolveCurrentMessageInjectionTarget").mockImplementation(
      (sessionKey) => {
        const target = resolveTarget(sessionKey);
        if (sessionKey === key) {
          captured.resolve();
        }
        return target;
      },
    );
    const state: ReplyOperationRunState = {};
    const typing = createMockTypingController();
    const followup = vi.fn(async () => {});
    const releaseTicket = vi.fn();
    const incoming = runActiveReplySteer({
      followupRun: run,
      opts: undefined,
      providedReplyOperation: operation,
      queueKey: key,
      releaseAdmissionTicket: releaseTicket,
      replyOperationRunState: state,
      resolvedQueue: { mode: "steer", debounceMs: 0 },
      restartRecoverySourceTurnId: run.messageId,
      runFollowup: followup,
      sessionCtx: {},
      sessionKey: key,
      touchActiveSessionEntry: async () => {},
      typing,
      typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      toolAuthorityFingerprint: operation.toolAuthorityFingerprint!,
    });
    try {
      await Promise.race([
        captured.promise,
        incoming.then(() => {
          throw new Error("Steering completed before target capture");
        }),
      ]);
      expect(replyRunRegistry.get(key)).toBe(operation);
      if (phase === "starting") {
        operation.attachBackend(backend);
      }
      const outcome = await Promise.race([
        sinkEntered.promise.then(() => "steered" as const),
        incoming.then(() => "followup" as const),
      ]);
      expect(outcome).toBe("steered");
      await expect(incoming).resolves.toBe("handled");
      expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(queueMessage).toHaveBeenCalledExactlyOnceWith(
        run.prompt,
        expect.anything(),
        expect.any(Function),
        phase === "starting" ? "source-bound" : "run",
      );
      expect(replyRunRegistry.getSourceTurnId(key)).toBe("original-input");
      expect(replyRunRegistry.get(key)).toBe(operation);
      expect(operation.result).toBeNull();
      expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
      expect(followup).not.toHaveBeenCalled();
      expect(releaseTicket).toHaveBeenCalledOnce();
      expect(adopted).toHaveBeenCalledOnce();
    } finally {
      clearSessionQueues([key]);
      operation.complete();
      await incoming;
    }
  },
);

let startupIndex = 0;
function createPendingSteerFixture(knownAuthority = true) {
  const key = `agent:main:parked-startup-${++startupIndex}`;
  const run = createQueueTestRun({
    prompt: "first clarification",
    messageId: `clarification-${startupIndex}`,
  });
  run.run.agentId = "main";
  run.run.sessionKey = key;
  run.run.terminalReplyExpectation = "required";
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  if (knownAuthority) {
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  }
  operation.setPhase("running");
  const cancel = vi.fn();
  const executedFollowup = vi.fn();
  const pendingFollowups: Promise<void>[] = [];
  const followup = vi.fn((input: FollowupRun) => {
    const pending = (async () => {
      // Production followup execution waits for this operation's admission slot.
      // The cancellation path may call the same boundary for presentation cleanup.
      if (isFollowupRunAborted(input)) {
        return;
      }
      await operation.ownerSettlement;
      if (!isFollowupRunAborted(input)) {
        executedFollowup(input);
      }
    })();
    pendingFollowups.push(pending);
    return pending;
  });
  const queueMessage = vi.fn(
    async (_text: string, _options: unknown, assertCurrent: () => void) => {
      assertCurrent();
    },
  );
  const backend = {
    kind: "embedded" as const,
    runId: "original-backend",
    terminalReplyExpectation: "required" as const,
    toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
    cancel,
    messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage },
  };
  const start = (input = run) => {
    const deferred = createDeferred();
    const adopted = vi.fn();
    input.turnAdoptionLifecycle = {
      onDeferred: () => {
        deferred.resolve();
      },
      onAdopted: adopted,
    };
    const state: ReplyOperationRunState = {};
    const typing = createMockTypingController();
    const incoming = runActiveReplySteer({
      followupRun: input,
      opts: undefined,
      providedReplyOperation: operation,
      queueKey: key,
      releaseAdmissionTicket: () => {},
      replyOperationRunState: state,
      resolvedQueue: { mode: "steer", debounceMs: 0 },
      restartRecoverySourceTurnId: input.messageId,
      runFollowup: followup,
      sessionCtx: {},
      sessionKey: key,
      touchActiveSessionEntry: async () => {},
      typing,
      typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      toolAuthorityFingerprint: operation.toolAuthorityFingerprint!,
    });
    return { incoming, deferred, state, adopted };
  };
  const close = async () => {
    clearSessionQueues([key]);
    operation.complete();
    await Promise.allSettled(pendingFollowups);
  };
  return {
    key,
    run,
    operation,
    backend,
    queueMessage,
    cancel,
    followup,
    executedFollowup,
    start,
    close,
  };
}

it("keeps two startup clarifications in FIFO custody and consumes each once", async () => {
  const fixture = createPendingSteerFixture();
  const first = fixture.start();
  const secondRun = {
    ...fixture.run,
    run: { ...fixture.run.run },
    prompt: "second clarification",
    messageId: "second-input",
  };
  const second = fixture.start(secondRun);
  try {
    await Promise.all([first.deferred.promise, second.deferred.promise]);
    fixture.operation.attachBackend(fixture.backend);
    await Promise.all([first.incoming, second.incoming]);
    expect(fixture.queueMessage.mock.calls.map(([text]) => text)).toEqual([
      fixture.run.prompt,
      secondRun.prompt,
    ]);
    expect(first.adopted).toHaveBeenCalledOnce();
    expect(second.adopted).toHaveBeenCalledOnce();
    expect(first.state.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(second.state.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(getExistingFollowupQueue(fixture.key)?.items ?? []).toEqual([]);
    expect(fixture.followup).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
    await Promise.allSettled([first.incoming, second.incoming]);
  }
});

it("consumes an aborted startup candidate without aborting or steering its owner", async () => {
  const fixture = createPendingSteerFixture();
  const caller = new AbortController();
  fixture.run.abortSignal = caller.signal;
  const input = fixture.start();
  try {
    await input.deferred.promise;
    caller.abort();
    await input.incoming.catch(() => {});
    fixture.operation.attachBackend(fixture.backend);
    expect(getExistingFollowupQueue(fixture.key)?.items ?? []).toEqual([]);
    expect(input.adopted).not.toHaveBeenCalled();
    expect(fixture.queueMessage).not.toHaveBeenCalled();
    expect(fixture.executedFollowup).not.toHaveBeenCalled();
    expect(fixture.followup.mock.calls.every(([run]) => isFollowupRunAborted(run))).toBe(true);
    expect(fixture.operation.result).toBeNull();
    expect(fixture.cancel).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it("keeps a timed-out startup candidate in FIFO followups", async () => {
  vi.useFakeTimers();
  const fixture = createPendingSteerFixture();
  const input = fixture.start();
  try {
    await input.deferred.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(input.incoming).resolves.toBe("handled");
    expect(input.state.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(getExistingFollowupQueue(fixture.key)?.items).toEqual([fixture.run]);
    expect(input.adopted).not.toHaveBeenCalled();
    expect(fixture.queueMessage).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await fixture.close();
    vi.useRealTimers();
  }
});

it.each(["reply-policy", "unsupported"] as const)(
  "preserves FIFO fallback for a first backend with %s",
  async (reason) => {
    const fixture = createPendingSteerFixture();
    const input = fixture.start();
    try {
      await input.deferred.promise;
      fixture.operation.attachBackend(
        reason === "reply-policy"
          ? { ...fixture.backend, terminalReplyExpectation: "optional" }
          : { kind: "cli", runId: "unsupported-first", cancel: fixture.cancel },
      );
      await expect(input.incoming).resolves.toBe("handled");
      expect(input.state.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(getExistingFollowupQueue(fixture.key)?.items).toEqual([fixture.run]);
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(input.adopted).not.toHaveBeenCalled();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);

it("rejects a changed first backend at the final async preparation boundary", async () => {
  const fixture = createPendingSteerFixture();
  const preparationStarted = createDeferred();
  const releasePreparation = createDeferred();
  const acted = vi.fn();
  fixture.queueMessage.mockImplementation(async (_text, _options, assertCurrent) => {
    preparationStarted.resolve();
    await releasePreparation.promise;
    assertCurrent();
    acted();
  });
  const input = fixture.start();
  try {
    await input.deferred.promise;
    fixture.operation.attachBackend(fixture.backend);
    await preparationStarted.promise;
    const replacement = { ...fixture.backend, runId: "replacement-backend", cancel: vi.fn() };
    fixture.operation.attachBackend(replacement);
    releasePreparation.resolve();
    await expect(input.incoming).rejects.toThrow(
      "Original reply backend changed during steering admission",
    );
    expect(acted).not.toHaveBeenCalled();
    expect(input.adopted).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(fixture.key)?.items).toEqual([fixture.run]);
    expect(fixture.executedFollowup).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(replacement.cancel).not.toHaveBeenCalled();
  } finally {
    releasePreparation.resolve();
    await fixture.close();
  }
});

it("does not wait for startup when the original owner has unknown tool authority", async () => {
  const fixture = createPendingSteerFixture(false);
  const input = fixture.start();
  try {
    await expect(input.incoming).resolves.toBe("handled");
    expect(input.state.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(getExistingFollowupQueue(fixture.key)?.items).toEqual([fixture.run]);
    expect(input.adopted).not.toHaveBeenCalled();
    expect(fixture.queueMessage).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
