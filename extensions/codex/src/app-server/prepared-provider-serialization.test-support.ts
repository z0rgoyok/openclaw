import { buildCodexPreparedResponsesProvider } from "./prepared-responses-route.js";
import type { JsonObject } from "./protocol.js";

/** ModelProviderInfo's config/read representation at Codex 0.158 / 064c6b8. */
export function serializedCodex0158PreparedProvider(baseUrl: string): JsonObject {
  return {
    ...buildCodexPreparedResponsesProvider(baseUrl),
    model_catalog_url: null,
    env_key: null,
    env_key_instructions: null,
    experimental_bearer_token: null,
    auth: null,
    gateway_oauth: null,
    aws: null,
    query_params: null,
    http_headers: null,
    env_http_headers: null,
    request_max_retries: null,
    stream_max_retries: null,
    stream_idle_timeout_ms: null,
    websocket_connect_timeout_ms: null,
  };
}
