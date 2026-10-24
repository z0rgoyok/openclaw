import { describe, expect, it, vi } from "vitest";
import {
  createDraftStream,
  createMockDraftApi,
  type MockSentMessage,
} from "./draft-stream.api.test-helpers.js";

describe("Telegram progress card reposition custody", () => {
  it.each(["accepted", "rejected"] as const)(
    "keeps the previous card until replacement is %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const api = createMockDraftApi();
        const stream = createDraftStream(api);
        stream.update("Old tool card");
        await stream.flush();
        expect(api.sendMessage.mock.calls[0]?.[2]?.disable_notification).toBeUndefined();
        let resolve!: (message: MockSentMessage) => void;
        let reject!: (error: Error) => void;
        api.sendMessage.mockReturnValueOnce(
          new Promise<MockSentMessage>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
        );
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Replacement tool card");
        const pending = stream.flush();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.deleteMessage).not.toHaveBeenCalled();
        expect(api.sendMessage.mock.calls[1]?.[2]?.disable_notification).toBe(true);
        if (outcome === "accepted") {
          resolve({ message_id: 42 });
        } else {
          reject(new Error("400: Bad Request: rejected"));
        }
        await pending;
        expect(api.deleteMessage).toHaveBeenCalledTimes(outcome === "accepted" ? 1 : 0);
        if (outcome === "accepted") {
          expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        }
        await stream.clear();
        await vi.runOnlyPendingTimersAsync();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("drains a late superseded send before clear finishes", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      let resolve!: (message: MockSentMessage) => void;
      api.sendMessage.mockReturnValueOnce(
        new Promise<MockSentMessage>((done) => {
          resolve = done;
        }),
      );
      const stream = createDraftStream(api);
      stream.update("Old card");
      await vi.advanceTimersByTimeAsync(0);
      stream.rotateToNewMessageDeferringDelete();
      const clearing = stream.clear();
      resolve({ message_id: 17 });
      await clearing;
      await vi.advanceTimersByTimeAsync(4000);
      expect(api.deleteMessage).toHaveBeenCalledExactlyOnceWith(123, 17);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
