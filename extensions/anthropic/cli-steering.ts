import { randomUUID } from "node:crypto";
import type { CliBackendMessageInjectionInput } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

/** One admitted turn owns both native input receipts and their eventual answers. */
export function createClaudeCliSteering() {
  const receipts = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const results = new Set<string>();
  let closed = false;
  return {
    async send(
      input: CliBackendMessageInjectionInput,
      transport: {
        assertCurrent(): void;
        send(message: Record<string, unknown>): Promise<void>;
        sessionId?: string;
        onError(error: unknown): void;
      },
    ): Promise<void> {
      transport.assertCurrent();
      if (closed) {
        throw new Error("Claude CLI input owner is closed.");
      }
      const uuid = randomUUID();
      const receipt = createDeferred<void>();
      // A write failure or process exit can reject before send reaches the await.
      void receipt.promise.catch(() => {});
      receipts.set(uuid, receipt);
      results.add(uuid);
      let dispatched = false;
      try {
        // No asynchronous work separates the final assertions and physical write.
        transport.assertCurrent();
        input.onDispatched();
        dispatched = true;
        await transport.send({
          type: "user",
          message: { role: "user", content: input.text },
          parent_tool_use_id: null,
          uuid,
          ...(transport.sessionId ? { session_id: transport.sessionId } : {}),
        });
        await receipt.promise;
      } catch (error) {
        receipts.delete(uuid);
        results.delete(uuid);
        if (dispatched) {
          transport.onError(error);
        }
        throw error;
      }
    },
    acceptReceipt(message: Record<string, unknown>) {
      if (
        message.type !== "user" ||
        message.isReplay !== true ||
        message.parent_tool_use_id !== null ||
        typeof message.uuid !== "string"
      ) {
        return;
      }
      const receipt = receipts.get(message.uuid);
      receipts.delete(message.uuid);
      receipt?.resolve();
    },
    acceptResult(message: Record<string, unknown>) {
      const covered = Array.isArray(message.user_message_uuids)
        ? message.user_message_uuids
        : [message.user_message_uuid];
      for (const uuid of covered) {
        if (typeof uuid === "string") {
          results.delete(uuid);
        }
      }
    },
    hasPendingResult: () => results.size > 0,
    hasPendingReceipt: () => receipts.size > 0,
    close(error: Error) {
      closed = true;
      for (const receipt of receipts.values()) {
        receipt.reject(error);
      }
      receipts.clear();
      results.clear();
    },
  };
}
