import { isRecord } from "@openclaw/normalization-core/record-coerce";

type SignatureFacts = {
  kind: "absent" | "legacy" | "v1" | "invalid" | "unsupported" | "over_limit";
  id?: string;
  phase: "absent" | "unknown" | "commentary" | "final_answer" | "analysis";
};

/** Decode schema/version facts only; replay fallback and diagnostic bounds belong to readers. */
export function decodeResponsesTextSignature(value: unknown, maxLength?: number): SignatureFacts {
  if (value === undefined || value === null || value === "") {
    return { kind: "absent", phase: "absent" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid", phase: "unknown" };
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return { kind: "over_limit", phase: "unknown" };
  }
  if (!value.startsWith("{")) {
    return { kind: "legacy", phase: "absent" };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { kind: "invalid", phase: "unknown" };
    }
    if (parsed.v !== 1) {
      return { kind: "unsupported", phase: "unknown" };
    }
    return {
      kind: "v1",
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      phase:
        parsed.phase == null
          ? "absent"
          : parsed.phase === "commentary" ||
              parsed.phase === "final_answer" ||
              parsed.phase === "analysis"
            ? parsed.phase
            : "unknown",
    };
  } catch {
    return { kind: "invalid", phase: "unknown" };
  }
}
