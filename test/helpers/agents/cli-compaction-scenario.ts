import path from "node:path";
import { vi } from "vitest";
import {
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "../../../src/agents/command/cli-compaction.js";
import {
  buildContextEngine,
  systemCompactionHost,
  writeSessionFile,
} from "../../../src/agents/command/cli-compaction.test-support.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "../../../src/agents/command/session-store.js";
import { replaceSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionEntry,
} from "../../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ContextEngine } from "../../../src/context-engine/types.js";
type CliCompactionTestDeps = Parameters<typeof setCliCompactionTestDeps>[0];
type CliCompactionParams = Parameters<typeof runCliTurnCompactionLifecycle>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];

export const defaultSettingsManager = async () => ({
  getCompactionReserveTokens: () => 200,
  getCompactionKeepRecentTokens: () => 0,
  applyOverrides: () => {},
});

const defaultPreemptiveCompaction = () => ({
  route: "fits" as const,
  shouldCompact: false,
  estimatedPromptTokens: 600,
  promptBudgetBeforeReserve: 800,
  overflowTokens: 0,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 200,
});

export async function prepareCompactionScenario(params: {
  tmpDir: string;
  suffix: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionEntry?: Partial<SessionEntry>;
  cfg?: OpenClawConfig;
  cwd?: string;
  contextEngine?: (compactCalls: CompactParams[]) => ContextEngine;
  maintenance?: CliCompactionTestDeps["runContextEngineMaintenance"];
  recordCliCompactionInStore?: CliCompactionTestDeps["recordCliCompactionInStore"];
  deps?: CliCompactionTestDeps;
}) {
  const sessionKey = params.sessionKey ?? `agent:main:${params.suffix}`;
  const sessionId = params.sessionId ?? `session-${params.suffix}`;
  const transcriptFile = path.join(params.tmpDir, `${params.suffix}.jsonl`);
  const storePath = path.join(params.tmpDir, `${params.suffix}.sqlite`);
  await writeSessionFile({ sessionFile: transcriptFile, sessionId });

  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: Date.now(),
    sessionFile: transcriptFile,
    contextTokens: 1_000,
    totalTokens: 950,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    ...params.sessionEntry,
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);

  const compactCalls: CompactParams[] = [];
  const contextEngine =
    params.contextEngine?.(compactCalls) ?? buildContextEngine({ compactCalls });
  const maintenance = vi.fn(
    params.maintenance ?? (async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
  );
  const recordCliCompactionInStore =
    params.recordCliCompactionInStore ?? vi.fn(recordCliCompactionInStoreImpl);
  setCliCompactionTestDeps({
    resolveContextEngine: async () => contextEngine,
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
    createPreparedEmbeddedAgentSettingsManager: defaultSettingsManager,
    shouldPreemptivelyCompactBeforePrompt: defaultPreemptiveCompaction,
    resolveLiveToolResultMaxChars: () => 20_000,
    runContextEngineMaintenance: maintenance,
    recordCliCompactionInStore,
    ...params.deps,
  });

  const runParams: CliCompactionParams = {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    sessionAgentId: "main",
    workspaceDir: params.tmpDir,
    cwd: params.cwd,
    agentDir: params.tmpDir,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
  };
  return {
    compactCalls,
    contextEngine,
    maintenance,
    recordCliCompactionInStore,
    run: (overrides: Partial<CliCompactionParams> = {}) =>
      runCliTurnCompactionLifecycle({ ...runParams, ...overrides }, systemCompactionHost),
    sessionEntry,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    transcriptFile,
  };
}
