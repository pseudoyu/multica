import { describe, it, expect } from "vitest";
import { buildSubagentSystemPrompt, formatAnnouncementMessage, formatCoalescedAnnouncementMessage } from "./announce.js";
import type { FormatAnnouncementParams } from "./announce.js";
import type { SubagentRunRecord } from "./types.js";

describe("buildSubagentSystemPrompt", () => {
  it("includes task and session context", () => {
    const prompt = buildSubagentSystemPrompt({
      requesterSessionId: "parent-123",
      childSessionId: "child-456",
      task: "Analyze the auth module for security issues",
    });

    expect(prompt).toContain("## Subagent Rules");
    expect(prompt).toContain("Analyze the auth module for security issues");
    expect(prompt).toContain("parent-123");
    expect(prompt).toContain("child-456");
    expect(prompt).toContain("Do NOT spawn nested subagents");
    expect(prompt).toContain("## Safety");
  });

  it("includes label when provided", () => {
    const prompt = buildSubagentSystemPrompt({
      requesterSessionId: "parent-123",
      childSessionId: "child-456",
      label: "Security Audit",
      task: "Check for vulnerabilities",
    });

    expect(prompt).toContain('Label: "Security Audit"');
  });

  it("omits label line when not provided", () => {
    const prompt = buildSubagentSystemPrompt({
      requesterSessionId: "parent-123",
      childSessionId: "child-456",
      task: "Do something",
    });

    expect(prompt).not.toContain("Label:");
  });
});

describe("formatAnnouncementMessage", () => {
  const baseParams: FormatAnnouncementParams = {
    runId: "run-1",
    childSessionId: "child-456",
    requesterSessionId: "parent-123",
    task: "Analyze code",
    label: "Code Analysis",
    cleanup: "delete",
    outcome: { status: "ok" },
    startedAt: 1000000,
    endedAt: 1030000,
  };

  it("formats successful completion", () => {
    const msg = formatAnnouncementMessage({
      ...baseParams,
      findings: "Found 3 issues in the auth module.",
    });

    expect(msg).toContain('"Code Analysis" just completed successfully');
    expect(msg).toContain("Found 3 issues in the auth module.");
    expect(msg).toContain("runtime 30s");
    expect(msg).toContain("session child-456");
  });

  it("formats error outcome", () => {
    const msg = formatAnnouncementMessage({
      ...baseParams,
      outcome: { status: "error", error: "API key expired" },
    });

    expect(msg).toContain("failed: API key expired");
  });

  it("formats timeout outcome", () => {
    const msg = formatAnnouncementMessage({
      ...baseParams,
      outcome: { status: "timeout" },
    });

    expect(msg).toContain("timed out");
  });

  it("shows (no output) when findings is not provided", () => {
    const msg = formatAnnouncementMessage(baseParams);

    expect(msg).toContain("(no output)");
  });

  it("uses task text when label is not provided", () => {
    const paramsNoLabel: FormatAnnouncementParams = {
      ...baseParams,
      label: undefined,
    };
    const msg = formatAnnouncementMessage(paramsNoLabel);

    expect(msg).toContain('"Analyze code"');
  });

  it("formats runtime for minutes", () => {
    const msg = formatAnnouncementMessage({
      ...baseParams,
      startedAt: 1000000,
      endedAt: 1150000, // 150 seconds = 2m30s
    });

    expect(msg).toContain("runtime 2m30s");
  });

  it("formats runtime for hours", () => {
    const msg = formatAnnouncementMessage({
      ...baseParams,
      startedAt: 1000000,
      endedAt: 4600000, // 3600 seconds = 1h
    });

    expect(msg).toContain("runtime 1h");
  });

  it("includes summarization instruction", () => {
    const msg = formatAnnouncementMessage(baseParams);

    expect(msg).toContain("Summarize this naturally for the user");
    expect(msg).toContain("NO_REPLY");
  });
});

