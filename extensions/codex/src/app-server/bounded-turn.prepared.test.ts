import { expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";

it("rejects a detached private Responses bounded turn before client or thread creation", async () => {
  const clientFactory = vi.fn<NonNullable<CodexBoundedTurnOptions["clientFactory"]>>();
  const assertCurrent = vi.fn();
  await expect(
    runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "synthetic-model" },
      preparedAuth: { kind: "api-key", apiKey: "synthetic-private-key" },
      authRequirement: "api-key",
      preparedModelRoute: {
        api: "openai-responses",
        baseUrl: "http://192.168.50.10:8080/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
      assertCurrent,
      timeoutMs: 5_000,
      options: { clientFactory },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text", text: "Synthetic prompt.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "private-stdio",
      requireNoExternalCapabilities: true,
    }),
  ).rejects.toThrow("require host source authority");
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(clientFactory).not.toHaveBeenCalled();
});
