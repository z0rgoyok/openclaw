import { isDeepStrictEqual } from "node:util";
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import { supportsInferenceEnvironment } from "./inference-environment.js";
import { assertCodexPreparedProviderConfig } from "./inference-prepared-route.js";
import {
  configuredProviders,
  hasProviderAws,
  projectProviderRoutes,
  providerKind,
  readProviderBaseUrl,
  readProviderField,
  withProviderBaseUrl,
  type ProviderKind,
} from "./inference-provider-config.js";
import type { CodexInferenceProxy } from "./inference-proxy.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import {
  CODEX_PREPARED_RESPONSES_PROVIDER,
  buildCodexPreparedResponsesProvider,
  type CodexPhysicalPreparedResponsesRoute,
} from "./prepared-responses-route.js";
import { isJsonObject, type CodexConfigReadResponse, type JsonObject } from "./protocol.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER, type CodexResponsesOAuth } from "./responses-oauth.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

export type CodexInferenceProviderRoutes = ReadonlyMap<string, CodexInferenceProxy>;
export type { CodexInferenceThreadQualification } from "./inference-qualification.js";
type ThreadRoutes = {
  route: CodexInferenceProxy;
  providers: CodexInferenceProviderRoutes;
  qualification?: CodexInferenceThreadQualification;
};

type Owner = {
  closed: boolean;
  memoryConfigured: boolean;
  routes: Map<string, Promise<CodexInferenceProxy>>;
  threads: Map<string, ThreadRoutes>;
  handles: Map<
    CodexInferenceProxy,
    { provider: string; kind: ProviderKind; modelPolicyEnforced: boolean }
  >;
  authRoute?: "apiKey" | "chatgpt";
  oauth?: CodexResponsesOAuth;
  preparedResponsesRoute?: CodexPhysicalPreparedResponsesRoute;
};
// Shared clients survive duplicate module loads; their inference ownership must too.
const owners = defineCodexBuildState(
  "openclaw.codexAppServerInferenceOwners",
  () => new WeakMap<CodexAppServerClient, Owner>(),
)();
const MAX_ROUTES = 8;
const MAX_THREADS = 256;

/** Only managed native stdio startup calls this; locality or metadata cannot opt a client in. */
export function ownCodexInferenceClient(
  client: CodexAppServerClient,
  startOptions: Pick<CodexAppServerStartOptions, "env" | "clearEnv"> = {},
  oauth?: CodexResponsesOAuth,
  preparedResponsesRoute?: CodexPhysicalPreparedResponsesRoute,
): void {
  if (owners.has(client)) {
    return;
  }
  if (oauth && preparedResponsesRoute) {
    throw new Error("Codex prepared Responses requires an API-key route");
  }
  // The native transport owns custom trust roots and per-process proxy choices.
  // Leave those profiles native until the relay can preserve the same transport.
  if (!supportsInferenceEnvironment(resolveCodexAppServerSpawnEnv(startOptions))) {
    if (preparedResponsesRoute) {
      throw new Error("Codex prepared Responses requires a compatible managed transport");
    }
    if (oauth) {
      throw new Error(
        "ChatGPT subscription sharing requires the managed public Responses inference route with a compatible proxy and trust configuration.",
      );
    }
    return;
  }
  const owner: Owner = {
    closed: false,
    memoryConfigured: false,
    routes: new Map(),
    threads: new Map(),
    handles: new Map(),
    oauth,
    preparedResponsesRoute,
  };
  owners.set(client, owner);
  const close = () => {
    owner.closed = true;
    owner.threads.clear();
    owner.handles.clear();
    for (const pending of owner.routes.values()) {
      void pending.then(
        (route) => route.close(),
        () => {},
      );
    }
    owner.routes.clear();
  };
  client.addCloseHandler(close);
  client.addNotificationHandler((notification) => {
    if (
      notification.method === "thread/closed" &&
      isJsonObject(notification.params) &&
      typeof notification.params.threadId === "string"
    ) {
      owner.threads.delete(notification.params.threadId);
    }
    if (notification.method !== "account/updated" || !owner.authRoute) {
      return;
    }
    const mode = isJsonObject(notification.params) ? notification.params.authMode : undefined;
    const route =
      mode === "apiKey"
        ? "apiKey"
        : mode === "chatgpt" || mode === "chatgptAuthTokens"
          ? "chatgpt"
          : undefined;
    // Token rotation on the same native route is transparent. Account-mode changes are not.
    if (route !== owner.authRoute) {
      close();
    }
  });
}

