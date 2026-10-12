import { isDeepStrictEqual } from "node:util";
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

/** Sparse or flattened overrides cannot add auth or discovery fields to the generated table. */
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
      !isDeepStrictEqual(definition, buildCodexPreparedResponsesProvider(baseUrl))) ||
    Object.keys(config ?? {}).some((key) =>
      key.startsWith(`model_providers.${prepared.providerId}`),
    )
  ) {
    throw new Error("Codex prepared Responses configuration changed; no turn was sent");
  }
}
