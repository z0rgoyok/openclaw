import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../types.js";

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
    observe(event: Record<string, unknown>) {
      eventCount = bounded(eventCount + 1);
      const type = known(event.type, EVENT_TYPES);
      add(events, type);
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
      if (type === "response.content_part.added" || type === "response.content_part.done") {
        add(contentTypes, known(isRecord(event.part) ? event.part.type : undefined, CONTENT_TYPES));
      }
      if (
        type === "response.output_text.delta" ||
        type === "response.text.delta" ||
        type === "response.refusal.delta"
      ) {
        const routed = index === undefined ? undefined : slots.get(index);
        const phase = routed?.phase ?? "unknown";
        const channel = routed?.channel ?? "unknown";
        const size = length(event.delta);
        if (size > 0 && (!routed || phase === "unknown" || channel === "unknown")) {
          wireUnknown = true;
        }
        add(deltaLengths, `${phase}/${channel}`, size);
        if (visibleFinal(phase, channel)) {
          wireFinalLength = bounded(wireFinalLength + size);
        }
      }
      if (
        (type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed") &&
        isRecord(event.response)
      ) {
        const response = event.response;
        terminalEvent = type;
        responseId =
          typeof response.id === "string" && /^resp_[a-f0-9]{24,96}$/.test(response.id)
            ? response.id
            : "unknown";
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
        if (Array.isArray(response.output)) {
          if (response.output.length > LIMIT) {
            truncated = true;
          }
          for (const item of response.output.slice(0, LIMIT)) {
            scanItem(item, true);
          }
        }
      }
    },
    finish(output?: AssistantMessage): Record<string, unknown> | undefined {
      slots.clear();
      if (!output) {
        return undefined;
      }
      let finalLength = 0;
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
        let phase = "absent";
        // Signatures are existing adapter metadata; parse only a bounded envelope.
        if (block.textSignature?.startsWith("{")) {
          phase = "unknown";
          if (block.textSignature.length <= 4096) {
            try {
              const signature: unknown = JSON.parse(block.textSignature);
              if (isRecord(signature) && signature.v === 1) {
                phase = optional(signature.phase, PHASES);
              }
            } catch {
              /* malformed signatures do not supply final-phase evidence */
            }
          }
        }
        if (visibleFinal(phase, "absent")) {
          finalLength = bounded(finalLength + length(block.text));
        }
      }
      // Normal final replies (including explicit silent replies) retain their existing log policy.
      if (finalLength > 0 || toolCalls > 0) {
        return undefined;
      }
      return {
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
        snapshotLengths,
        wireFinalLength,
        terminalFinalLength,
        terminalToolCalls,
        streamedToolItems,
        usage,
        truncated,
        wireUnknown,
        normalizedFinalLength: finalLength,
        normalizedTotalVisibleLength: totalLength,
        normalizedToolCalls: toolCalls,
      };
    },
  };
}
