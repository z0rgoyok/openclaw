import { describe, expect, it, vi } from "vitest";
import { createClaudeCliSteering } from "./cli-steering.js";

describe("Claude streaming input custody", () => {
  it("keeps an acknowledged correction active until its own result covers it", async () => {
    const owner = createClaudeCliSteering();
    let uuid = "";
    const dispatched = vi.fn();
    const send = owner.send(
      { text: "correction", assertCurrent() {}, onDispatched: dispatched },
      {
        assertCurrent() {},
        send: async (message) => {
          uuid = String(message.uuid);
        },
        onError: vi.fn(),
      },
    );
    expect(dispatched).toHaveBeenCalledOnce();
    owner.acceptReceipt({ type: "user", isReplay: true, parent_tool_use_id: null, uuid });
    await send;
    owner.acceptResult({ type: "result", user_message_uuids: ["old-input"] });
    expect(owner.hasPendingResult()).toBe(true);
    owner.acceptResult({ type: "result", user_message_uuids: [uuid] });
    expect(owner.hasPendingResult()).toBe(false);
  });

  it("rejects missing receipts when the owning turn closes", async () => {
    const owner = createClaudeCliSteering();
    const pending = owner.send(
      { text: "correction", assertCurrent() {}, onDispatched() {} },
      {
        assertCurrent() {},
        send: async () => {},
        onError: vi.fn(),
      },
    );
    owner.close(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(owner.hasPendingResult()).toBe(false);
  });

  it("checks source authority immediately before dispatch", async () => {
    const owner = createClaudeCliSteering();
    const send = vi.fn(async () => {});
    const onError = vi.fn();
    const onDispatched = vi.fn();
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("source replaced");
      });
    await expect(
      owner.send(
        { text: "correction", assertCurrent, onDispatched },
        {
          assertCurrent,
          send,
          onError,
        },
      ),
    ).rejects.toThrow("source replaced");
    expect(send).not.toHaveBeenCalled();
    expect(onDispatched).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
