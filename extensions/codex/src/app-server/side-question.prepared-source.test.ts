import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { buildCodexPreparedResponsesProvider } from "./prepared-responses-route.js";
import {
  agentDelta,
  createFakeClient,
  getSharedCodexAppServerClientMock,
  platformPreparedRuntimeAuth,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  threadResult,
  turnCompleted,
  useSideQuestionTestSetup,
} from "./side-question.test-support.js";

describe("prepared Responses side source authority", () => {
  useSideQuestionTestSetup();

  it.each([false, true])(
    "retains the side operator source after parent cleanup and rejects a changed fork provider (%s)",
    async (changedProvider) => {
      for (const key of [
        "CODEX_CA_CERTIFICATE",
        "SSL_CERT_FILE",
        "REQUEST_METHOD",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
      ]) {
        vi.stubEnv(key, undefined);
      }
      const started = createDeferred<void>();
      const client = createFakeClient({ completeTurn: false, onTurnStart: started.resolve });
      onTestFinished(() => client.close());
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const baseUrl = "http://llm.proxy:8080/v1";
      const providerId = "openclaw-prepared-responses-side-source-fixture";
      ownCodexInferenceClient(client, {}, undefined, { baseUrl, providerId });
      const request = client.request.getMockImplementation();
      if (!request) {
        throw new Error("Missing native side fixture");
      }
      client.request.mockImplementation(async (method, params) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
        }
        if (method === "config/read") {
          return {
            config: {
              model_provider: providerId,
              model_providers: { [providerId]: buildCodexPreparedResponsesProvider(baseUrl) },
            },
            origins: {},
          };
        }
        if (method === "thread/fork") {
          const response = threadResult("side-thread");
          return {
            ...response,
            modelProvider: changedProvider ? "openai" : providerId,
            thread: { ...response.thread, modelProvider: changedProvider ? "openai" : providerId },
          };
        }
        return request(method, params);
      });
      const host = await createAgentHarnessHostCapabilitiesForTest({
        attempt: {
          runId: "private-side-source",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
        pluginId: "codex",
        nativeModelPolicySupport: "exact",
        operatorSource: {
          profileId: "side-model-policy",
          scopes: ["operator.write"],
          assertCurrent: () => {},
          modelPolicy: {
            models: [{ provider: "openai", model: "gpt-5.5" }],
            allows: (ref) => ref.provider === "openai" && ref.model === "gpt-5.5",
          },
        },
      });
      onTestFinished(host.close);
      const parent = await codexNativeSubagentMonitorRuntime.register({
        client,
        parentThreadId: "parent-thread",
        modelSource: host.capabilities.retainSourceAuthority?.(),
        agentId: "main",
      });
      parent.bindTurn("parent-finished");
      await parent.unregister();
      await expect(
        codexNativeSubagentMonitorRuntime.captureModelSource({
          client,
          threadId: "parent-thread",
          turnId: "parent-finished",
        }),
      ).resolves.toBeUndefined();
      readCodexAppServerBindingMock.mockReturnValue({
        threadId: "parent-thread",
        cwd: "/tmp/workspace",
        model: "gpt-5.5",
        modelProvider: providerId,
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const auth = platformPreparedRuntimeAuth("synthetic-proxy-key");
      auth.plan.modelRoute = { ...auth.plan.modelRoute, baseUrl, modelId: "gpt-5.5" };
      const run = runCodexAppServerSideQuestion(
        sideParams({
          hostCapabilities: host.capabilities,
          preparedRuntimeAuth: auth,
          opts: { runId: "private-side-source" },
        }),
      );
      if (changedProvider) {
        try {
          await expect(
            Promise.race([
              run,
              started.promise.then(() => {
                throw new Error("Changed native provider reached turn/start");
              }),
            ]),
          ).rejects.toThrow("did not preserve its prepared Responses provider");
          expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
        } finally {
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
          await run.catch(() => undefined);
          client.close();
          host.close();
        }
        return;
      }
      try {
        await Promise.race([
          started.promise,
          run.then((result) => {
            throw new Error("Side turn ended before model admission", { cause: result });
          }),
        ]);
        const capture = await codexNativeSubagentMonitorRuntime.captureModelSource({
          client,
          threadId: "side-thread",
          turnId: "turn-1",
        });
        if (!capture?.source) {
          throw new Error("Side turn lost its admitted operator model source");
        }
        try {
          capture.assertCurrent();
          expect(capture.modelMapping).toEqual({
            nativeModel: { provider: providerId, model: "gpt-5.5" },
            authorizedModel: { provider: "openai", model: "gpt-5.5" },
          });
          const binding = capture.source.bindModelExecution?.({
            provider: "openai",
            model: "gpt-5.5",
          });
          expect(binding).toBeDefined();
          binding?.assertCurrent();
          binding?.release();
        } finally {
          capture.release();
        }
      } finally {
        client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
        client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        try {
          await expect(run).resolves.toEqual({ text: "Side answer." });
        } finally {
          client.close();
          host.close();
        }
      }
    },
  );
});
