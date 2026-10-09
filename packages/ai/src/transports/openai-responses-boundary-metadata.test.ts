import { describe, expect, it } from "vitest";
import { classifyAssistantTurn } from "../../../../src/agents/embedded-agent-runner/run/incomplete-turn-classification.js";
import type { AssistantMessage, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createResponsesBoundaryMetadata } from "./openai-responses-boundary-metadata-internal.js";
import { convertResponsesMessages } from "./openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { decodeResponsesTextSignature } from "./openai-responses-text-signature-internal.js";

const model: Model<"openai-responses"> = {
  id: "synthetic",
  name: "Synthetic",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 512,
};
const output = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: createZeroUsage(),
  stopReason: "stop",
  timestamp: 0,
});
const message = (text: string, phase = "final_answer", channel?: string) => ({
  id: "msg_synthetic",
  type: "message",
  role: "assistant",
  status: "completed",
  phase,
  ...(channel ? { channel } : {}),
  content: [{ type: "output_text", text, annotations: [] }],
});
const terminal = (items: unknown[]) => ({
  type: "response.completed",
  response: {
    id: "resp_0123456789abcdef0123456789abcdef",
    status: "completed",
    output: items,
    usage: {
      input_tokens: 310,
      output_tokens: 8,
      total_tokens: 318,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
});
async function run(events: Record<string, unknown>[]) {
  const result = output();
  async function* stream() {
    yield* events;
  }
  await processResponsesStream(stream(), result, { push() {} }, model);
  return result;
}
const boundary = (result: AssistantMessage) =>
  result.diagnostics?.find((d) => d.type === "openai_responses_empty_boundary")?.details;

describe("Responses empty boundary metadata", () => {
  it("classifies an empty terminal through the real adapter without raw capture", async () => {
    const result = await run([terminal([message("")])]);
    expect(result.content).toEqual([]);
    expect(boundary(result)).toMatchObject({
      classification: "wire_empty_normalized_empty",
      responseId: "resp_0123456789abcdef0123456789abcdef",
      status: "completed",
      normalizedFinalLength: 0,
      terminalFinalLength: 0,
      eventCount: 1,
      usage: { inputTokens: 310, outputTokens: 8, reasoningTokens: 0 },
    });
  });
  it.each(["analysis", "commentary"])("keeps %s distinct from final", async (phase) => {
    const result = await run([terminal([message("SECRET_CANARY", phase, phase)])]);
    expect(boundary(result)).toMatchObject({
      classification: "wire_empty_normalized_empty",
      normalizedTotalVisibleLength: 13,
      normalizedFinalLength: 0,
    });
  });
  it("preserves fresh synthetic wire, terminal recovery and explicit silent replies", async () => {
    for (const text of ["SYNTHETIC_MARKER", "NO_REPLY"]) {
      const item = message(text);
      const normal = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        terminal([item]),
      ]);
      const recovered = await run([terminal([item])]);
      expect(normal.content).toEqual(recovered.content);
      expect(boundary(normal)).toBeUndefined();
      expect(boundary(recovered)).toBeUndefined();
      expect(JSON.stringify(normal.diagnostics)).not.toContain(text);
    }
  });
  it("detects stream text lost to an empty authoritative snapshot", async () => {
    const item = message("");
    const result = await run([
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_text.delta", output_index: 0, delta: "SECRET_CANARY" },
      { type: "response.output_item.done", output_index: 0, item: message("") },
      terminal([message("")]),
    ]);
    expect(boundary(result)).toMatchObject({
      classification: "wire_nonempty_normalized_empty",
      wireFinalLength: 13,
      terminalFinalLength: 0,
      normalizedFinalLength: 0,
    });
    expect(JSON.stringify(boundary(result))).not.toContain("SECRET_CANARY");
  });
  it("identifies terminal wire vs normalized loss independently of parser behavior", () => {
    const metadata = createResponsesBoundaryMetadata();
    const event = terminal([message("SECRET_CANARY")]);
    metadata.observe(event);
    const normalized = output();
    const details = metadata.finish(normalized);
    expect(details).toMatchObject({
      classification: "wire_nonempty_normalized_empty",
      terminalFinalLength: 13,
    });
  });
  it("bounds hostile metadata and never projects arbitrary fields or nested payloads", () => {
    const canary = "SECRET_CANARY";
    const metadata = createResponsesBoundaryMetadata();
    const normalized = output();
    for (let i = 0; i < 2000; i++) {
      metadata.observe({
        type: canary + i,
        delta: canary,
        arguments: canary,
        headers: { authorization: canary },
      });
    }
    for (let i = 0; i < 100; i++) {
      metadata.observe({
        type: "response.output_item.added",
        output_index: i,
        item: {
          type: canary,
          phase: canary,
          channel: canary,
          content: [{ type: canary, text: canary }],
        },
      });
    }
    const event = {
      type: "response.completed",
      response: {
        id: `resp_${canary}`,
        status: canary,
        output: Array.from({ length: 100 }, () => ({
          type: "message",
          phase: { nested: canary },
          channel: [canary],
          content: Array.from({ length: 100 }, () => ({ type: { nested: canary }, text: canary })),
        })),
        usage: {
          input_tokens: Infinity,
          output_tokens: -42,
          total_tokens: 1e100,
          output_tokens_details: { reasoning_tokens: Number.NaN },
          attribution: { secret: canary },
        },
      },
    };
    metadata.observe(event);
    const details = metadata.finish(normalized);
    expect(details).toMatchObject({
      truncated: true,
      responseId: "unknown",
      status: "unknown",
      classification: "wire_unknown_normalized_empty",
      events: { unknown: 2000 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1_000_000_000, reasoningTokens: 0 },
    });
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain(canary);
    expect(serialized.length).toBeLessThan(3000);
  });
  it("keeps metadata size independent of stream event count", () => {
    const metadata = createResponsesBoundaryMetadata();
    const item = message("");
    metadata.observe({ type: "response.output_item.added", output_index: 0, item });
    for (let index = 0; index < 100_000; index++) {
      metadata.observe({ type: "response.output_text.delta", output_index: 0, delta: "x" });
    }
    const event = terminal([message("")]);
    metadata.observe(event);
    const normalized = output();
    const details = metadata.finish(normalized);
    expect(details).toMatchObject({
      eventCount: 100_002,
      wireFinalLength: 100_000,
      events: { "response.output_text.delta": 100_000 },
    });
    expect(JSON.stringify(details).length).toBeLessThan(1500);
  });
  it("preserves normal diagnostic policy when the final block follows more than 64 blocks", () => {
    const metadata = createResponsesBoundaryMetadata();
    metadata.observe(terminal([]));
    const normalized = output();
    normalized.content = Array.from({ length: 65 }, () => ({
      type: "text" as const,
      text: "commentary",
      textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
    }));
    normalized.content.push({
      type: "text",
      text: "final",
      textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
    });
    expect(metadata.finish(normalized)).toBeUndefined();
  });
  it("does not change tool admission or add diagnostics to terminal tool completions", async () => {
    const result = await run([
      terminal([
        {
          type: "function_call",
          id: "fc_synthetic",
          call_id: "call_synthetic",
          name: "synthetic",
          arguments: '{"secret":"SECRET_CANARY"}',
          status: "completed",
        },
      ]),
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(boundary(result)).toBeUndefined();
  });
});

describe("review regressions through the real Responses adapter", () => {
  const added = () => ({ type: "response.output_item.added", output_index: 0, item: message("") });
  const created = () => ({
    type: "response.created",
    response: { id: "resp_0123456789abcdef0123456789abcdef", status: "in_progress" },
  });
  async function failedAttempt(events: unknown[], failure?: Error) {
    const result = output();
    let caught: unknown;
    async function* source() {
      yield* events;
      if (failure) {
        throw failure;
      }
    }
    try {
      await processResponsesStream(source(), result, { push() {} }, model);
    } catch (error) {
      caught = error;
    }
    return { result, caught, details: boundary(result) };
  }
  it.each([
    { type: "response.output_text.done", text: "SECRET_CANARY" },
    { type: "response.text.done", text: "SECRET_CANARY" },
    { type: "response.refusal.done", refusal: "SECRET_CANARY" },
    { type: "response.content_part.done", part: { type: "output_text", text: "SECRET_CANARY" } },
    { type: "response.content_part.done", part: { type: "refusal", refusal: "SECRET_CANARY" } },
  ])("F1 counts done-only $type before empty terminal", async (done) => {
    const result = await run([added(), { ...done, output_index: 0 }, terminal([message("")])]);
    expect(result.content.every((block) => block.type !== "text" || block.text === "")).toBe(true);
    expect(boundary(result)).toMatchObject({
      classification: "wire_nonempty_normalized_empty",
      wireFinalLength: 13,
      normalizedFinalLength: 0,
    });
    expect(JSON.stringify(boundary(result))).not.toContain("SECRET_CANARY");
  });
  it.each([
    { type: "response.output_audio_transcript.delta", delta: "SECRET_CANARY" },
    { type: "SECRET_CANARY", text: "SECRET_CANARY" },
    { type: "response.content_part.done", part: { type: "SECRET_CANARY", text: "SECRET_CANARY" } },
    {
      type: "response.content_part.done",
      part: { type: "output_text", text: { nested: "SECRET_CANARY" } },
    },
  ])("F2 preserves uncertainty for unknown/malformed content $type", async (event) => {
    const result = await run([added(), { ...event, output_index: 0 }, terminal([message("")])]);
    expect(boundary(result)).toMatchObject({
      classification: "wire_unknown_normalized_empty",
      wireUnknown: true,
    });
    expect(JSON.stringify(boundary(result))).not.toContain("SECRET_CANARY");
  });
  it.each([false, true])(
    "F3 preserves reset identity and partial evidence (partial=%s)",
    async (partial) => {
      const failure = Object.assign(new Error("SECRET_CANARY reset"), { code: "ECONNRESET" });
      const events = [
        created(),
        added(),
        ...(partial
          ? [{ type: "response.output_text.delta", output_index: 0, delta: "SECRET_CANARY" }]
          : []),
      ];
      const { result, caught, details } = await failedAttempt(events, failure);
      expect(caught).toBe(failure);
      expect(details).toMatchObject({
        attemptOutcome: "error",
        streamTermination: "stream_error",
        terminalObserved: false,
        responseId: "resp_0123456789abcdef0123456789abcdef",
        normalizedFinalLength: 0,
        normalizedPartialFinalLength: partial ? 13 : 0,
      });
      expect(
        result.content.some((block) => block.type === "text" && block.text === "SECRET_CANARY"),
      ).toBe(partial);
      expect(JSON.stringify(details)).not.toContain("SECRET_CANARY");
    },
  );
  it("F3 preserves EOF metadata and original missing-terminal exception", async () => {
    const { caught, details } = await failedAttempt([created()]);
    expect(String(caught)).toContain("before a terminal response event");
    expect(details).toMatchObject({
      attemptOutcome: "error",
      streamTermination: "eof",
      wireUnknown: true,
      eventCount: 1,
    });
  });
  it.each([
    { type: "response.output_text.delta", delta: { nested: "SECRET_CANARY" } },
    {
      type: "response.completed",
      response: { output: [{ ...message(""), content: { nested: "SECRET_CANARY" } }] },
    },
    { type: "response.completed", response: null },
  ])("F3 preserves diagnostics before malformed finalization $type", async (event) => {
    const { caught, details } = await failedAttempt([
      created(),
      added(),
      { ...event, output_index: 0 },
    ]);
    expect(caught).toBeInstanceOf(Error);
    expect(details).toMatchObject({ attemptOutcome: "error", wireUnknown: true });
    expect(JSON.stringify(details)).not.toContain("SECRET_CANARY");
    if (event.type === "response.output_text.delta") {
      expect(String(caught)).toContain("malformed response.output_text.delta delta");
    } else if (event.response === null) {
      expect(String(caught)).toContain("malformed response.completed response");
    } else {
      expect(String(caught)).toContain("some is not a function");
    }
  });
  it.each(["whitespace", "mixed", "ordinary", "silent"])(
    "F4 crosschecks canonical final classification: %s",
    async (variant) => {
      const items =
        variant === "mixed"
          ? [
              { ...message("progress", "commentary"), id: "msg_commentary" },
              { ...message("legacy"), id: "msg_legacy", phase: undefined },
            ]
          : [
              message(
                variant === "whitespace" ? " \n\t" : variant === "silent" ? "NO_REPLY" : "ordinary",
              ),
            ];
      const result = await run([terminal(items)]);
      const canonical = classifyAssistantTurn({
        payloadCount: 0,
        attempt: {
          assistantTexts: [],
          currentAttemptAssistant: result,
          currentAttemptCompletedAssistant: undefined,
        },
      });
      expect(canonical.emptyResponse).toBe(variant !== "ordinary");
      expect(canonical.silent).toBe(variant === "silent");
      if (canonical.emptyResponse && !canonical.silent) {
        expect(boundary(result)).toMatchObject({ normalizedFinalLength: 0 });
      } else {
        expect(boundary(result)).toBeUndefined();
      }
    },
  );
  it("stops at the first terminal and preserves terminal-only recovery", async () => {
    const result = await run([terminal([message("recovered")]), terminal([message("")])]);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "recovered" }),
    );
    expect(boundary(result)).toBeUndefined();
  });
  it("A1 shares schema facts while preserving replay fallback and diagnostic bounds", () => {
    for (const [signature, phase, kind] of [
      [undefined, "absent", "absent"],
      ["legacy", "absent", "legacy"],
      ["{bad", "unknown", "invalid"],
      [
        JSON.stringify({ v: 2, id: "SECRET_CANARY", phase: "final_answer" }),
        "unknown",
        "unsupported",
      ],
      [JSON.stringify({ v: 1, id: "SECRET_CANARY", phase: "SECRET_CANARY" }), "unknown", "v1"],
      [JSON.stringify({ v: 1, phase: "final_answer" }), "final_answer", "v1"],
      [
        JSON.stringify({ v: 1, id: "x".repeat(4096), phase: "final_answer" }),
        "unknown",
        "over_limit",
      ],
    ] as const) {
      expect(decodeResponsesTextSignature(signature, 4096)).toMatchObject({ kind, phase });
      const result = output();
      result.content = [
        { type: "text", text: "", ...(signature ? { textSignature: signature } : {}) },
      ];
      const metadata = createResponsesBoundaryMetadata();
      metadata.observe(terminal([]));
      expect(JSON.stringify(metadata.finish(result))).not.toContain("SECRET_CANARY");
    }
    const result = output();
    result.content = [
      {
        type: "text",
        text: "replay",
        textSignature: JSON.stringify({
          v: 1,
          id: "msg_0123456789abcdef0123456789abcdef",
          phase: "commentary",
        }),
      },
    ];
    const replay = convertResponsesMessages(model, { messages: [result] }, new Set(["openai"]));
    expect(replay).toContainEqual(expect.objectContaining({ phase: "commentary" }));
  });
});