/** Resolve logical routing only from the physical client that owns the inference transport. */
export function resolveCodexPreparedResponsesModelProvider(
  client: CodexAppServerClient,
  modelProvider: string | undefined,
): string | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.preparedResponsesRoute &&
    (modelProvider === "openai" || modelProvider === CODEX_PREPARED_RESPONSES_PROVIDER)
    ? owner.preparedResponsesRoute.providerId
    : modelProvider;
}

async function prepareCodexInferenceRoute(params: {
  client: CodexAppServerClient;
  cwd: string;
  modelProvider?: string;
  config?: JsonObject;
  effectiveConfig?: CodexConfigReadResponse;
  modelPolicyEnforced?: boolean;
  optionalProjection?: true;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<CodexInferenceProxy | undefined> {
  const client = params.client;
  const owner = owners.get(client);
  if (!owner) {
    return undefined;
  }
  const assertClient = () => {
    if (owner.closed || owners.get(client) !== owner) {
      throw new Error("Codex inference route ownership changed; reconnect before retrying");
    }
  };
  const assertCurrent = () => {
    assertClient();
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const snapshot =
    params.effectiveConfig ??
    (await readCodexEffectiveConfig(params.client, params.cwd, { signal: params.signal }));
  assertCurrent();
  const unsupported = () => {
    if (owner.preparedResponsesRoute) {
      throw new Error("Codex prepared Responses configuration changed; no turn was sent");
    }
    if (owner.oauth) {
      throw new Error(
        "ChatGPT subscription sharing requires the managed public Responses inference route.",
      );
    }
    return undefined;
  };
  const selectedProvider =
    params.modelProvider ??
    params.config?.model_provider ??
    snapshot.config.model_provider ??
    "openai";
  const prepared = owner.preparedResponsesRoute;
  if (prepared) {
    if (
      (selectedProvider !== "openai" &&
        selectedProvider !== CODEX_PREPARED_RESPONSES_PROVIDER &&
        selectedProvider !== prepared.providerId) ||
      snapshot.config.model_provider !== prepared.providerId ||
      (params.config?.model_provider !== undefined &&
        params.config.model_provider !== "openai" &&
        params.config.model_provider !== CODEX_PREPARED_RESPONSES_PROVIDER &&
        params.config.model_provider !== prepared.providerId)
    ) {
      return unsupported();
    }
    assertCodexPreparedProviderConfig(snapshot.config, prepared, prepared.baseUrl, true);
    assertCodexPreparedProviderConfig(params.config, prepared, prepared.baseUrl, false);
  }
  if (
    owner.oauth &&
    ((snapshot.config.model_provider != null && snapshot.config.model_provider !== "openai") ||
      (selectedProvider !== "openai" && selectedProvider !== CODEX_RESPONSES_OAUTH_PROVIDER))
  ) {
    return unsupported();
  }
  const provider = owner.oauth
    ? CODEX_RESPONSES_OAUTH_PROVIDER
    : prepared
      ? prepared.providerId
      : selectedProvider;
  if (typeof provider !== "string" || !provider.trim()) {
    return unsupported();
  }
  const customProvider = !owner.oauth && provider !== "openai";
  const providerField = (field: string) =>
    readProviderField(params.config, provider, field) ??
    readProviderField(snapshot.config, provider, field);
  const nativeProviderName = owner.oauth
    ? "OpenClaw subscription sharing"
    : customProvider
      ? providerField("name")
      : "OpenAI";
  const kind = providerKind(nativeProviderName);
  const wireApi = customProvider ? providerField("wire_api") : "responses";
  if (
    !kind ||
    (customProvider &&
      (["amazon-bedrock", "amazon-bedrock-runtime", "ollama", "lmstudio"].includes(provider) ||
        hasProviderAws(params.config, provider) ||
        hasProviderAws(snapshot.config, provider) ||
        (wireApi != null && wireApi !== "responses")))
  ) {
    // Native built-ins ignore ordinary provider overrides; SigV4 also signs the URL/body.
    return unsupported();
  }
  // Native system-proxy routing owns its transport, including loopback bypass.
  // Leave that profile intact instead of proxying its private inference IPC.
  const systemProxy =
    params.config?.["features.respect_system_proxy"] ??
    (isJsonObject(params.config?.features)
      ? params.config.features.respect_system_proxy
      : undefined) ??
    (isJsonObject(snapshot.config.features)
      ? snapshot.config.features.respect_system_proxy
      : undefined);
  if (systemProxy === true) {
    return unsupported();
  }
  // Pinned native merges built-ins first: model_providers.openai never replaces OpenAI.
  const configured = customProvider
    ? providerField("base_url")
    : (params.config?.openai_base_url ?? snapshot.config.openai_base_url);
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex inference upstream configuration is invalid");
  }
  if (
    typeof configured === "string" &&
    (!configured.trim() || configured.includes("?") || configured.includes("#"))
  ) {
    return unsupported();
  }
  // The relay preserves the selected Responses provider, including its auth and query fields.
  if (configured) {
    let target: URL;
    try {
      target = new URL(configured);
    } catch {
      return unsupported();
    }
    if (
      (target.protocol !== "https:" && !(prepared && target.protocol === "http:")) ||
      target.username ||
      target.password ||
      target.hash ||
      target.search ||
      (owner.oauth && target.href.replace(/\/$/, "") !== "https://api.openai.com/v1")
    ) {
      return unsupported();
    }
    if (prepared && target.href !== new URL(prepared.baseUrl).href) {
      return unsupported();
    }
  }
  if (customProvider && !configured) {
    return unsupported();
  }
  const configKey = customProvider ? `model_providers.${provider}.base_url` : "openai_base_url";
  const origins = Object.entries(snapshot.origins ?? {}).filter(([key]) =>
    customProvider
      ? key === "model_providers" || key === `model_providers.${provider}` || key === configKey
      : key === configKey,
  );
  if (
    origins.some(
      ([, origin]) => !origin || !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(origin.name.type),
    )
  ) {
    return unsupported();
  }
  const account =
    customProvider && !prepared
      ? undefined
      : await params.client.request(
          "account/read",
          { refreshToken: false },
          {
            signal: params.signal,
            assertCurrent,
          },
        );
  assertCurrent();
  const type = account?.account?.type;
  if (prepared && type !== "apiKey") {
    return unsupported();
  }
  if (owner.oauth && type !== "apiKey") {
    return unsupported();
  }
  if (!customProvider && type !== "apiKey" && type !== "chatgpt") {
    return unsupported();
  }
  if ((!customProvider || prepared) && owner.authRoute && owner.authRoute !== type) {
    throw new Error("Codex native account route changed; reconnect before retrying");
  }
  if (type === "apiKey" || type === "chatgpt") {
    owner.authRoute = type;
  }
  // Pinned native ModelProviderInfo::to_api_provider uses these defaults only without an override.
  // chatgpt_base_url owns other native services; it is not the model-provider base URL.
  const target = new URL(
    configured ||
      (type === "apiKey" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex"),
  );
  const { isBlockedHostnameOrIp } = await import("openclaw/plugin-sdk/ssrf-runtime");
  assertCurrent();
  if (!prepared && isBlockedHostnameOrIp(target.hostname)) {
    return unsupported();
  }
  // Native 0.154 also recognizes Azure by URL substrings; loopback must preserve that fact.
  const nativeBaseUrl = typeof configured === "string" ? configured.toLowerCase() : target.href;
  const preserveAzureUrlFeatures =
    (typeof nativeProviderName === "string" && nativeProviderName.toLowerCase() === "azure") ||
    [
      "openai.azure.",
      "cognitiveservices.azure.",
      "aoai.azure.",
      "azure-api.",
      "azurefd.",
      "windows.net/openai",
    ].some((marker) => nativeBaseUrl.includes(marker));
  const preserveCodexBackendRoutes =
    nativeProviderName === "OpenAI" &&
    (configured == null || configured.replace(/\/+$/, "").endsWith("/backend-api/codex"));
  const memoryFeature =
    params.config?.["features.memories"] ??
    (isJsonObject(params.config?.features) ? params.config.features.memories : undefined) ??
    (isJsonObject(snapshot.config.features) ? snapshot.config.features.memories : undefined);
  // A configured native startup service may outlive the foreground that created its thread.
  // generate_memories controls new thread recording, not processing of eligible prior history.
  owner.memoryConfigured ||= memoryFeature === true;
  const modelPolicyEnforced = params.modelPolicyEnforced !== false;
  const key = JSON.stringify([
    provider,
    target.toString(),
    kind,
    preserveAzureUrlFeatures,
    preserveCodexBackendRoutes,
    modelPolicyEnforced,
  ]);
  let pending = owner.routes.get(key);
  if (!pending) {
    if (owner.routes.size >= MAX_ROUTES) {
      if (params.optionalProjection) {
        return unsupported();
      }
      throw new Error(
        "Codex inference route limit reached; start a fresh managed native connection before retrying.",
      );
    }
    pending = Promise.all([
      import("./inference-proxy.js"),
      import("./native-subagent-monitor.js"),
      import("./inference-dispatch.js"),
    ]).then(([{ createCodexInferenceProxy }, native, { createCodexInferenceModelBinding }]) => {
      assertClient();
      return createCodexInferenceProxy({
        upstream: target,
        assertCurrent: assertClient,
        oauth: owner.oauth,
        preparedResponsesRoute: prepared,
        preserveAzureUrlFeatures,
        preserveCodexBackendRoutes,
        bindModelExecution: createCodexInferenceModelBinding({
          client,
          provider,
          ...(prepared ? { logicalProvider: "openai" } : {}),
          modelPolicyEnforced,
          assertCurrent: assertClient,
          memoryConfigured: () => owner.memoryConfigured,
          captureModelSource: native.codexNativeSubagentMonitorRuntime.captureModelSource,
          resolveModelThreadId: native.codexNativeSubagentMonitorRuntime.resolveModelThreadId,
        }),
      });
    });
    // Keep a failed route failed for this physical client; never fall back to unmodified inference.
    owner.routes.set(key, pending);
  }
  const route = await pending;
  assertCurrent();
  route.assertCurrent();
  params.client.protectPrivateTransportSecret(new URL(route.baseUrl).pathname.split("/")[1] ?? "");
  owner.handles.set(route, { provider, kind, modelPolicyEnforced });
  return route;
}

/** Prepare a managed thread without changing an attached or unsupported native profile. */
export async function prepareCodexInferenceThreadConfig(params: {
  client: CodexAppServerClient;
  binding: CodexAppServerThreadBinding | undefined;
  clientId: string;
  cwd: string;
  config?: JsonObject;
  modelProvider?: string;
  effectiveConfig?: CodexConfigReadResponse;
  /** Captured from the issuing host, never from native request metadata. */
  operatorBacked?: boolean;
  /** Parent context still uses this transport when optional native model hooks are unavailable. */
  modelPolicyEnforced?: boolean;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<
  | { route: CodexInferenceProxy; config: JsonObject; providers?: CodexInferenceProviderRoutes }
  | undefined
> {
  const { binding } = params;
  const owner = owners.get(params.client);
  if (!owner) {
    return undefined;
  }
  if (owner.closed) {
    throw new Error("Codex inference route ownership changed; reconnect before retrying");
  }
  const preserved =
    binding?.connectionScope === "supervision" || binding?.preserveNativeModel === true;
  let retained =
    preserved && binding?.clientId === params.clientId
      ? owner.threads.get(binding.threadId)
      : undefined;
  if (preserved) {
    if (owner.oauth) {
      throw new Error("ChatGPT subscription sharing cannot attach to a native Codex thread.");
    }
    // An attachment cannot confer ownership; an already-owned route can remain in use.
    if (!retained) {
      return undefined;
    }
    retained.route.assertCurrent();
    if (
      owner.handles.get(retained.route)?.modelPolicyEnforced !==
      (params.modelPolicyEnforced !== false)
    ) {
      retained = undefined;
    } else if (!params.operatorBacked) {
      return {
        route: retained.route,
        providers: retained.providers,
        config: projectProviderRoutes(params.config, retained.providers),
      };
    }
  }
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const effectiveConfig =
    params.effectiveConfig ??
    (await readCodexEffectiveConfig(params.client, params.cwd, { signal: params.signal }));
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const route =
    retained?.route ?? (await prepareCodexInferenceRoute({ ...params, effectiveConfig }));
  if (!route) {
    return undefined;
  }
  if (
    binding?.clientId === params.clientId &&
    !getCodexInferenceThread(params.client, binding.threadId)
  ) {
    const { thread } = await params.client.request(
      "thread/read",
      { threadId: binding.threadId, includeTurns: false },
      { signal: params.signal, assertCurrent: params.assertCurrent },
    );
    params.assertCurrent();
    if (thread.id !== binding.threadId || thread.status?.type !== "notLoaded") {
      throw new Error(
        "Codex loaded thread has no owned inference route; reconnect before retrying",
      );
    }
  }
  const provider = owner.handles.get(route)?.provider;
  if (!provider) {
    throw new Error("Codex inference provider ownership changed");
  }
  if (owner.oauth) {
    return {
      route,
      config: {
        ...params.config,
        model_provider: CODEX_RESPONSES_OAUTH_PROVIDER,
        model_providers: { [CODEX_RESPONSES_OAUTH_PROVIDER]: responsesOAuthProvider(route) },
      },
    };
  }
  if (owner.preparedResponsesRoute) {
    return {
      route,
      config: {
        ...params.config,
        model_provider: owner.preparedResponsesRoute.providerId,
        model_providers: {
          [owner.preparedResponsesRoute.providerId]: buildCodexPreparedResponsesProvider(
            route.baseUrl,
          ),
        },
      },
    };
  }
  if (!params.operatorBacked) {
    return { route, config: withProviderBaseUrl(params.config, provider, route.baseUrl) };
  }
  const providers = new Map(retained?.providers ?? [[provider, route]]);
  // Restoring native work can select any stored provider from this parent configuration.
  // Reuse one config/account view; only URLs are projected, never credentials or query fields.
  for (const candidate of configuredProviders(effectiveConfig.config, params.config)) {
    if (providers.has(candidate)) {
      continue;
    }
    const sibling = await prepareCodexInferenceRoute({
      ...params,
      effectiveConfig,
      modelProvider: candidate,
      optionalProjection: true,
    });
    if (sibling) {
      providers.set(candidate, sibling);
    }
  }
  return { route, config: projectProviderRoutes(params.config, providers), providers };
}

function responsesOAuthProvider(route: CodexInferenceProxy): JsonObject {
  return {
    name: "OpenClaw subscription sharing",
    base_url: route.baseUrl,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
  };
}

/** Validate the exact private handle and unchanged upstream, not a localhost string exception. */
export function assertCodexInferenceRouteConfig(
  client: CodexAppServerClient,
  route: CodexInferenceProxy | undefined,
  config: JsonObject | undefined,
  modelProvider?: string,
  providers?: CodexInferenceProviderRoutes,
): void {
  if (!route) {
    return;
  }
  const owner = owners.get(client);
  const definition = owner?.handles.get(route);
  const provider = definition?.provider;
  const requestedProvider = modelProvider ?? config?.model_provider ?? provider;
  if (requestedProvider !== undefined && typeof requestedProvider !== "string") {
    throw new Error("Codex parent-local inference route was overridden; no turn was sent");
  }
  const selectedProvider = resolveCodexPreparedResponsesModelProvider(client, requestedProvider);
  const systemProxy =
    config?.["features.respect_system_proxy"] ??
    (isJsonObject(config?.features) ? config.features.respect_system_proxy : undefined);
  if (
    !owner ||
    owner.closed ||
    !provider ||
    selectedProvider !== provider ||
    systemProxy === true ||
    readProviderBaseUrl(config, provider) !== route.baseUrl
  ) {
    throw new Error("Codex parent-local inference route was overridden; no turn was sent");
  }
  if (owner.preparedResponsesRoute) {
    if (config?.model_provider !== owner.preparedResponsesRoute.providerId) {
      throw new Error("Codex prepared Responses configuration changed; no turn was sent");
    }
    assertCodexPreparedProviderConfig(config, owner.preparedResponsesRoute, route.baseUrl, true);
  }
  if (
    owner.oauth &&
    (config?.model_provider !== CODEX_RESPONSES_OAUTH_PROVIDER ||
      !isJsonObject(config?.model_providers) ||
      !isDeepStrictEqual(
        config.model_providers[CODEX_RESPONSES_OAUTH_PROVIDER],
        responsesOAuthProvider(route),
      ) ||
      Object.keys(config).some((key) =>
        key.startsWith(`model_providers.${CODEX_RESPONSES_OAUTH_PROVIDER}`),
      ))
  ) {
    throw new Error("Codex parent-local inference route was overridden; no turn was sent");
  }
  route.assertCurrent();
  for (const [candidate, sibling] of providers ?? [[provider, route] as const]) {
    const siblingDefinition = owner.handles.get(sibling);
    const name = readProviderField(config, candidate, "name");
    const wireApi = readProviderField(config, candidate, "wire_api");
    if (
      siblingDefinition?.provider !== candidate ||
      readProviderBaseUrl(config, candidate) !== sibling.baseUrl ||
      (candidate !== "openai" &&
        ((name !== undefined && providerKind(name) !== siblingDefinition.kind) ||
          (wireApi !== undefined && wireApi !== "responses") ||
          hasProviderAws(config, candidate)))
    ) {
      throw new Error("Codex native provider inference route was overridden; no turn was sent");
    }
    sibling.assertCurrent();
  }
}

export function bindCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
  route: CodexInferenceProxy | undefined,
  providers?: CodexInferenceProviderRoutes,
): void {
  const owner = owners.get(client);
  if (!owner && !route) {
    return;
  }
  if (!owner || owner.closed) {
    throw new Error("Codex inference client is closed");
  }
  if (!route) {
    owner.threads.delete(threadId);
    return;
  }
  route.assertCurrent();
  const provider = owner.handles.get(route)?.provider;
  if (!provider) {
    throw new Error("Codex inference provider ownership changed");
  }
  if (!owner.threads.has(threadId) && owner.threads.size >= MAX_THREADS) {
    throw new Error("Codex inference thread limit reached; reconnect before retrying");
  }
  const projected = new Map(providers ?? [[provider, route]]);
  if (projected.get(provider) !== route) {
    throw new Error("Codex inference provider ownership changed");
  }
  const assertCurrent = () => {
    if (owner.closed || owners.get(client) !== owner) {
      throw new Error("Codex inference client is closed");
    }
    for (const [candidate, routed] of projected) {
      if (owner.handles.get(routed)?.provider !== candidate) {
        throw new Error("Codex inference provider ownership changed");
      }
      routed.assertCurrent();
    }
  };
  assertCurrent();
  // Older native children retain their configuration snapshot even if the parent later changes.
  const qualification = owner.handles.get(route)?.modelPolicyEnforced
    ? Object.freeze({
        assertCurrent,
        hasProvider: (candidate: string) => {
          assertCurrent();
          const projectedRoute = projected.get(candidate);
          return (
            projectedRoute !== undefined &&
            owner.handles.get(projectedRoute)?.modelPolicyEnforced === true
          );
        },
      })
    : undefined;
  owner.threads.set(threadId, { route, providers: projected, qualification });
}

export function getCodexInferenceThread(
  client: CodexAppServerClient,
  threadId: string,
): CodexInferenceProxy | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.threads.get(threadId)?.route;
}

/** Configuration provenance for native restore admission, independent of the input's source. */
export function getCodexInferenceThreadQualification(
  client: CodexAppServerClient,
  threadId: string,
): CodexInferenceThreadQualification | undefined {
  const owner = owners.get(client);
  if (owner?.closed) {
    throw new Error("Codex inference client is closed");
  }
  return owner?.threads.get(threadId)?.qualification;
}
