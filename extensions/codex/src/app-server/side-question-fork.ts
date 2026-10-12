import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexThreadForkParams } from "./protocol.js";
import type { CodexSidePreparedModelAdmission } from "./side-question-model-source.js";

export async function forkCodexSideThread(
  client: CodexAppServerClient,
  params: CodexThreadForkParams,
  options: { timeoutMs: number; signal?: AbortSignal; assertCurrent?: () => void },
  admission?: CodexSidePreparedModelAdmission,
): Promise<unknown> {
  try {
    if (admission) {
      const prepared = await admission.prepare(
        client,
        params.cwd ?? "",
        params.config ?? undefined,
      );
      return await client.request(
        "thread/fork",
        { ...params, ...prepared },
        {
          ...options,
          assertCurrent: () => {
            options.assertCurrent?.();
            admission.assertCurrent();
          },
        },
      );
    }
    return await client.request("thread/fork", params, options);
  } catch (error) {
    if (isMissingCodexParentThreadError(error)) {
      throw new Error(
        "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingCodexParentThreadError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("includeTurns is unavailable before first user message")
  );
}
