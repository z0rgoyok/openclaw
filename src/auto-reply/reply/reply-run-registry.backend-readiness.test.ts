import { afterEach, expect, it, vi } from "vitest";
import { captureReplyOperationBackendReadiness } from "./reply-run-registry.backend-readiness.js";
import { createReplyOperation, forceClearReplyOperation } from "./reply-run-registry.js";

let index = 0;
function fixture() {
  const operation = createReplyOperation({
    sessionKey: `agent:main:backend-startup-${++index}`,
    sessionId: `backend-session-${index}`,
    resetTriggered: false,
  });
  const backend = {
    kind: "embedded" as const,
    runId: "first-backend",
    cancel: vi.fn(),
    queueMessage: vi.fn(async () => {}),
  };
  return { operation, backend };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["before-wait", "during-wait"] as const)(
  "observes the first attachment %s without polling",
  async (timing) => {
    const { operation, backend } = fixture();
    const captured = captureReplyOperationBackendReadiness(operation);
    try {
      if (timing === "before-wait") {
        operation.attachBackend(backend);
      }
      const ready = captured.wait();
      if (timing === "during-wait") {
        operation.attachBackend(backend);
      }
      await expect(ready).resolves.toBe(backend);
      expect(captured.isBackendCurrent(backend)).toBe(true);
    } finally {
      operation.complete();
    }
  },
);

it.each([
  "complete",
  "fail",
  "abort",
  "restart",
  "force-clear",
  "freeze",
  "session",
  "rekey",
] as const)("settles a pending attachment when its owner changes: %s", async (change) => {
  const { operation } = fixture();
  const captured = captureReplyOperationBackendReadiness(operation);
  const ready = captured.wait();
  try {
    if (change === "complete") {
      operation.complete();
    } else if (change === "fail") {
      operation.fail("run_failed");
    } else if (change === "abort") {
      operation.abortByUser();
    } else if (change === "restart") {
      operation.abortForRestart();
    } else if (change === "force-clear") {
      forceClearReplyOperation(operation);
    } else if (change === "freeze") {
      operation.freezeAbort();
    } else if (change === "session") {
      operation.updateSessionId("replacement-session");
    } else {
      operation.updateSessionKey(`agent:main:rekeyed-${index}`);
    }
    await expect(ready).resolves.toBeUndefined();
    expect(captured.isCurrent()).toBe(false);
  } finally {
    operation.complete();
  }
});

it.each(["replace", "detach", "freeze"] as const)(
  "revokes an already published first backend after %s",
  async (change) => {
    const { operation, backend } = fixture();
    const captured = captureReplyOperationBackendReadiness(operation);
    operation.attachBackend(backend);
    try {
      if (change === "replace") {
        operation.attachBackend({ ...backend, runId: "replacement-backend" });
      } else if (change === "detach") {
        operation.detachBackend(backend);
      } else {
        operation.freezeAbort();
      }
      // Restoring the same handle cannot revive a closed capture.
      operation.attachBackend(backend);
      await expect(captured.wait()).resolves.toBeUndefined();
      expect(captured.isBackendCurrent(backend)).toBe(false);
    } finally {
      operation.complete();
    }
  },
);

it("never gives a pending input to a same-key successor", async () => {
  const { operation, backend } = fixture();
  const key = operation.key;
  const captured = captureReplyOperationBackendReadiness(operation);
  const ready = captured.wait();
  operation.complete();
  const successor = createReplyOperation({
    sessionKey: key,
    sessionId: "new-session",
    resetTriggered: false,
  });
  try {
    successor.attachBackend(backend);
    await expect(ready).resolves.toBeUndefined();
    expect(captured.isBackendCurrent(backend)).toBe(false);
    expect(backend.queueMessage).not.toHaveBeenCalled();
    expect(backend.cancel).not.toHaveBeenCalled();
  } finally {
    successor.complete();
  }
});

it("cancels a caller's wait without cancelling its active owner or leaking a timer", async () => {
  vi.useFakeTimers();
  const { operation, backend } = fixture();
  const captured = captureReplyOperationBackendReadiness(operation);
  const caller = new AbortController();
  const ready = captured.wait(caller.signal);
  const rejected = expect(ready).rejects.toThrow();
  caller.abort();
  try {
    await rejected;
    expect(operation.result).toBeNull();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    operation.attachBackend(backend);
    await expect(captured.wait()).resolves.toBe(backend);
    expect(backend.cancel).not.toHaveBeenCalled();
  } finally {
    operation.complete();
  }
});

it("ends a missing-backend wait at the existing bounded budget", async () => {
  vi.useFakeTimers();
  const { operation, backend } = fixture();
  const captured = captureReplyOperationBackendReadiness(operation);
  const ready = captured.wait();
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(ready).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(operation.result).toBeNull();
    operation.attachBackend(backend);
    await expect(captured.wait()).resolves.toBe(backend);
    expect(backend.cancel).not.toHaveBeenCalled();
  } finally {
    operation.complete();
  }
});

it("cannot create fresh readiness after the owner commits its terminal outcome", async () => {
  const { operation, backend } = fixture();
  operation.freezeAbort();
  const captured = captureReplyOperationBackendReadiness(operation);
  try {
    expect(operation.result).toBeNull();
    operation.attachBackend(backend);
    await expect(captured.wait()).resolves.toBeUndefined();
    expect(captured.isBackendCurrent(backend)).toBe(false);
  } finally {
    operation.complete();
  }
});

it("shares the first publication across independently transformed module graphs", async () => {
  const { operation, backend } = fixture();
  const captured = captureReplyOperationBackendReadiness(operation);
  operation.attachBackend(backend);
  try {
    vi.resetModules();
    const otherGraph = await import("./reply-run-registry.backend-readiness.js");
    const otherCapture = otherGraph.captureReplyOperationBackendReadiness(operation);
    await expect(otherCapture.wait()).resolves.toBe(backend);
    expect(otherCapture.isBackendCurrent(backend)).toBe(true);
    await expect(captured.wait()).resolves.toBe(backend);
  } finally {
    operation.complete();
  }
});

it("shares terminal freeze before capture across module graphs", async () => {
  const { operation, backend } = fixture();
  operation.freezeAbort();
  try {
    vi.resetModules();
    const otherGraph = await import("./reply-run-registry.backend-readiness.js");
    const captured = otherGraph.captureReplyOperationBackendReadiness(operation);
    operation.attachBackend(backend);
    await expect(captured.wait()).resolves.toBeUndefined();
    expect(captured.isBackendCurrent(backend)).toBe(false);
  } finally {
    operation.complete();
  }
});

it.each(["rekey", "session"] as const)(
  "permits legitimate %s before the first startup capture",
  async (change) => {
    const { operation, backend } = fixture();
    if (change === "rekey") {
      operation.updateSessionKey(`agent:main:new-lane-${index}`);
    } else {
      operation.updateSessionId(`new-uuid-${index}`);
    }
    const captured = captureReplyOperationBackendReadiness(operation);
    try {
      operation.attachBackend(backend);
      await expect(captured.wait()).resolves.toBe(backend);
    } finally {
      operation.complete();
    }
  },
);
