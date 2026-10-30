import type { AgentHarnessSideQuestionParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import {
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  getCodexInferenceThreadQualification,
  prepareCodexInferenceThreadConfig,
} from "./inference-routing.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  CODEX_PREPARED_RESPONSES_PROVIDER,
  readCodexPreparedResponsesRoute,
} from "./prepared-responses-route.js";
import type { JsonObject } from "./protocol.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

/** A side turn retains its own admitted source after the parent foreground has finished. */
export function createCodexSidePreparedModelAdmission(
  params: AgentHarnessSideQuestionParamsV2,
  nativeModel: string,
  context: { agentId: string; signal: AbortSignal; assertCurrent: () => void },
) {
  if (!readCodexPreparedResponsesRoute(params.preparedRuntimeAuth.plan.modelRoute)) {
    return undefined;
  }
  if (!params.hostCapabilities.retainSourceAuthority) {
    throw new Error(
      "Codex /btw on a prepared Responses route requires an admitted side model source; no side thread was created.",
    );
  }
  const source = params.hostCapabilities.retainSourceAuthority();
  let transferred = false;
  let registration:
    | Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>
    | undefined;
  let prepared: Awaited<ReturnType<typeof prepareCodexInferenceThreadConfig>>;
  let preparedClient: CodexAppServerClient | undefined;
  let nativeProvider: string | undefined;
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    params.hostCapabilities.assertActive();
    context.assertCurrent();
    source?.assertCurrent();
  };
  const assertPrepared = () => {
    assertCurrent();
    if (!preparedClient || !prepared) {
      throw new Error("Codex side inference route was not prepared");
    }
    assertCodexInferenceRouteConfig(
      preparedClient,
      prepared.route,
      prepared.config,
      nativeProvider,
      prepared.providers,
    );
  };
  return {
    async prepare(client: CodexAppServerClient, cwd: string, config: JsonObject | undefined) {
      assertCurrent();
      prepared = await prepareCodexInferenceThreadConfig({
        client,
        cwd,
        config,
        binding: undefined,
        clientId: client.getInstanceId(),
        modelProvider: CODEX_PREPARED_RESPONSES_PROVIDER,
        operatorBacked: source !== undefined,
        signal: context.signal,
        assertCurrent,
      });
      assertCurrent();
      if (!prepared || typeof prepared.config.model_provider !== "string") {
        throw new Error(
          "Codex /btw could not preserve its prepared Responses route; no side thread was created.",
        );
      }
      preparedClient = client;
      nativeProvider = prepared.config.model_provider;
      return { config: prepared.config, modelProvider: nativeProvider };
    },
    assertCurrent: assertPrepared,
    async publish(
      client: CodexAppServerClient,
      threadId: string,
      returnedProvider: string | null | undefined,
    ) {
      assertPrepared();
      if (returnedProvider !== nativeProvider) {
        throw new Error(
          "Codex side fork did not preserve its prepared Responses provider; no turn was sent.",
        );
      }
      if (client !== preparedClient || !prepared) {
        throw new Error("Codex side inference client changed");
      }
      bindCodexInferenceThread(client, threadId, prepared.route, prepared.providers);
      registration = await codexNativeSubagentMonitorRuntime.register({
        client,
        parentThreadId: threadId,
        modelSource: source,
        configurationQualification: getCodexInferenceThreadQualification(client, threadId),
        requesterSessionKey: params.sessionKey,
        agentId: context.agentId,
        assertCurrent,
        retainClient: () => retainSharedCodexAppServerClientIfCurrent(client),
        retainParentThread: (parentThreadId) =>
          protectCodexAppServerLiveThread(client, parentThreadId),
      });
      transferred = true;
      await registration.ready;
      assertCurrent();
    },
    bindTurn(turnId: string) {
      assertCurrent();
      if (!registration || !nativeProvider) {
        throw new Error("Codex side model source was not registered");
      }
      registration.bindTurn(turnId, {
        nativeModel: { provider: nativeProvider, model: nativeModel },
        authorizedModel: { provider: params.provider, model: params.model },
      });
    },
    async release() {
      try {
        await registration?.unregister();
      } finally {
        if (!transferred) {
          source?.release();
        }
      }
    },
  };
}

export type CodexSidePreparedModelAdmission = ReturnType<
  typeof createCodexSidePreparedModelAdmission
>;
