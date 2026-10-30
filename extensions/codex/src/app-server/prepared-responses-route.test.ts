import { describe, expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import {
  CODEX_PREPARED_RESPONSES_PROVIDER,
  canonicalCodexPreparedResponsesArtifactStart,
  createCodexPreparedResponsesPhysicalStart,
  prepareCodexResponsesStartOptions,
  readCodexPreparedResponsesRoute,
  type CodexPreparedModelRoute,
} from "./prepared-responses-route.js";
import { resolveCodexAppServerSpawnIdentity } from "./spawn-identity.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";

const route: CodexPreparedModelRoute = {
  api: "openai-responses",
  baseUrl: "http://llm.proxy:8080/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
};
const startOptions: CodexAppServerStartOptions = {
  transport: "stdio",
  homeScope: "agent",
  command: "codex",
  commandSource: "managed",
  args: ["app-server"],
  headers: {},
};

describe("prepared custom Codex Responses routes", () => {
  it("replaces a prior-process native provider binding using the current host-owned prepared route", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "openai",
        homeScope: "agent",
        model: "catalog-model",
        binding: {
          threadId: "existing-thread",
          model: "catalog-model",
          modelProvider: "openclaw-prepared-responses-prior-process",
        },
        preparedModelRoute: route,
      }),
    ).toEqual({ model: "catalog-model", modelProvider: CODEX_PREPARED_RESPONSES_PROVIDER });
  });

  it.each([
    { api: "openai-completions" },
    { authRequirement: "subscription" },
    { requestTransportOverrides: "present" },
    { baseUrl: "http://user:password@llm.proxy/v1" },
    { baseUrl: "http://llm.proxy/v1?key=secret" },
    { baseUrl: "http://llm.proxy/v1#fragment" },
    { baseUrl: "file:///tmp/provider" },
  ] satisfies Partial<CodexPreparedModelRoute>[])("rejects unrepresentable routes %j", (patch) => {
    expect(() => readCodexPreparedResponsesRoute({ ...route, ...patch })).toThrow();
  });

  it.each([
    { homeScope: "user" },
    { transport: "websocket" },
    { commandSource: "config" },
    { args: ["app-server", "proxy", "--url", "ws://127.0.0.1:1234"] },
  ] satisfies Partial<CodexAppServerStartOptions>[])("rejects unowned placements %j", (patch) => {
    expect(() =>
      prepareCodexResponsesStartOptions({
        startOptions: { ...startOptions, ...patch },
        modelRoute: route,
        preparedAuth: { kind: "api-key", apiKey: "synthetic" },
      }),
    ).toThrow("isolated managed local process");
  });

  it.each([
    "https://api.openai.com:8443/custom",
    "http://api.openai.com/v1",
    "https://api.openai.com/custom",
    "https://chatgpt.com/custom",
  ])("projects an exact custom route on an official hostname: %s", (baseUrl) => {
    const prepared = prepareCodexResponsesStartOptions({
      startOptions,
      modelRoute: { ...route, baseUrl },
      preparedAuth: { kind: "api-key", apiKey: "synthetic" },
    });
    expect(prepared.route).toEqual({ baseUrl });
    if (!prepared.route) {
      throw new Error("Missing prepared custom route");
    }
    expect(
      createCodexPreparedResponsesPhysicalStart(
        prepared.startOptions,
        prepared.route,
      ).startOptions.args.join(" "),
    ).toContain(baseUrl);
  });

  it.each([
    {
      api: "openai-chatgpt-responses",
      authRequirement: "subscription",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      api: "openai-responses",
      authRequirement: "api-key",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
    {
      api: "openai-responses",
      authRequirement: "api-key",
      requestTransportOverrides: "present",
      baseUrl: "https://api.openai.com/v1",
    },
  ] satisfies Partial<CodexPreparedModelRoute>[])(
    "never treats a mismatched official transport as native: %j",
    (patch) => {
      expect(() => readCodexPreparedResponsesRoute({ ...route, ...patch })).toThrow();
    },
  );

  it("mints a fresh provider for each physical process while retaining logical request identity", () => {
    const prepared = { baseUrl: route.baseUrl };
    const first = createCodexPreparedResponsesPhysicalStart(startOptions, prepared);
    const reconnect = createCodexPreparedResponsesPhysicalStart(startOptions, prepared);
    expect(first.route.providerId).not.toBe(reconnect.route.providerId);
    expect(first.route.baseUrl).toBe(reconnect.route.baseUrl);
    expect(reconnect.startOptions.args.join(" ")).not.toContain(first.route.providerId);
  });

  it("retains artifact identity across physical reconnects while distinguishing upstream URLs", () => {
    const first = createCodexPreparedResponsesPhysicalStart(startOptions, {
      baseUrl: route.baseUrl,
    });
    const reconnect = createCodexPreparedResponsesPhysicalStart(startOptions, {
      baseUrl: route.baseUrl,
    });
    const changed = createCodexPreparedResponsesPhysicalStart(startOptions, {
      baseUrl: "http://llm.proxy:8081/v1",
    });
    const identity = (start: typeof first) =>
      resolveCodexAppServerSpawnIdentity(
        canonicalCodexPreparedResponsesArtifactStart(start.startOptions, start.route),
      ).argsFingerprint;
    expect(identity(first)).toBe(identity(reconnect));
    expect(identity(first)).not.toBe(identity(changed));
    expect(first.startOptions.args.join(" ")).toContain(first.route.providerId);
    expect(reconnect.startOptions.args.join(" ")).toContain(reconnect.route.providerId);
  });

  it("requires the already prepared key and preserves ordinary official startup", () => {
    expect(() => prepareCodexResponsesStartOptions({ startOptions, modelRoute: route })).toThrow(
      "prepared API key",
    );
    expect(
      prepareCodexResponsesStartOptions({
        startOptions,
        modelRoute: { ...route, baseUrl: "https://api.openai.com/v1" },
      }),
    ).toEqual({ startOptions });
  });
});
