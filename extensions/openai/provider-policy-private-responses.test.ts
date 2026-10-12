import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelRoutes } from "./provider-policy-api.js";

describe("OpenAI prepared private Responses runtime policy", () => {
  beforeEach(() => vi.stubEnv("OPENAI_BASE_URL", ""));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["http://llm.proxy:8080/v1", "https://relay.example.test/v1"])(
    "allows explicit Codex execution of prepared API Responses at %s without changing the default",
    (baseUrl) => {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-6.1-sol",
          configuredProvider: { api: "openai-responses", baseUrl },
          routeIntent: { runtimeId: "codex", source: "explicit" },
        }),
      ).toMatchObject({
        defaultRuntimeId: "openclaw",
        routes: [
          {
            baseUrl,
            authRequirement: "api-key",
            runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          },
        ],
      });
      expect(
        resolveModelRoutes({
          provider: "openai",
          configuredProvider: { api: "openai-responses", baseUrl },
          requestTransportOverrides: "present",
        }),
      ).toMatchObject({ routes: [{ runtimePolicy: { compatibleIds: ["openclaw"] } }] });
    },
  );
});
