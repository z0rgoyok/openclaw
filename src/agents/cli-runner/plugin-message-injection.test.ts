import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  getCliHistoryWriter,
  runWithCliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import type { CliBackendMessageInjectionInput } from "../../plugins/cli-backend.types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { FailoverError } from "../failover-error.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";
import { createCliPluginMessageInjection } from "./plugin-message-injection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(() => closePluginTestAdmissions());
afterEach(() => vi.useRealTimers());
const owners: Array<ReturnType<typeof createCliPluginMessageInjection>> = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function createHost(assertCurrent = () => {}) {
  const target = await createTarget();
  const controller = new AbortController();
  const host = createCliPluginMessageInjection({
    assertCurrent,
    abortSignal: controller.signal,
    sessionId: "steer-session",
    cwd: "/tmp",
  });
  owners.push(host);
  const queue: typeof host.messageInjectionV2.queueMessage = (
    text,
    options,
    assertSourceCurrent,
    kind,
  ) =>
    host.messageInjectionV2.queueMessage(
      text,
      {
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({ input: { text }, target }),
        ...options,
      },
      assertSourceCurrent,
      kind,
    );
  return { ...host, controller, queue };
}

async function createTarget() {
  const root = tempDirs.make("openclaw-cli-steering-");
  const target = {
    agentId: "main",
    sessionId: "steer-session",
    sessionKey: "agent:main:steering",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    sessionEntry: { sessionId: "steer-session", updatedAt: Date.now() },
  };
  await upsertSessionEntry({ ...target, entry: target.sessionEntry });
  return target;
}

