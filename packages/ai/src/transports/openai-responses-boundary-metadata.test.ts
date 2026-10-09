import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createResponsesBoundaryMetadata } from "./openai-responses-boundary-metadata-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";

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
