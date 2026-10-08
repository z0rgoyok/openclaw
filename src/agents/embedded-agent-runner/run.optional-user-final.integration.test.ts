import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

// This fixture has no retained heartbeat context; the native store requires a main-thread host.
// Keep the user trigger and the registered harness/terminal/delivery boundary intact.
vi.mock("../../infra/heartbeat-outcome-store.js", () => ({
  claimHeartbeatContextForUserRun: vi.fn(async () => undefined),
}));

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let createReplyDispatcher: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher;
let buildEmbeddedRunPayloads: typeof import("./run/payloads.js").buildEmbeddedRunPayloads;

beforeAll(async () => {
  runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  ({ buildEmbeddedRunPayloads } =
    await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js"));
  ({ createReplyDispatcher } = await import("../../auto-reply/reply/reply-dispatcher.js"));
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  state = await createOpenClawTestState({ label: "optional-user-final" });
});
afterAll(async () => {
  await state?.cleanup();
});
beforeEach(() => {
  resetSharedRunIntegrationHarnessMocks();
  useOpenAIPlatformAuthFixture();
  mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
});

function finalAttempt(text: string) {
  const assistant = makeAssistantMessageFixture({
    provider: "openai",
    model: "gpt-5.4",
    api: "openai-responses",
    stopReason: "stop",
    content: [{ type: "text", text }],
  });
  return makeAttemptResult({
    assistantTexts: text ? [text] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

function runFinal(
  terminalReplyExpectation: "required" | "optional",
  overrides: Pick<Parameters<typeof runEmbeddedAgent>[0], "inputProvenance" | "lane"> = {},
) {
  return runEmbeddedAgent({
    ...createOverflowRunParams(state),
    provider: "openai",
    model: "gpt-5.4",
    trigger: "user",
    terminalReplyExpectation,
    ...overrides,
  });
}

describe("registered runEmbeddedAgent user final boundary", () => {
  it("recovers genuinely empty optional output into one visible final", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(finalAttempt(""))
      .mockResolvedValueOnce(finalAttempt("Recovered answer."));
    const result = await runFinal("optional");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0].prompt).toContain(
      "produce the visible answer now",
    );
    expect(result.payloads).toEqual([{ text: "Recovered answer.", replyToTag: false }]);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.terminalReplyKind).toBeUndefined();
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        return { visibleReplySent: true, messageId: "synthetic-final" };
      },
    });
    for (const payload of result.payloads ?? []) {
      expect(dispatcher.sendFinalReply(payload)).toBe(true);
    }
    await settleReplyDispatcher({ dispatcher });
    expect(delivered).toEqual([expect.objectContaining({ text: "Recovered answer." })]);
  });

  it("keeps optional explicit NO_REPLY silent without a second attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(finalAttempt(SILENT_REPLY_TOKEN));
    const result = await runFinal("optional");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
  });

  it.each([
    {
      label: "inter_session",
      overrides: { inputProvenance: { kind: "inter_session" } },
      expectedKind: "silent-empty",
    },
    {
      label: "internal_system",
      overrides: { inputProvenance: { kind: "internal_system" } },
      expectedKind: "silent-empty",
    },
    { label: "subagent", overrides: { lane: "subagent" }, expectedKind: undefined },
  ] as const)(
    "completes genuinely empty optional $label output without retry or error",
    async ({ overrides, expectedKind }) => {
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(finalAttempt(""))
        .mockResolvedValueOnce(finalAttempt("Unexpected retry."));
      const result = await runFinal("optional", overrides);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
      expect(result.meta.terminalReplyKind).toBe(expectedKind);
      expect(result.meta.error).toBeUndefined();
    },
  );

  it("recovers required NO_REPLY into a visible final", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(finalAttempt(SILENT_REPLY_TOKEN))
      .mockResolvedValueOnce(finalAttempt("Required answer."));
    const result = await runFinal("required");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toEqual([{ text: "Required answer.", replyToTag: false }]);
  });

  it("never replays a side-effecting empty turn", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        ...finalAttempt(""),
        toolMetas: [{ toolName: "write", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
    );
    const result = await runFinal("optional");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(result.meta.error).toMatchObject({ kind: "incomplete_turn", fallbackSafe: false });
    expect(result.payloads?.[0]?.text).toContain("some tool actions");
  });
});
