import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderModelRouteCandidate } from "openclaw/plugin-sdk/provider-model-types";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { isCodexAppServerProxyLaunch, normalizeCodexAppServerArgs } from "./launch-args.js";
import type { JsonObject } from "./protocol.js";

// Host planning uses this marker; every physical process receives a fresh native provider ID.
export const CODEX_PREPARED_RESPONSES_PROVIDER = "openclaw-prepared-responses";
export type CodexPreparedResponsesRoute = Readonly<{ baseUrl: string }>;
export type CodexPhysicalPreparedResponsesRoute = CodexPreparedResponsesRoute &
  Readonly<{ providerId: string }>;
export type CodexPreparedModelRoute = Pick<
  ProviderModelRouteCandidate,
  "api" | "baseUrl" | "authRequirement" | "requestTransportOverrides"
>;

function nativeEndpointKind(url: URL): "platform" | "chatgpt" | undefined {
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "api.openai.com" && ["/", "/v1", "/v1/"].includes(url.pathname)) {
    return "platform";
  }
  if (
    host === "chatgpt.com" &&
    [
      "/backend-api",
      "/backend-api/",
      "/backend-api/v1",
      "/backend-api/v1/",
      "/backend-api/codex",
      "/backend-api/codex/",
      "/backend-api/codex/v1",
      "/backend-api/codex/v1/",
      "/backend-api/codex/responses",
      "/backend-api/codex/responses/",
    ].includes(url.pathname)
  ) {
    return "chatgpt";
  }
  return undefined;
}

/** Authored endpoint catalogs belong to the provider; native account discovery cannot replace them. */
export function hasAuthoredCodexCustomEndpoint(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sources: { baseUrl?: unknown; api?: string }[] = [{ baseUrl: env.OPENAI_BASE_URL }];
  for (const [provider, configured] of Object.entries(config.models?.providers ?? {})) {
    if (provider.trim().toLowerCase() === "openai" && configured) {
      sources.push(
        { baseUrl: configured.baseUrl, api: configured.api },
        ...(configured.models ?? []).map((model) => ({
          baseUrl: model.baseUrl,
          api: model.api ?? configured.api,
        })),
      );
    }
  }
  return sources.some(({ baseUrl, api }) => {
    if (baseUrl === undefined || baseUrl === null || baseUrl === "") {
      return false;
    }
    if (typeof baseUrl !== "string") {
      return true;
    }
    try {
      const kind = nativeEndpointKind(new URL(baseUrl));
      return (
        kind === undefined ||
        (api !== undefined &&
          api !== (kind === "platform" ? "openai-responses" : "openai-chatgpt-responses"))
      );
    } catch {
      // Invalid authored configuration must not trigger discovery on a default account.
      return true;
    }
  });
}

/** Native defaults remain authoritative only for official, unchanged transports. */
export function readCodexPreparedResponsesRoute(
  route: CodexPreparedModelRoute | undefined,
): CodexPreparedResponsesRoute | undefined {
  if (!route) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(route.baseUrl);
  } catch {
    throw new Error("Prepared Codex provider route requires an absolute HTTP Responses URL.");
  }
  const kind = nativeEndpointKind(url);
  if (
    route.requestTransportOverrides === "none" &&
    ((kind === "platform" &&
      route.api === "openai-responses" &&
      route.authRequirement === "api-key") ||
      (kind === "chatgpt" &&
        route.api === "openai-chatgpt-responses" &&
        route.authRequirement === "subscription"))
  ) {
    return undefined;
  }
  if (kind !== undefined) {
    throw new Error(
      "Prepared Codex route does not match the official endpoint transport and authentication.",
    );
  }
  if (
    route.api !== "openai-responses" ||
    route.authRequirement !== "api-key" ||
    route.requestTransportOverrides !== "none" ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    route.baseUrl.includes("?") ||
    route.baseUrl.includes("#")
  ) {
    throw new Error("Codex cannot reproduce this prepared custom provider route.");
  }
  return Object.freeze({ baseUrl: route.baseUrl });
}

export function buildCodexPreparedResponsesProvider(baseUrl: string): JsonObject {
  return {
    name: "OpenClaw prepared Responses",
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    supports_standalone_web_search: false,
  };
}

/** Project before process startup; initialization and catalog refresh must retain the route. */
export function prepareCodexResponsesStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  modelRoute?: CodexPreparedModelRoute;
  preparedAuth?: CodexAppServerPreparedAuth;
}): { startOptions: CodexAppServerStartOptions; route?: CodexPreparedResponsesRoute } {
  const route = readCodexPreparedResponsesRoute(params.modelRoute);
  if (!route) {
    return { startOptions: params.startOptions };
  }
  const start = params.startOptions;
  if (
    start.transport !== "stdio" ||
    start.homeScope === "user" ||
    !["managed", "resolved-managed"].includes(start.commandSource ?? "") ||
    isCodexAppServerProxyLaunch(start.args) ||
    params.preparedAuth?.kind !== "api-key" ||
    !params.preparedAuth.apiKey.trim()
  ) {
    throw new Error(
      "Prepared custom Codex Responses routes require an isolated managed local process and a prepared API key.",
    );
  }
  return { startOptions: start, route };
}

/** Mint only at physical startup; recursive native merges cannot reuse a prior provider table. */
export function createCodexPreparedResponsesPhysicalStart(
  start: CodexAppServerStartOptions,
  route: CodexPreparedResponsesRoute,
): { startOptions: CodexAppServerStartOptions; route: CodexPhysicalPreparedResponsesRoute } {
  const physicalRoute = Object.freeze({
    ...route,
    providerId: `${CODEX_PREPARED_RESPONSES_PROVIDER}-${randomUUID()}`,
  });
  let args = normalizeCodexAppServerArgs(
    start.args,
    `model_provider=${JSON.stringify(physicalRoute.providerId)}`,
  );
  const table = Object.entries(buildCodexPreparedResponsesProvider(route.baseUrl))
    .map(([field, value]) => `${field} = ${JSON.stringify(value)}`)
    .join(", ");
  args = normalizeCodexAppServerArgs(
    args,
    `model_providers.${physicalRoute.providerId}={ ${table} }`,
  );
  args = normalizeCodexAppServerArgs(args, "features.api_key_model_discovery=false");
  return { startOptions: { ...start, args }, route: physicalRoute };
}

/** Artifact identity includes the exact route and options, independent of its physical nonce. */
export function canonicalCodexPreparedResponsesArtifactStart(
  start: CodexAppServerStartOptions,
  route: CodexPhysicalPreparedResponsesRoute,
): CodexAppServerStartOptions {
  const providerSelection = `model_provider=${JSON.stringify(route.providerId)}`;
  const providerTable = `model_providers.${route.providerId}=`;
  return {
    ...start,
    args: start.args.map((arg) => {
      if (arg === providerSelection) {
        return `model_provider=${JSON.stringify(CODEX_PREPARED_RESPONSES_PROVIDER)}`;
      }
      return arg.startsWith(providerTable)
        ? `model_providers.${CODEX_PREPARED_RESPONSES_PROVIDER}=${arg.slice(providerTable.length)}`
        : arg;
    }),
  };
}