describe("formatCoalescedAnnouncementMessage", () => {
  function makeRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
    return {
      runId: "run-1",
      childSessionId: "child-1",
      requesterSessionId: "parent-1",
      task: "Default task",
      cleanup: "delete",
      createdAt: 1000000,
      startedAt: 1000000,
      endedAt: 1030000,
      outcome: { status: "ok" },
      findings: "Some findings",
      findingsCaptured: true,
      announced: false,
      ...overrides,
    };
  }

  it("delegates to formatAnnouncementMessage for a single record", () => {
    const record = makeRecord({ label: "Code Analysis" });
    const coalesced = formatCoalescedAnnouncementMessage([record]);
    const direct = formatAnnouncementMessage({
      runId: record.runId,
      childSessionId: record.childSessionId,
      requesterSessionId: record.requesterSessionId,
      task: record.task,
      label: record.label,
      cleanup: record.cleanup,
      outcome: record.outcome,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      findings: record.findings,
    });

    expect(coalesced).toBe(direct);
  });

  it("formats multiple records with all task findings and stats", () => {
    const records = [
      makeRecord({
        runId: "run-1",
        childSessionId: "child-1",
        label: "Task A",
        findings: "Found issue A",
        startedAt: 1000000,
        endedAt: 1030000,
      }),
      makeRecord({
        runId: "run-2",
        childSessionId: "child-2",
        label: "Task B",
        findings: "Found issue B",
        startedAt: 1000000,
        endedAt: 1045000, // 45 seconds
      }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).toContain("All 2 background task(s) have completed");
    expect(msg).toContain('Task 1: "Task A"');
    expect(msg).toContain("Found issue A");
    expect(msg).toContain('Task 2: "Task B"');
    expect(msg).toContain("Found issue B");
    expect(msg).toContain("Total wall time: 45s");
    expect(msg).toContain("2 succeeded, 0 failed");
  });

  it("reports mixed outcomes correctly", () => {
    const records = [
      makeRecord({ runId: "run-1", label: "OK Task", outcome: { status: "ok" } }),
      makeRecord({ runId: "run-2", label: "Failed Task", outcome: { status: "error", error: "crash" } }),
      makeRecord({ runId: "run-3", label: "Timeout Task", outcome: { status: "timeout" } }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).toContain("completed successfully");
    expect(msg).toContain("failed: crash");
    expect(msg).toContain("timed out");
    expect(msg).toContain("1 succeeded, 2 failed");
  });

  it("shows (no output) for missing findings", () => {
    const records = [
      makeRecord({ runId: "run-1", findings: undefined }),
      makeRecord({ runId: "run-2", findings: "Has output" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).toContain("(no output)");
    expect(msg).toContain("Has output");
  });

  it("includes combined summary instruction for multi-record", () => {
    const records = [
      makeRecord({ runId: "run-1" }),
      makeRecord({ runId: "run-2" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).toContain("MUST include findings from every task item above");
    expect(msg).toContain("NO_REPLY");
  });

  it("includes raw findings for every task in coalesced payload", () => {
    const records = [
      makeRecord({ runId: "run-1", label: "南京天气", findings: "南京：晴，12°C" }),
      makeRecord({ runId: "run-2", label: "上海天气", findings: "上海：多云，9°C" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).toContain("Raw findings from each task (MUST cover all items):");
    expect(msg).toContain("[1] 南京天气:");
    expect(msg).toContain("南京：晴，12°C");
    expect(msg).toContain("[2] 上海天气:");
    expect(msg).toContain("上海：多云，9°C");
    expect(msg).toContain("MUST include findings from every task item above");
  });

  it("includes continuation prompt when next is provided", () => {
    const records = [
      makeRecord({ runId: "run-1", label: "AAPL data", findings: "AAPL revenue: $100B" }),
      makeRecord({ runId: "run-2", label: "MSFT data", findings: "MSFT revenue: $200B" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records, "Summarize all data and write a PDF investment report");

    expect(msg).toContain("CONTINUATION TASK");
    expect(msg).toContain("Summarize all data and write a PDF investment report");
    expect(msg).toContain("AAPL revenue: $100B");
    expect(msg).toContain("MSFT revenue: $200B");
    // Should NOT contain the default summarize instruction
    expect(msg).not.toContain("Summarize these results naturally for the user");
  });

  it("uses continuation prompt even for single record when next is provided", () => {
    const records = [
      makeRecord({ runId: "run-1", label: "Data collection", findings: "All data collected" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records, "Generate the final report");

    expect(msg).toContain("CONTINUATION TASK");
    expect(msg).toContain("Generate the final report");
    expect(msg).toContain("All data collected");
  });

  it("uses default summarize instruction when next is not provided", () => {
    const records = [
      makeRecord({ runId: "run-1" }),
      makeRecord({ runId: "run-2" }),
    ];

    const msg = formatCoalescedAnnouncementMessage(records);

    expect(msg).not.toContain("CONTINUATION TASK");
    expect(msg).toContain("Summarize these results naturally for the user");
  });
});
