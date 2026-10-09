import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { emitModelTransportDebug, resolveModelSseDebugMode } from "./model-transport-debug.js";
import {
  createResponsesBoundaryMetadata,
  responsesBoundaryEventType,
} from "./openai-responses-boundary-metadata-internal.js";
import { stringifyRedactedEvent } from "./openai-responses-debug.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-internal.js";
import { log } from "./openai-transport-shared.js";
import { iterateModelStream } from "./transport-stream-shared.js";

type BoundaryOutput = { output?: AssistantMessage };
const boundaryOutputs = new WeakMap<object, BoundaryOutput>();

/** Bind the existing message sink to this attempt without extending transport options. */
export function bindResponsesBoundaryOutput(response: object, output: AssistantMessage): void {
  const binding = boundaryOutputs.get(response);
  if (binding) {
    binding.output = output;
    boundaryOutputs.delete(response);
  }
}

const STRING_DELTA_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.refusal.delta",
  "response.text.delta",
]);

export async function* adaptResponsesStream(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  const metadata = createResponsesBoundaryMetadata();
  const binding: BoundaryOutput = {};
  try {
    for await (const event of iterateModelStream(stream, signal)) {
      if (!isRecord(event) || typeof event.type !== "string") {
        throw new Error("Responses stream delivered a malformed event without a string type");
      }
      if (STRING_DELTA_EVENTS.has(event.type) && typeof event.delta !== "string") {
        throw new Error(`Responses stream delivered malformed ${event.type} delta`);
      }
      if (
        (event.type === "response.output_item.added" ||
          event.type === "response.output_item.done") &&
        !isRecord(event.item)
      ) {
        throw new Error(`Responses stream delivered malformed ${event.type} item`);
      }
      if (
        (event.type === "response.created" ||
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed") &&
        !isRecord(event.response)
      ) {
        throw new Error(`Responses stream delivered malformed ${event.type} response`);
      }
      metadata.observe(event);
      if (
        (event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed") &&
        isRecord(event.response)
      ) {
        boundaryOutputs.set(event.response, binding);
      }
      yield event as OpenAIResponsesStreamEvent;
    }
  } finally {
    // Iterator close happens after the consumer finishes terminal recovery.
    const details = metadata.finish(binding.output);
    if (binding.output && details) {
      appendAssistantMessageDiagnostic(binding.output, {
        type: "openai_responses_empty_boundary",
        timestamp: Date.now(),
        details,
      });
    }
    binding.output = undefined;
  }
}

export async function* observeResponsesStream<TEvent>(
  stream: AsyncIterable<TEvent>,
  model: Model,
  requestStartedAt?: number,
): AsyncGenerator<TEvent> {
  const startedAt = Date.now();
  const eventTypes = new Map<string, number>();
  const debugMode = resolveModelSseDebugMode();
  let eventCount = 0;
  try {
    for await (const event of stream) {
      const type = responsesBoundaryEventType(isRecord(event) ? event.type : undefined);
      eventCount = Math.min(1_000_000_000, eventCount + 1);
      eventTypes.set(type, Math.min(1_000_000_000, (eventTypes.get(type) ?? 0) + 1));
      if (eventCount === 1) {
        emitModelTransportDebug(
          log,
          `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - (requestStartedAt ?? startedAt)} ` +
            `headersToEventMs=${Date.now() - startedAt} type=${type}`,
        );
      }
      if (debugMode === "peek" && eventCount <= 5) {
        emitModelTransportDebug(
          log,
          `[responses] event_peek provider=${model.provider} api=${model.api} model=${model.id} index=${eventCount} type=${type} event=${stringifyRedactedEvent(event)}`,
        );
      }
      yield event;
    }
  } finally {
    const types = [...eventTypes].map(([type, count]) => `${type}:${count}`).join(",");
    emitModelTransportDebug(
      log,
      `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} elapsedMs=${Date.now() - startedAt} events=${eventCount} types=${types}`,
    );
  }
}
