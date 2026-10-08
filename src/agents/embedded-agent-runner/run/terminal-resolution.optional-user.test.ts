import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { emptyAssistant, makeTerminalInput } from "./terminal-resolution.test-support.js";

describe("optional user final recovery", () => {
  it.each([undefined, "user", "manual"] as const)(
    "recovers a genuinely empty final for trigger %s and then reports exhaustion",
    async (trigger) => {
      const input = makeTerminalInput({
        runParams: { trigger, terminalReplyExpectation: "optional" },
      });
      expect(await resolveEmbeddedRunTerminal(input)).toEqual({ action: "retry" });
      expect(input.retryState.emptyResponseAttempts).toBe(1);
      expect(input.activateInternalPrompt).toHaveBeenCalledOnce();
      const exhausted = await resolveEmbeddedRunTerminal(input);
      expect(exhausted).toMatchObject({
        action: "complete",
        result: {
          payloads: [{ isError: true, text: expect.stringContaining("couldn't generate") }],
          meta: { error: { kind: "incomplete_turn", fallbackSafe: true } },
        },
      });
      if (exhausted.action === "complete") {
        expect(exhausted.result.meta.terminalReplyKind).toBeUndefined();
      }
    },
  );

  it("preserves host-declared silence for detached background work", async () => {
    const input = makeTerminalInput({
      runParams: { silentExpected: true, terminalReplyExpectation: "optional" },
    });
    expect(await resolveEmbeddedRunTerminal(input)).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: SILENT_REPLY_TOKEN }],
        meta: { terminalReplyKind: "silent-empty" },
      },
    });
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "inter_session",
      runParams: { inputProvenance: { kind: "inter_session" } },
      expectedKind: "silent-empty",
    },
    {
      label: "internal_system",
      runParams: { inputProvenance: { kind: "internal_system" } },
      expectedKind: "silent-empty",
    },
    { label: "subagent", runParams: { lane: "subagent" }, expectedKind: undefined },
  ] as const)(
    "keeps genuinely empty optional $label turns silent",
    async ({ runParams, expectedKind }) => {
      const input = makeTerminalInput({
        runParams: {
          trigger: "user",
          terminalReplyExpectation: "optional",
          ...runParams,
        },
      });
      const resolved = await resolveEmbeddedRunTerminal(input);
      expect(resolved).toMatchObject({
        action: "complete",
        result: {
          payloads: [{ text: SILENT_REPLY_TOKEN }],
        },
      });
      if (resolved.action === "complete") {
        expect(resolved.result.meta.error).toBeUndefined();
        expect(resolved.result.meta.terminalReplyKind).toBe(expectedKind);
      }
      expect(input.activateInternalPrompt).not.toHaveBeenCalled();
      expect(input.activateCompactionContinuation).not.toHaveBeenCalled();
      expect(input.setSuppressNextUserMessagePersistence).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit optional NO_REPLY", async () => {
    const assistant = emptyAssistant({ content: [{ type: "text", text: SILENT_REPLY_TOKEN }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      currentAttemptAssistant: assistant,
      lastAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      runParams: { trigger: "user", terminalReplyExpectation: "optional" },
    });
    expect(await resolveEmbeddedRunTerminal(input)).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: SILENT_REPLY_TOKEN }],
        meta: { terminalReplyKind: "silent-empty" },
      },
    });
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it.each(["delivered", "pending"] as const)(
    "does not retry a final with source delivery %s",
    async (sourceReplyDeliveryState) => {
      const input = makeTerminalInput({
        attempt: makeEmbeddedRunnerAttempt({
          assistantTexts: [],
          currentAttemptAssistant: emptyAssistant(),
          sourceReplyDeliveryState,
        }),
        runParams: { trigger: "user", terminalReplyExpectation: "optional" },
      });
      expect(await resolveEmbeddedRunTerminal(input)).toMatchObject({ action: "complete" });
      expect(input.activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it("reports empty post-effect output without replaying completed actions", async () => {
    const input = makeTerminalInput({
      attempt: makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        currentAttemptAssistant: emptyAssistant(),
        toolMetas: [{ toolName: "write", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
      runParams: { trigger: "user", terminalReplyExpectation: "optional" },
    });
    expect(await resolveEmbeddedRunTerminal(input)).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ isError: true, text: expect.stringContaining("some tool actions") }],
        meta: { error: { kind: "incomplete_turn", fallbackSafe: false } },
      },
    });
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
    expect(input.activateCompactionContinuation).not.toHaveBeenCalled();
  });

  it("continues reasoning-only user output instead of marking it silent", async () => {
    const input = makeTerminalInput({
      attempt: makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        currentAttemptAssistant: emptyAssistant({
          content: [{ type: "thinking", thinking: "Checking the answer." }],
        }),
      }),
      runParams: { trigger: "user", terminalReplyExpectation: "optional" },
    });
    expect(await resolveEmbeddedRunTerminal(input)).toEqual({ action: "retry" });
    expect(input.retryState.reasoningOnlyAttempts).toBe(1);
    expect(input.retryState.emptyResponseAttempts).toBe(0);
  });

  it("continues a compacted user turn without replaying the original prompt", async () => {
    const input = makeTerminalInput({
      runParams: { trigger: "user", terminalReplyExpectation: "optional" },
      attemptCompactionCount: 1,
      maxEmptyResponseRetryAttempts: 0,
    });
    expect(await resolveEmbeddedRunTerminal(input)).toEqual({ action: "retry" });
    expect(input.activateCompactionContinuation).toHaveBeenCalledOnce();
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
  });
});
