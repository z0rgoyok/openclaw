import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makePrivateTextContext,
  telegramBotInfoForTest,
} from "./bot.create-telegram-bot.test-support.js";
import { runTelegramTestMiddlewareChain, type TelegramTestContext } from "./bot.test-helpers.js";

const { middlewareUseSpy, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { runWithTelegramUpdateProcessingFrame, runWithTelegramSpooledReplayUpdate } =
  await import("./bot-processing-outcome.js");
const { resetPluginStateStoreForTests } =
  await import("openclaw/plugin-sdk/plugin-state-test-runtime");
const { resetTelegramAccountThrottlersForTest } = await import("./runtime.test-support.js");

function runTelegramMiddlewareChain(params: {
  ctx: TelegramTestContext;
  finalHandler: (ctx: TelegramTestContext) => Promise<void>;
}) {
  return runTelegramTestMiddlewareChain(middlewareUseSpy, params.ctx, params.finalHandler);
}

describe("Telegram replay outcomes", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "telegram-replay-outcomes" });
    resetTelegramAccountThrottlersForTest();
    resetPluginStateStoreForTests({ closeDatabase: false });
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  it("keeps a duplicate pending replay retryable until its earlier handler settles", async () => {
    await createTelegramBotCore({
      token: "tok",
      botInfo: telegramBotInfoForTest,
      telegramDeps: telegramBotDepsForTest,
    });
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const ctx = makePrivateTextContext({
      updateId: 11,
      messageId: 11,
      chatId: 7,
      text: "continue",
    });
    const first = runTelegramMiddlewareChain({
      ctx,
      finalHandler: async () => {
        started.resolve();
        await release.promise;
      },
    });
    try {
      await started.promise;
      const duplicateHandler = vi.fn(async () => {});
      const pending = await runWithTelegramUpdateProcessingFrame(() =>
        runWithTelegramSpooledReplayUpdate(ctx.update!, () =>
          runTelegramMiddlewareChain({ ctx, finalHandler: duplicateHandler }),
        ),
      );
      expect(pending.result).toMatchObject({ kind: "failed-retryable" });
      expect(duplicateHandler).not.toHaveBeenCalled();
      release.resolve();
      await first;
      const completed = await runWithTelegramUpdateProcessingFrame(() =>
        runWithTelegramSpooledReplayUpdate(ctx.update!, () =>
          runTelegramMiddlewareChain({ ctx, finalHandler: duplicateHandler }),
        ),
      );
      expect(completed.result).toEqual({ kind: "skipped" });
      expect(duplicateHandler).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await first;
    }
  });
});
