import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

// A fast turn should leave its preview readable before retiring it.
const MIN_PREVIEW_DWELL_MS = 4_000;

/** Own retired preview custody until replacement acceptance or explicit stream cleanup. */
export function createTelegramPreviewCleanup(params: {
  api: Pick<Bot["api"], "deleteMessage">;
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  onDeleted: (messageId: number) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}) {
  const retired = new Map<number, number | undefined>();
  const scheduleDelete = (messageId: number, visibleSince: number | undefined) => {
    const runDelete = async () => {
      try {
        const deleted = await params.api.deleteMessage(params.chatId, messageId);
        if (!deleted) {
          params.warn?.(
            `telegram stream preview cleanup was not confirmed (chat=${params.chatId}, message=${messageId})`,
          );
          return;
        }
        params.onDeleted(messageId);
        params.log?.(
          `telegram stream preview deleted (chat=${params.chatId}, message=${messageId})`,
        );
      } catch (err) {
        params.warn?.(`telegram stream preview cleanup failed: ${formatErrorMessage(err)}`);
      }
    };
    const elapsed =
      typeof visibleSince === "number" ? Date.now() - visibleSince : MIN_PREVIEW_DWELL_MS;
    const delay = Math.max(0, MIN_PREVIEW_DWELL_MS - elapsed);
    if (delay === 0) {
      void runDelete();
    } else {
      setTimeout(() => {
        void runDelete();
      }, delay);
    }
  };
  return {
    scheduleDelete,
    retire: (messageId: number, visibleSince: number | undefined) => {
      retired.set(messageId, visibleSince);
    },
    deleteRetired: () => {
      for (const [id, visibleSince] of retired) {
        scheduleDelete(id, visibleSince);
      }
      retired.clear();
    },
  };
}
