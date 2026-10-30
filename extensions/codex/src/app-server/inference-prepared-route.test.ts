import { describe, expect, it } from "vitest";
import { assertCodexPreparedProviderConfig } from "./inference-prepared-route.js";
import { serializedCodex0158PreparedProvider } from "./prepared-provider-serialization.test-support.js";
import { buildCodexPreparedResponsesProvider } from "./prepared-responses-route.js";
import type { JsonObject } from "./protocol.js";

const prepared = {
  baseUrl: "http://proxy.example.test:8080/v1",
  providerId: "openclaw-prepared-responses-fixture",
};
const config = (definition: JsonObject) => ({
  model_providers: { [prepared.providerId]: definition },
});
const validate = (definition: JsonObject, required = true) =>
  assertCodexPreparedProviderConfig(config(definition), prepared, prepared.baseUrl, required);

describe("prepared provider native serialization contract", () => {
  it("accepts the authored table and the exact pinned native config/read null defaults", () => {
    expect(() => validate(buildCodexPreparedResponsesProvider(prepared.baseUrl))).not.toThrow();
    expect(() => validate(serializedCodex0158PreparedProvider(prepared.baseUrl))).not.toThrow();
  });

  it.each<JsonObject>([
    { name: "OpenAI" },
    { base_url: "https://unapproved.example.test/v1" },
    { wire_api: "chat" },
    { requires_openai_auth: false },
    { supports_websockets: true },
    { supports_standalone_web_search: true },
  ])("rejects changes to the exact generated provider contract: %j", (patch) => {
    expect(() =>
      validate({ ...serializedCodex0158PreparedProvider(prepared.baseUrl), ...patch }),
    ).toThrow("configuration changed");
  });

  it.each<JsonObject>([
    { model_catalog_url: "https://unapproved.example.test/models" },
    { env_key: "SYNTHETIC_PROVIDER_KEY" },
    { env_key_instructions: "synthetic instructions" },
    { experimental_bearer_token: "synthetic-token" },
    { auth: { command: "synthetic-command" } },
    { gateway_oauth: {} },
    { aws: {} },
    { query_params: { route: "changed" } },
    { http_headers: { authorization: "Bearer synthetic" } },
    { env_http_headers: { authorization: "SYNTHETIC_PROVIDER_KEY" } },
    { request_max_retries: 4 },
    { stream_max_retries: 5 },
    { stream_idle_timeout_ms: 300_000 },
    { websocket_connect_timeout_ms: 15_000 },
  ])("rejects every non-null native optional field: %j", (patch) => {
    const definition = { ...serializedCodex0158PreparedProvider(prepared.baseUrl), ...patch };
    expect(() => validate(definition)).toThrow("configuration changed");
    expect(() => validate(definition, false)).toThrow("configuration changed");
  });

  it.each([null, false, 0, "", {}])(
    "rejects unknown fields even when empty/default-like: %j",
    (value) => {
      expect(() =>
        validate({
          ...serializedCodex0158PreparedProvider(prepared.baseUrl),
          unknown_field: value,
        }),
      ).toThrow("configuration changed");
    },
  );

  it("retains physical provider identity, flattened-override and missing-table guards", () => {
    expect(() =>
      assertCodexPreparedProviderConfig({}, prepared, prepared.baseUrl, false),
    ).not.toThrow();
    expect(() => assertCodexPreparedProviderConfig({}, prepared, prepared.baseUrl, true)).toThrow();
    expect(() =>
      assertCodexPreparedProviderConfig(
        {
          model_providers: { other: serializedCodex0158PreparedProvider(prepared.baseUrl) },
        },
        prepared,
        prepared.baseUrl,
        true,
      ),
    ).toThrow();
    expect(() =>
      assertCodexPreparedProviderConfig(
        {
          ...config(serializedCodex0158PreparedProvider(prepared.baseUrl)),
          [`model_providers.${prepared.providerId}.auth`]: null,
        },
        prepared,
        prepared.baseUrl,
        true,
      ),
    ).toThrow();
  });
});
