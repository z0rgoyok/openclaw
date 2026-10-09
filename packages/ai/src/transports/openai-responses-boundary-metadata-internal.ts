import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../types.js";
import { decodeResponsesTextSignature } from "./openai-responses-text-signature-internal.js";

const LIMIT = 64;
const MAX = 1_000_000_000;
const EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.text.delta",
  "response.text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);
export const responsesBoundaryEventType = (value: unknown): string => known(value, EVENT_TYPES);

const ITEM_TYPES = new Set(["message", "reasoning", "function_call", "compaction"]);
const CONTENT_TYPES = new Set(["output_text", "text", "refusal", "reasoning_text", "summary_text"]);
const PHASES = new Set(["final_answer", "commentary", "analysis"]);
const CHANNELS = new Set(["final", "commentary", "analysis"]);
const STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "in_progress",
  "queued",
  "cancelled",
]);
const known = (value: unknown, allowed: Set<string>): string =>
  typeof value === "string" && allowed.has(value) ? value : "unknown";
const optional = (value: unknown, allowed: Set<string>): string =>
  value == null ? "absent" : known(value, allowed);
const bounded = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX, Math.max(0, Math.floor(value)))
    : 0;
const length = (value: unknown): number => (typeof value === "string" ? bounded(value.length) : 0);
const add = (counts: Record<string, number>, key: string, amount = 1) => {
  counts[key] = bounded((counts[key] ?? 0) + amount);
};
const visibleFinal = (phase: string, channel: string): boolean =>
  (phase === "final_answer" || phase === "absent") && (channel === "final" || channel === "absent");

