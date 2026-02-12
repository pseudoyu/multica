import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./types.js";

const loadSubagentRunsMock = vi.fn<() => Map<string, SubagentRunRecord>>();
const saveSubagentRunsMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
const runCoalescedAnnounceFlowMock = vi.fn(() => false);
const resolveSessionDirMock = vi.fn((sessionId: string) => `/tmp/${sessionId}`);
const closeAgentMock = vi.fn();
const getHubMock = vi.fn(() => ({ closeAgent: closeAgentMock }));
const rmSyncMock = vi.fn();

vi.mock("./registry-store.js", () => ({
  loadSubagentRuns: loadSubagentRunsMock,
  loadSubagentGroups: vi.fn(() => new Map()),
  saveSubagentRuns: saveSubagentRunsMock,
}));

vi.mock("./announce.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
  runCoalescedAnnounceFlow: runCoalescedAnnounceFlowMock,
}));

vi.mock("../session/storage.js", () => ({
  resolveSessionDir: resolveSessionDirMock,
}));

vi.mock("../../hub/hub-singleton.js", () => ({
  getHub: getHubMock,
  isHubInitialized: vi.fn(() => false),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: rmSyncMock,
  };
});

describe("subagent registry recovery cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadSubagentRunsMock.mockReturnValue(new Map());
    runCoalescedAnnounceFlowMock.mockReturnValue(false);
  });

  it("deletes child session on recovery even when findings were already captured", async () => {
    const now = Date.now();
    const record: SubagentRunRecord = {
      runId: "run-1",
      childSessionId: "child-1",
      requesterSessionId: "parent-1",
      task: "task",
      cleanup: "delete",
      createdAt: now - 1000,
      startedAt: now - 900,
      endedAt: now - 100,
      outcome: { status: "ok" },
      findings: "done",
      findingsCaptured: true,
      cleanupHandled: false,
      announced: false,
    };

    loadSubagentRunsMock.mockReturnValue(new Map([["run-1", record]]));

    const registry = await import("./registry.js");
    registry.initSubagentRegistry();

    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
    expect(resolveSessionDirMock).toHaveBeenCalledWith("child-1");
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/child-1", { recursive: true, force: true });
  });
});
