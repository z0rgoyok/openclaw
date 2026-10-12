import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginCompactionTestCleanup,
  createFakeCodexCompactionClient,
  maybeCompactCodexAppServerSession,
  requireCompactResult,
  writeCompactionTestBinding,
} from "./compact.test-support.js";
import {
  getCodexInferenceThreadQualification,
  ownCodexInferenceClient,
} from "./inference-routing.js";
import { buildCodexPreparedResponsesProvider } from "./prepared-responses-route.js";
import { isJsonObject } from "./protocol.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";

let tempDir: string;
let cleanup: ReturnType<typeof beginCompactionTestCleanup>;
beforeEach(async () => {
  resetCodexTestBindingStore();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-prepared-"));
  cleanup = beginCompactionTestCleanup();
});
afterEach(async ({ task }) => {
  try {
    await cleanup(task.result?.state === "fail");
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("cold prepared native compaction", () => {
  it.each(["owned", "unowned", "changed response provider"])(
    "cold compaction preserves its private route across a prior physical provider: %s",
    async (state) => {
      for (const key of ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "REQUEST_METHOD"]) {
        vi.stubEnv(key, undefined);
      }
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
        vi.stubEnv(key, undefined);
        vi.stubEnv(key.toLowerCase(), undefined);
      }
      const baseUrl = "http://192.168.50.10:8080/v1";
      const providerId = "openclaw-prepared-responses-current-physical";
      const fake = createFakeCodexCompactionClient(tempDir, { retainedThreadId: null });
      Object.assign(fake.client, { protectPrivateTransportSecret: vi.fn() });
      const original = fake.request.getMockImplementation();
      if (!original) {
        throw new Error("missing compaction fixture request implementation");
      }
      fake.request.mockImplementation(async (method, args, requestOptions) => {
        if (method === "config/read") {
          return {
            config: {
              model_provider: providerId,
              model_providers: { [providerId]: buildCodexPreparedResponsesProvider(baseUrl) },
            },
            origins: {},
          };
        }
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (method === "thread/compact/start") {
          expect(
            getCodexInferenceThreadQualification(fake.client, "thread-1")?.hasProvider(providerId),
          ).toBe(true);
        }
        const result: unknown = await original(method, args, requestOptions);
        if (method === "thread/resume" && isJsonObject(result) && isJsonObject(result.thread)) {
          const resumedProvider = state === "changed response provider" ? "openai" : providerId;
          return {
            ...result,
            modelProvider: resumedProvider,
            thread: { ...result.thread, modelProvider: resumedProvider },
          };
        }
        return result;
      });
      const sessionFile = await writeCompactionTestBinding(tempDir, {
        clientId: "prior-compaction-process",
        modelProvider: "openclaw-prepared-responses-prior-physical",
      });
      const modelRoute = {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      };
      try {
        if (state !== "unowned") {
          ownCodexInferenceClient(fake.client, {}, undefined, { baseUrl, providerId });
        }
        const result = requireCompactResult(
          await maybeCompactCodexAppServerSession(
            {
              sessionId: "session-1",
              sessionKey: "agent:main:session-1",
              sessionFile,
              workspaceDir: tempDir,
              trigger: "manual",
              provider: "openai",
              model: "gpt-5.5",
              resolvedApiKey: "synthetic-private-key",
              runtimeAuthPlan: {
                providerForAuth: "openai",
                authProfileProviderForAuth: "openai",
                harnessAuthProvider: "openai",
                selectedAuthMode: "api-key",
                modelRoute,
              },
            },
            { clientFactory: async () => fake.client },
          ),
        );
        expect(result.ok).toBe(state === "owned");
        const resume = fake.request.mock.calls.find(([method]) => method === "thread/resume")?.[1];
        if (state === "unowned") {
          expect(resume).toBeUndefined();
        } else {
          expect(resume).toMatchObject({
            threadId: "thread-1",
            modelProvider: providerId,
            config: {
              model_provider: providerId,
              model_providers: {
                [providerId]: { base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) },
              },
            },
          });
          expect(JSON.stringify(resume)).not.toContain("prior-physical");
          expect(JSON.stringify(resume)).not.toContain("api.openai.com");
        }
        expect(fake.request.mock.calls.some(([method]) => method === "thread/compact/start")).toBe(
          state === "owned",
        );
      } finally {
        fake.close();
        vi.unstubAllEnvs();
      }
    },
  );
});