describe("CLI native steering admission", () => {
  it("retains the admitted CLI account writer for a correction from another async scope", async () => {
    const target = await createTarget();
    const writer = {
      target,
      runId: "active-cli",
      authFingerprint: "a".repeat(64),
      assertCurrent() {},
      assertReadable() {},
    };
    const controller = new AbortController();
    const host = runWithCliHistoryWriter(writer, () =>
      createCliPluginMessageInjection({
        assertCurrent() {},
        abortSignal: controller.signal,
        cwd: "/tmp",
        sessionId: target.sessionId,
      }),
    );
    owners.push(host);
    let ownerSeen = false;
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "clarification" },
      target,
      beforeMessageWrite: ({ message }) => {
        ownerSeen = getCliHistoryWriter(target) === writer;
        return message;
      },
    });
    host.registerMessageInjection(async (input) => {
      input.assertCurrent();
      input.onDispatched();
    });
    await host.messageInjectionV2.queueMessage(
      "clarification",
      { userTurnTranscriptRecorder: recorder },
      () => {},
      "run",
    );
    expect(ownerSeen).toBe(true);
    expect(recorder.hasPersisted()).toBe(true);
  });

  it.each([false, true])(
    "dispatches hook-rewritten content without the original envelope (mutate=%s)",
    async (mutate) => {
      const target = await createTarget();
      const host = await createHost();
      let nativeText = "";
      host.registerMessageInjection(async (input) => {
        input.assertCurrent();
        input.onDispatched();
        nativeText = input.text;
      });
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "original private words" },
        target,
        beforeMessageWrite: ({ message }) => {
          if (message.role !== "user") {
            return message;
          }
          if (mutate) {
            message.content = "redacted correction";
            return message;
          }
          return { ...message, content: "redacted correction" };
        },
      });
      await host.queue(
        "host envelope: original private words",
        { userTurnTranscriptRecorder: recorder },
        () => {},
        "run",
      );
      expect(nativeText).toBe("redacted correction");
      expect(recorder.getPersistedMessage?.()?.content).toBe("redacted correction");
    },
  );

  it("commits original inputs and dispatches them in FIFO while earlier receipts remain pending", async () => {
    const target = await createTarget();
    const host = await createHost();
    const waiting = createDeferred();
    const ready = createDeferred();
    const secondDispatched = createDeferred();
    const firstReceipt = createDeferred();
    const secondReceipt = createDeferred();
    const sent: string[] = [];
    host.registerMessageInjection(async (input) => {
      input.assertCurrent();
      input.onDispatched();
      sent.push(input.text);
      if (input.text === "first") {
        await firstReceipt.promise;
      } else {
        secondDispatched.resolve();
        await secondReceipt.promise;
      }
    });
    const first = createUserTurnTranscriptRecorder({
      input: { text: "first", idempotencyKey: "first" },
      target: async () => {
        waiting.resolve();
        await ready.promise;
        return target;
      },
    });
    const second = createUserTurnTranscriptRecorder({
      input: { text: "second", idempotencyKey: "second" },
      target,
    });
    const firstResult = host.queue("first", { userTurnTranscriptRecorder: first }, () => {}, "run");
    const secondResult = host.queue(
      "second",
      { userTurnTranscriptRecorder: second },
      () => {},
      "run",
    );
    await waiting.promise;
    expect(sent).toEqual([]);
    ready.resolve();
    await secondDispatched.promise;
    expect(sent).toEqual(["first", "second"]);
    const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
      typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
    );
    expect(messages).toMatchObject([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
    firstReceipt.resolve();
    secondReceipt.resolve();
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([undefined, undefined]);
  });

  it("keeps hook-suppressed input away from native transport", async () => {
    const target = await createTarget();
    const host = await createHost();
    const sink = vi.fn(async () => {});
    host.registerMessageInjection(sink);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "suppressed" },
      target,
      beforeMessageWrite: () => null,
    });
    await expect(
      host.queue("suppressed", { userTurnTranscriptRecorder: recorder }, () => {}, "run"),
    ).rejects.toThrow("not committed");
    expect(sink).not.toHaveBeenCalled();
    expect(recorder.hasPersisted()).toBe(false);
    expect(recorder.isBlocked()).toBe(true);
    await expect(recorder.persistFallback()).resolves.toBeUndefined();
  });

  it("keeps missing transcript targets retryable and rejects inputs without a recorder", async () => {
    const host = await createHost();
    const sink = vi.fn(async () => {});
    host.registerMessageInjection(sink);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "missing target" },
      target: () => undefined,
    });
    await expect(
      host.queue("missing target", { userTurnTranscriptRecorder: recorder }, () => {}, "run"),
    ).rejects.toThrow("not committed");
    expect(recorder.isBlocked()).toBe(false);
    await expect(
      host.messageInjectionV2.queueMessage("missing recorder", undefined, () => {}, "run"),
    ).rejects.toThrow("requires a canonical transcript recorder");
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects a rebound canonical session without labeling its input hook-blocked", async () => {
    const target = await createTarget();
    const host = await createHost();
    const sink = vi.fn(async () => {});
    host.registerMessageInjection(sink);
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: "replacement-session", updatedAt: Date.now() },
    });
    const recorder = createUserTurnTranscriptRecorder({ input: { text: "old session" }, target });
    await expect(
      host.queue("old session", { userTurnTranscriptRecorder: recorder }, () => {}, "run"),
    ).rejects.toThrow("not committed");
    expect(recorder.isBlocked()).toBe(false);
    expect(recorder.hasPersisted()).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("exposes plugin registration through the attached host backend and revokes it at cleanup", async () => {
    const target = await createTarget();
    const { context } = await createExecution();
    const operation = createReplyOperation({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      resetTriggered: false,
    });
    context.params.replyOperation = operation;
    context.params.sessionId = target.sessionId;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.taskSuggestionDeliveryMode = "gateway";
    const ready = createDeferred();
    const finish = createDeferred();
    const sent: string[] = [];
    let lateRegistration: (() => void) | undefined;
    const processRun = runPlugin(context, async function* (execution) {
      const register = execution.registerMessageInjection;
      if (!register) {
        throw new Error("Host did not expose native message injection registration.");
      }
      register(async (input) => {
        input.assertCurrent();
        input.onDispatched();
        sent.push(input.text);
      });
      lateRegistration = () => register(async () => {});
      ready.resolve();
      await finish.promise;
      yield SUCCESS_RESULT;
    });
    try {
      await ready.promise;
      const backend = getAttachedBackend(operation);
      expect(backend).toMatchObject({
        kind: "cli",
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: "gateway",
      });
      const injection = backend?.messageInjectionV2;
      if (!injection) {
        throw new Error("Host did not attach native message injection.");
      }
      await injection.queueMessage(
        "registered correction",
        {
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            input: { text: "registered correction" },
            target,
          }),
        },
        () => {},
        "run",
      );
      expect(sent).toEqual(["registered correction"]);
      finish.resolve();
      await processRun;
      expect(getAttachedBackend(operation)).toBeUndefined();
      expect(() => lateRegistration?.()).toThrow();
    } finally {
      finish.resolve();
      await processRun;
      operation.complete();
    }
  });

  it("rechecks source authority after asynchronous transcript preparation", async () => {
    const target = await createTarget();
    const host = await createHost();
    let sourceCurrent = true;
    const sink = vi.fn(async () => {});
    host.registerMessageInjection(sink);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "expired source" },
      target: () => {
        sourceCurrent = false;
        return target;
      },
    });
    await expect(
      host.queue(
        "expired source",
        { userTurnTranscriptRecorder: recorder },
        () => {
          if (!sourceCurrent) {
            throw new Error("Source closed");
          }
        },
        "source-bound",
      ),
    ).rejects.toThrow("Source closed");
    expect(sink).not.toHaveBeenCalled();
  });

  it("keeps accepted native input nonretryable when the child times out before producing stdout", async () => {
    const target = await createTarget();
    const recorder = createUserTurnTranscriptRecorder({ input: { text: "correction" }, target });
    await recorder.persistApproved();
    const { context } = await createExecution();
    const operation = createReplyOperation({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      resetTriggered: false,
    });
    context.params.replyOperation = operation;
    context.params.sessionId = target.sessionId;
    const dispatched = createDeferred();
    const finish = createDeferred();
    let timeout: FailoverError | undefined;
    vi.useFakeTimers();
    const processRun = runPlugin(
      context,
      async function* (execution) {
        execution.registerMessageInjection?.(async (input) => input.onDispatched());
        const injection = getAttachedBackend(operation)?.messageInjectionV2;
        if (!injection) {
          throw new Error("Missing host native injection capability.");
        }
        await injection.queueMessage(
          "correction",
          {
            userTurnTranscriptRecorder: recorder,
          },
          () => {},
          "run",
        );
        dispatched.resolve();
        await finish.promise;
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 10,
        onNoOutputTimeout: (error) => {
          timeout = error;
        },
      },
    );
    try {
      await dispatched.promise;
      await vi.advanceTimersByTimeAsync(10);
      finish.resolve();
      await expect(processRun).resolves.toMatchObject({ reason: "no-output-timeout" });
      expect(timeout).toMatchObject({ reason: "timeout", cliTimeout: { observedActivity: false } });
      expect(timeout?.code).toBeUndefined();
    } finally {
      finish.resolve();
      await processRun;
      operation.complete();
    }
  });

  it.each(["receipt failure", "unregister", "abort"])(
    "retains nonreplayable custody after dispatch and %s",
    async (failure) => {
      const host = await createHost();
      const dispatched = createDeferred();
      const receipt = createDeferred();
      const accepted = vi.fn();
      const unregister = host.registerMessageInjection(async (input) => {
        input.onDispatched();
        dispatched.resolve();
        await receipt.promise;
      });
      const result = host.queue("correction", { onQueueAccepted: accepted }, () => {}, "run");
      await dispatched.promise;
      if (failure === "receipt failure") {
        receipt.reject(new Error("Native receipt lost"));
      } else if (failure === "unregister") {
        unregister();
      } else {
        host.controller.abort();
      }
      await expect(result).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      receipt.resolve();
    },
  );

  it("bounds receipt waits and revokes late callbacks after the delivery deadline", async () => {
    const target = await createTarget();
    const host = await createHost();
    const recorder = createUserTurnTranscriptRecorder({ input: { text: "deadline" }, target });
    await recorder.persistApproved();
    const dispatched = createDeferred();
    const receipt = createDeferred();
    let retained: CliBackendMessageInjectionInput | undefined;
    host.registerMessageInjection(async (input) => {
      retained = input;
      input.onDispatched();
      dispatched.resolve();
      await receipt.promise;
    });
    vi.useFakeTimers();
    const outcome = host.queue(
      "deadline",
      {
        userTurnTranscriptRecorder: recorder,
        deliveryTimeoutMs: 25,
      },
      () => {},
      "run",
    );
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(25);
    await expect(outcome).resolves.toMatchObject({
      transcriptCommit: "unconfirmed",
      errorMessage: expect.stringContaining("timed out"),
    });
    expect(() => retained?.assertCurrent()).toThrow("timed out");
    expect(vi.getTimerCount()).toBe(0);
    receipt.resolve();
  });

  it("revokes retained callbacks and preserves a replacement sink when old cleanup runs", async () => {
    const host = await createHost();
    let retained: CliBackendMessageInjectionInput | undefined;
    const unregister = host.registerMessageInjection(async (input) => {
      retained = input;
      input.onDispatched();
    });
    await host.queue("first", undefined, () => {}, "run");
    expect(() => retained?.assertCurrent()).toThrow("no longer current");
    unregister();
    host.registerMessageInjection(async (input) => input.onDispatched());
    unregister();
    await expect(host.queue("second", undefined, () => {}, "run")).resolves.toBeUndefined();
    host.close();
    expect(host.messageInjectionV2.isAvailable()).toBe(false);
    expect(() => host.registerMessageInjection(async () => {})).toThrow("closed");
  });

  it("rejects images before dispatch", async () => {
    const host = await createHost();
    const sink = vi.fn(async () => {});
    host.registerMessageInjection(sink);
    await expect(
      host.queue(
        "look",
        { images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
        () => {},
        "run",
      ),
    ).rejects.toThrow("text input only");
    expect(sink).not.toHaveBeenCalled();
  });
});
