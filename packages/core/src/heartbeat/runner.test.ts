import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./runner.js";

type StubAgent = {
  closed: boolean;
  sessionId: string;
  ensureInitialized: () => Promise<void>;
  runInternalForResult: (content: string) => Promise<{ text: string; error?: string }>;
  getHeartbeatConfig: () => { prompt?: string; ackMaxChars?: number; enabled?: boolean };
  getPendingWrites: () => number;
  getProfileDir: () => string | undefined;
};

function createStubAgent(opts?: {
  profileDir?: string;
  replyText?: string;
  heartbeatEnabled?: boolean;
}): StubAgent {
  const replyText = opts?.replyText ?? "HEARTBEAT_OK";

  return {
    closed: false,
    sessionId: "test-session",
    ensureInitialized: async () => {},
    runInternalForResult: async () => ({ text: replyText }),
    getHeartbeatConfig: () =>
      typeof opts?.heartbeatEnabled === "boolean"
        ? { enabled: opts.heartbeatEnabled }
        : {},
    getPendingWrites: () => 0,
    getProfileDir: () => opts?.profileDir,
  };
}

describe("heartbeat runner", () => {
  afterEach(() => {
    setHeartbeatsEnabled(true);
  });

  it("skips when no agent is available", async () => {
    const result = await runHeartbeatOnce({ agent: null });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("skips when heartbeat file is effectively empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "heartbeat-test-"));
    try {
      await writeFile(path.join(dir, "heartbeat.md"), "# keep empty\n", "utf-8");
      const agent = createStubAgent({ profileDir: dir });
      const result = await runHeartbeatOnce({ agent: agent as any });
      expect(result).toEqual({ status: "skipped", reason: "empty-heartbeat-file" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bypasses empty-heartbeat-file check for cron-triggered wakes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "heartbeat-test-"));
    try {
      await writeFile(path.join(dir, "heartbeat.md"), "# keep empty\n", "utf-8");
      const agent = createStubAgent({ profileDir: dir, replyText: "HEARTBEAT_OK" });
      const result = await runHeartbeatOnce({ agent: agent as any, reason: "cron:test-job-id" });
      expect(result.status).toBe("ran");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs and returns ran for heartbeat acknowledgements", async () => {
    const agent = createStubAgent({ replyText: "HEARTBEAT_OK" });
    const result = await runHeartbeatOnce({ agent: agent as any, reason: "manual" });

    expect(result.status).toBe("ran");
  });

  it("uses runInternalForResult for heartbeat execution", async () => {
    const calls: string[] = [];
    const agent = createStubAgent({ replyText: "HEARTBEAT_OK" });
    agent.runInternalForResult = async (content: string) => {
      calls.push(content);
      return { text: "HEARTBEAT_OK" };
    };

    await runHeartbeatOnce({ agent: agent as any, reason: "manual" });

    expect(calls.length).toBeGreaterThan(0);
    // The prompt should contain heartbeat instructions
    expect(calls[0]).toContain("heartbeat");
  });
});
