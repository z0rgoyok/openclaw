import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderModelRouteAuthRequirement } from "openclaw/plugin-sdk/provider-model-types";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions, ProviderAuthAliasConfig } from "./config-contracts.js";
import type { CodexPreparedModelRoute } from "./prepared-responses-route.js";

export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  pluginConfig?: unknown;
  timeoutMs?: number;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  authBindingFingerprint?: string;
  /** Setup-only generation whose exact local runtime bytes are captured. */
  runtimeArtifactMode?: "capture";
  /** Previously minted exact runtime required before the process may start. */
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  preparedAuth?: CodexAppServerPreparedAuth;
  authRequirement?: ProviderModelRouteAuthRequirement;
  preparedModelRoute?: CodexPreparedModelRoute;
  agentId?: string;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
  onStartedClient?: (client: CodexAppServerClient) => void;
  abandonSignal?: AbortSignal;
  /** Caller authority for startup of an isolated, caller-owned client. */
  assertCurrent?: () => void;
};

/** Factory used by attempt startup and side turns to acquire a leased client. */
export type CodexAppServerClientFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;
