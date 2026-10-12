import type { AgentHarnessCompactParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import type { CodexAppServerClient } from "./client.js";
import {
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  getCodexInferenceThread,
  prepareCodexInferenceThreadConfig,
} from "./inference-routing.js";
import { readCodexPreparedResponsesRoute } from "./prepared-responses-route.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

/** Rebind a saved thread to this physical process's already-authorized private transport. */
export async function prepareCodexCompactionInference(params: {
  client: CodexAppServerClient;
  cwd: string;
  baseUrl: string;
  operatorBacked: boolean;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const inference = await prepareCodexInferenceThreadConfig({
    ...params,
    // The saved process's provider ID and relay never confer authority on this process.
    binding: undefined,
    clientId: params.client.getInstanceId(),
    modelProvider: "openai",
  });
  const modelProvider = inference?.config.model_provider;
  if (
    !inference ||
    typeof modelProvider !== "string" ||
    inference.route.upstream !== new URL(params.baseUrl).href
  ) {
    throw new Error("Prepared Codex compaction has no owned inference route; no request was sent.");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    assertCodexInferenceRouteConfig(
      params.client,
      inference.route,
      inference.config,
      modelProvider,
      inference.providers,
    );
  };
  return {
    config: inference.config,
    modelProvider,
    assertCurrent,
    bind: (threadId: string, resumedProvider: string) => {
      assertCurrent();
      if (resumedProvider !== modelProvider) {
        throw new Error(
          "Codex compaction resumed with a different provider; no compaction was sent.",
        );
      }
      bindCodexInferenceThread(params.client, threadId, inference.route, inference.providers);
    },
    assertBound: (threadId: string) => {
      assertCurrent();
      if (getCodexInferenceThread(params.client, threadId) !== inference.route) {
        throw new Error("Codex compaction live thread has no matching owned inference route.");
      }
    },
  };
}

/** Preserve compaction's account binding while preparing the exact configured transport. */
export async function resolveCodexCompactionConnection(
  params: AgentHarnessCompactParams<2>,
  binding: CodexAppServerThreadBinding,
  pluginConfig: unknown,
  agentId: string,
  assertCurrent: () => void,
) {
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let connection: Awaited<ReturnType<typeof resolveCodexBindingAppServerConnection>>;
  try {
    const config = params.config ?? {};
    connection = await resolveCodexBindingAppServerConnection({
      binding,
      authProfileId: requestedAuthProfileId ?? binding.authProfileId,
      pluginConfig,
      config,
      assertCurrent,
      agentDir: resolveAgentDir(config, agentId),
    });
  } catch (error) {
    return {
      result: {
        ok: false as const,
        compacted: false,
        reason: coerceErrorMessage(error),
      },
    };
  }
  const { appServer, usesSupervisionConnection } = connection;
  if (
    !usesSupervisionConnection &&
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    // A session binding belongs to the auth profile that created it; compacting
    // with another profile risks operating on a different Codex account.
    return {
      result: {
        ok: false as const,
        compacted: false,
        reason: "auth profile mismatch for session binding",
      },
    };
  }
  const runtimeAuthPlan = usesSupervisionConnection
    ? undefined
    : (params.runtimeAuthPlan ?? params.runtimePlan?.auth);
  // A user-home app-server keeps its native Codex account; injecting a prepared key
  // would rewrite the CODEX_HOME auth that Codex CLI and Desktop share.
  const usesPreparedApiKey =
    appServer.start.homeScope !== "user" &&
    runtimeAuthPlan?.modelRoute?.authRequirement === "api-key";
  const preparedApiKey = usesPreparedApiKey ? params.resolvedApiKey?.trim() : undefined;
  if (usesPreparedApiKey && !preparedApiKey) {
    return {
      result: {
        ok: false as const,
        compacted: false,
        reason: "Prepared Codex Platform compaction route is missing its resolved API key.",
      },
    };
  }
  const preparedResponsesRoute = usesPreparedApiKey
    ? readCodexPreparedResponsesRoute(runtimeAuthPlan?.modelRoute)
    : undefined;
  return { connection, runtimeAuthPlan, preparedApiKey, preparedResponsesRoute };
}
