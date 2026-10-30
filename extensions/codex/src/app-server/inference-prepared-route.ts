import {
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  buildCodexPreparedResponsesProvider,
  type CodexPhysicalPreparedResponsesRoute,
  type CodexPreparedResponsesRoute,
} from "./prepared-responses-route.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

// Codex 0.158 (064c6b8), model-provider-info/src/lib.rs:121-182: ConfigToml
// serializes these Option fields as null when the generated CLI table omits them.
const NATIVE_NULL_PROVIDER_FIELDS = new Set([
  "model_catalog_url",
  "env_key",
  "env_key_instructions",
  "experimental_bearer_token",
  "auth",
  "gateway_oauth",
  "aws",
  "query_params",
  "http_headers",
  "env_http_headers",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
]);

function isPreparedProviderDefinition(definition: unknown, baseUrl: string): boolean {
  if (!isJsonObject(definition)) {
    return false;
  }
  const expected = buildCodexPreparedResponsesProvider(baseUrl);
  return (
    Object.entries(expected).every(([field, value]) => definition[field] === value) &&
    Object.entries(definition).every(
      ([field, value]) =>
        Object.hasOwn(expected, field) ||
        (NATIVE_NULL_PROVIDER_FIELDS.has(field) && value === null),
    )
  );
}

/** Private transport access belongs to the exact route captured before native startup. */
export function resolveCodexInferenceUpstreamPolicy(
  upstream: URL,
  prepared: CodexPreparedResponsesRoute | undefined,
  oauth: boolean,
): SsrFPolicy | undefined {
  if (prepared && (oauth || upstream.href !== new URL(prepared.baseUrl).href || upstream.search)) {
    throw new Error("Codex prepared inference route configuration changed");
  }
  if (
    (upstream.protocol !== "https:" && !(prepared && upstream.protocol === "http:")) ||
    upstream.username ||
    upstream.password ||
    upstream.hash
  ) {
    throw new Error("Codex inference requires a credential-free HTTPS upstream URL");
  }
  if (oauth && upstream.href.replace(/\/$/, "") !== "https://api.openai.com/v1") {
    throw new Error("ChatGPT subscription sharing requires the public Responses endpoint");
  }
  const policy = prepared ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(upstream.href) : undefined;
  if (prepared && !policy) {
    throw new Error("Codex prepared inference route configuration is invalid");
  }
  return policy;
}

/** Native serialization may add known nulls; auth, transport and unknown overrides stay closed. */
export function assertCodexPreparedProviderConfig(
  config: JsonObject | undefined,
  prepared: CodexPhysicalPreparedResponsesRoute,
  baseUrl: string,
  required: boolean,
): void {
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : undefined;
  const definition = providers?.[prepared.providerId];
  if (
    ((required || definition !== undefined) &&
      !isPreparedProviderDefinition(definition, baseUrl)) ||
    Object.keys(config ?? {}).some((key) =>
      key.startsWith(`model_providers.${prepared.providerId}`),
    )
  ) {
    throw new Error("Codex prepared Responses configuration changed; no turn was sent");
  }
}
