import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  emitToolStart,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import { createTelegramMessageCache } from "./message-cache.js";

describeTelegramDispatch("progress owner during steering", () => {
  it("keeps the running card subscribed while a silent same-chat dispatch enters and settles", async () => {
    vi.useFakeTimers();
    try {
      const actual = await vi.importActual<typeof TelegramDraftModule>("./draft-stream.js");
      let activeDraft: TelegramDraftStream | undefined;
      createTelegramDraftStream.mockImplementation((params) => {
        const stream = actual.createTelegramDraftStream(params);
        activeDraft ??= stream;
        return stream;
      });
      const bot = createBot();
      let nextId = 10;
      const send = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => ({
        message_id: nextId++,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Test" },
        text,
      }));
      vi.spyOn(bot.api, "editMessageText").mockResolvedValue(true);
      const remove = vi.spyOn(bot.api, "deleteMessage").mockResolvedValue(true);
      const cache = createTelegramMessageCache();
      const record = (id: number) =>
        cache.record({
          accountId: "default",
          chatId: 123,
          msg: {
            message_id: id,
            date: 0,
            chat: { id: 123, type: "private", first_name: "Test" },
            text: "Update",
          },
        });
      const dispatch = () =>
        dispatchWithContext({
          bot,
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: "progress",
          telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
        });
      dispatchReplyWithBufferedBlockDispatcher
        .mockImplementationOnce(async ({ replyOptions }) => {
          await emitToolStart(replyOptions, {
            name: "exec",
            toolCallId: "long-running",
            phase: "start",
          });
          await activeDraft?.flush();
          expect(activeDraft?.messageId()).toBe(10);
          await dispatch();
          // The original run stays active after steer admission; no new tool event is required.
          nextId = 14;
          await record(13);
          await vi.advanceTimersByTimeAsync(4000);
          await activeDraft?.flush();
          expect(activeDraft?.messageId()).toBe(14);
          expect(remove).toHaveBeenCalledWith(123, 12);
          await emitToolStart(replyOptions, { name: "read", toolCallId: "next", phase: "start" });
          await activeDraft?.flush();
          expect(send).toHaveBeenCalledTimes(3);
          return { queuedFinal: false };
        })
        .mockImplementationOnce(async () => {
          // A newly constructed turn has no card and only contributes steering input.
          nextId = 12;
          await record(11);
          await vi.advanceTimersByTimeAsync(4000);
          await activeDraft?.flush();
          expect(activeDraft?.messageId()).toBe(12);
          expect(remove).toHaveBeenCalledWith(123, 10);
          return { queuedFinal: false, deliberateSilentTerminalReply: true };
        });
      await dispatch();
      await vi.runOnlyPendingTimersAsync();
      expect(remove).toHaveBeenCalledWith(123, 14);
      await record(15);
      await vi.runOnlyPendingTimersAsync();
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
