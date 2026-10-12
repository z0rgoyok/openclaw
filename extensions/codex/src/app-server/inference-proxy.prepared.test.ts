import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const upstream = createServer();
const observed: Array<{ url: string | undefined; authorization: string | undefined }> = [];
const proxies: CodexInferenceProxy[] = [];
let baseUrl: string;
let redirect = false;

beforeAll(async () => {
  upstream.on("request", (req, res) => {
    observed.push({ url: req.url, authorization: req.headers.authorization });
    req.resume();
    if (redirect) {
      res.writeHead(302, { location: baseUrl + "/redirected" }).end();
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: synthetic completion\n\n");
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

beforeEach(() => {
  observed.length = 0;
  redirect = false;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
});

afterEach(() => {
  for (const proxy of proxies.splice(0)) {
    proxy.close();
  }
  vi.unstubAllEnvs();
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
  });
});

async function fixture() {
  const assertCurrent = vi.fn();
  const bindModelExecution = vi.fn(() => ({ assertCurrent, release: () => {} }));
  const proxy = await createCodexInferenceProxy({
    upstream: new URL(baseUrl),
    preparedResponsesRoute: Object.freeze({ baseUrl }),
    assertCurrent,
    bindModelExecution,
  });
  proxies.push(proxy);
  const registration = proxy.context.register({
    threadId: "prepared-root",
    text: "synthetic context",
    signal: new AbortController().signal,
    assertCurrent,
  });
  const body = JSON.stringify({
    model: "allowed-model",
    instructions: "native instructions",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "prepared-root",
        turn_id: "prepared-turn",
        request_kind: "turn",
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      }),
    },
  });
  return { proxy, body, assertCurrent, bindModelExecution };
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false, headers }, resolve);
    req.once("error", reject);
    req.end(body);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(Buffer.from(chunk));
  }
  return { status: res.statusCode, body: Buffer.concat(chunks).toString() };
}

describe("prepared private Responses transport", () => {
  it("forwards the exact bearer to its owned private HTTP origin with model admission", async () => {
    const { proxy, body, bindModelExecution, assertCurrent } = await fixture();
    const result = await post(proxy.baseUrl + "/responses", body, {
      authorization: "Bearer synthetic-private-key",
    });
    expect(result).toEqual({ status: 200, body: "data: synthetic completion\n\n" });
    expect(observed).toEqual([
      { url: "/v1/responses", authorization: "Bearer synthetic-private-key" },
    ]);
    expect(bindModelExecution).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalled();
  });

  it("rejects redirects without sending the key to a second request", async () => {
    redirect = true;
    const { proxy, body } = await fixture();
    expect((await post(proxy.baseUrl + "/responses", body)).status).toBe(502);
    expect(observed).toEqual([{ url: "/v1/responses", authorization: undefined }]);
  });

  it("keeps private access bound to the host capability and exact upstream", async () => {
    await expect(
      createCodexInferenceProxy({ upstream: new URL(baseUrl), assertCurrent: () => {} }),
    ).rejects.toThrow("HTTPS upstream");
    await expect(
      createCodexInferenceProxy({
        upstream: new URL(baseUrl + "/changed"),
        preparedResponsesRoute: { baseUrl },
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("configuration changed");
    const unowned = await createCodexInferenceProxy({
      upstream: new URL("https://127.0.0.1/v1"),
      assertCurrent: () => {},
    });
    proxies.push(unowned);
    expect((await post(unowned.baseUrl + "/responses", "{}")).status).toBe(502);
    expect(observed).toEqual([]);
  });

  it("rejects route-token escapes, browser origins, stale authority and WebSocket upgrades", async () => {
    const { proxy, body, assertCurrent } = await fixture();
    for (const url of [proxy.baseUrl + "/../responses", proxy.baseUrl + "/%2fresponses"]) {
      expect((await post(url, body)).status).toBe(502);
    }
    expect(
      (await post(proxy.baseUrl + "/responses", body, { origin: "https://example.test" })).status,
    ).toBe(502);
    const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => reject(new Error("prepared route accepted WebSocket")));
      socket.once("error", () => resolve());
    });
    socket.terminate();
    assertCurrent.mockImplementation(() => {
      throw new Error("synthetic revoked owner");
    });
    expect((await post(proxy.baseUrl + "/responses", body)).status).toBe(502);
    expect(observed).toEqual([]);
  });
});