type PhaseChannel = { phase: string; channel: string };
/** One attempt, fixed dictionaries and at most 64 routing slots; never retain payload objects/text. */
export function createResponsesBoundaryMetadata() {
  const events: Record<string, number> = {};
  const itemTypes: Record<string, number> = {};
  const contentTypes: Record<string, number> = {};
  const itemPhaseChannels: Record<string, number> = {};
  const deltaLengths: Record<string, number> = {};
  const doneLengths: Record<string, number> = {};
  const unknownContentLengths: Record<string, number> = {};
  let streamTermination: "unknown" | "eof" | "stream_error" | "malformed_event" | "consumer_close" =
    "unknown";
  const snapshotLengths: Record<string, number> = {};
  const slots = new Map<number, PhaseChannel>();
  let truncated = false;
  let wireUnknown = false;
  let eventCount = 0;
  let wireFinalLength = 0;
  let terminalFinalLength = 0;
  let terminalToolCalls = 0;
  let streamedToolItems = 0;
  let terminalEvent = "unknown";
  let responseId = "unknown";
  let status = "unknown";
  let usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  const phaseChannel = (item: Record<string, unknown>): PhaseChannel => ({
    phase: optional(item.phase, PHASES),
    channel: optional(item.channel, CHANNELS),
  });
  const scanItem = (value: unknown, terminal: boolean) => {
    if (!isRecord(value)) {
      add(itemTypes, "unknown");
      wireUnknown = true;
      return;
    }
    const type = known(value.type, ITEM_TYPES);
    add(itemTypes, type);
    if (type === "function_call") {
      if (terminal) {
        terminalToolCalls = bounded(terminalToolCalls + 1);
      } else {
        streamedToolItems = bounded(streamedToolItems + 1);
      }
    }
    const { phase, channel } = phaseChannel(value);
    add(itemPhaseChannels, `${phase}/${channel}`);
    if (
      type === "unknown" ||
      (type === "message" && (phase === "unknown" || channel === "unknown"))
    ) {
      wireUnknown = true;
    }
    if (!Array.isArray(value.content)) {
      if (type === "message" && (terminal || value.content != null)) {
        wireUnknown = true;
      }
      return;
    }
    if (value.content.length > LIMIT) {
      truncated = true;
    }
    for (const part of value.content.slice(0, LIMIT)) {
      const partType = known(isRecord(part) ? part.type : undefined, CONTENT_TYPES);
      add(contentTypes, partType);
      if (type === "message" && partType === "unknown") {
        wireUnknown = true;
      }
      if (type !== "message" || !isRecord(part)) {
        continue;
      }
      const size =
        partType === "output_text" || partType === "text"
          ? length(part.text)
          : partType === "refusal"
            ? length(part.refusal)
            : 0;
      add(snapshotLengths, `${phase}/${channel}`, size);
      if (visibleFinal(phase, channel)) {
        wireFinalLength = bounded(wireFinalLength + size);
        if (terminal) {
          terminalFinalLength = bounded(terminalFinalLength + size);
        }
      }
    }
  };
  return {
    noteStreamTermination(value: typeof streamTermination) {
      streamTermination = value;
    },
    observe(value: unknown) {
      eventCount = bounded(eventCount + 1);
      const event = isRecord(value) ? value : {};
      if (!isRecord(value)) {
        wireUnknown = true;
      }
      const type = known(event.type, EVENT_TYPES);
      add(events, type);
      if (
        type === "unknown" &&
        (event.delta !== undefined ||
          event.text !== undefined ||
          event.refusal !== undefined ||
          event.part !== undefined ||
          event.content !== undefined)
      ) {
        wireUnknown = true;
        add(unknownContentLengths, "delta", length(event.delta));
        add(unknownContentLengths, "text", length(event.text));
        add(unknownContentLengths, "refusal", length(event.refusal));
      }
      if (
        (type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed" ||
          type === "response.created") &&
        !isRecord(event.response)
      ) {
        wireUnknown = true;
      }
      const index =
        typeof event.output_index === "number" &&
        Number.isSafeInteger(event.output_index) &&
        event.output_index >= 0
          ? event.output_index
          : undefined;
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        if (isRecord(event.item) && index !== undefined) {
          if (slots.has(index) || slots.size < LIMIT) {
            slots.set(index, phaseChannel(event.item));
          } else {
            truncated = true;
          }
        }
        scanItem(event.item, false);
      }
      const routed = index === undefined ? undefined : slots.get(index);
      const phase = routed?.phase ?? "unknown";
      const channel = routed?.channel ?? "unknown";
      const observeText = (size: number, lengths: Record<string, number>) => {
        if (size > 0 && (!routed || phase === "unknown" || channel === "unknown")) {
          wireUnknown = true;
        }
        add(lengths, `${phase}/${channel}`, size);
        if (visibleFinal(phase, channel)) {
          wireFinalLength = bounded(wireFinalLength + size);
        }
      };
      if (type === "response.content_part.added" || type === "response.content_part.done") {
        const part = isRecord(event.part) ? event.part : {};
        const partType = known(part.type, CONTENT_TYPES);
        add(contentTypes, partType);
        if (partType === "unknown") {
          wireUnknown = true;
          add(unknownContentLengths, "partText", length(part.text));
          add(unknownContentLengths, "partRefusal", length(part.refusal));
        } else if (type === "response.content_part.done") {
          if (
            (partType === "text" || partType === "output_text") &&
            typeof part.text !== "string"
          ) {
            wireUnknown = true;
          }
          if (partType === "refusal" && typeof part.refusal !== "string") {
            wireUnknown = true;
          }
          observeText(
            partType === "output_text" || partType === "text"
              ? length(part.text)
              : partType === "refusal"
                ? length(part.refusal)
                : 0,
            doneLengths,
          );
        }
      }
      if (
        type === "response.output_text.delta" ||
        type === "response.text.delta" ||
        type === "response.refusal.delta"
      ) {
        if (typeof event.delta !== "string") {
          wireUnknown = true;
        }
        observeText(length(event.delta), deltaLengths);
      }
      if (
        type === "response.output_text.done" ||
        type === "response.text.done" ||
        type === "response.refusal.done"
      ) {
        const text = type === "response.refusal.done" ? event.refusal : event.text;
        if (typeof text !== "string") {
          wireUnknown = true;
        }
        observeText(length(text), doneLengths);
      }
      if (
        (type === "response.created" ||
          type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed") &&
        isRecord(event.response)
      ) {
        const response = event.response;
        if (type !== "response.created") {
          terminalEvent = type;
        }
        responseId =
          typeof response.id === "string" && /^resp_[a-f0-9]{24,96}$/.test(response.id)
            ? response.id
            : responseId;
        status = known(response.status, STATUSES);
        const rawUsage = isRecord(response.usage) ? response.usage : {};
        const details = isRecord(rawUsage.output_tokens_details)
          ? rawUsage.output_tokens_details
          : {};
        usage = {
          inputTokens: bounded(rawUsage.input_tokens),
          outputTokens: bounded(rawUsage.output_tokens),
          reasoningTokens: bounded(details.reasoning_tokens),
          totalTokens: bounded(rawUsage.total_tokens),
        };
        if (type !== "response.created" && !Array.isArray(response.output)) {
          wireUnknown = true;
        }
        if (type !== "response.created" && Array.isArray(response.output)) {
          if (response.output.length > LIMIT) {
            truncated = true;
          }
          for (const item of response.output.slice(0, LIMIT)) {
            scanItem(item, true);
          }
        }
      }
    },
    finish(
      output?: AssistantMessage,
      attemptOutcome: "completed" | "error" = "completed",
    ): Record<string, unknown> | undefined {
      slots.clear();
      if (attemptOutcome === "error" && terminalEvent === "unknown") {
        wireUnknown = true;
      }
      if (!output) {
        return undefined;
      }
      let finalLength = 0;
      let finalRawLength = 0;
      const hasExplicitPhases = output.content.some((block) => {
        if (block.type !== "text") {
          return false;
        }
        const facts = decodeResponsesTextSignature(block.textSignature, 4096);
        return facts.phase === "commentary" || facts.phase === "final_answer";
      });
      let totalLength = 0;
      let toolCalls = 0;
      // Normalized blocks already exist: aggregate all of them without retaining an item list,
      // so a late final reply never becomes a false empty-boundary diagnostic.
      for (const block of output.content) {
        if (block.type === "toolCall") {
          toolCalls = bounded(toolCalls + 1);
        }
        if (block.type !== "text") {
          continue;
        }
        totalLength = bounded(totalLength + length(block.text));
        const { phase } = decodeResponsesTextSignature(block.textSignature, 4096);
        if (phase === "final_answer" || (phase === "absent" && !hasExplicitPhases)) {
          finalRawLength = bounded(finalRawLength + length(block.text));
          finalLength = bounded(finalLength + length(block.text.trim()));
        }
      }
      // Normal final replies (including explicit silent replies) retain their existing log policy.
      if (attemptOutcome === "completed" && (finalLength > 0 || toolCalls > 0)) {
        return undefined;
      }
      return {
        attemptOutcome,
        streamTermination,
        terminalObserved: terminalEvent !== "unknown",
        classification:
          wireFinalLength > 0
            ? "wire_nonempty_normalized_empty"
            : truncated || wireUnknown
              ? "wire_unknown_normalized_empty"
              : "wire_empty_normalized_empty",
        responseId,
        status,
        terminalEvent,
        eventCount,
        events,
        itemTypes,
        contentTypes,
        itemPhaseChannels,
        deltaLengths,
        doneLengths,
        unknownContentLengths,
        snapshotLengths,
        wireFinalLength,
        terminalFinalLength,
        terminalToolCalls,
        streamedToolItems,
        usage,
        truncated,
        wireUnknown,
        normalizedFinalLength: attemptOutcome === "completed" ? finalLength : 0,
        normalizedPartialFinalLength: attemptOutcome === "error" ? finalLength : 0,
        normalizedFinalRawLength: finalRawLength,
        normalizedTotalVisibleLength: totalLength,
        normalizedToolCalls: toolCalls,
      };
    },
  };
}
