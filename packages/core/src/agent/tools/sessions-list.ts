/**
 * sessions_list tool — allows an agent to view its spawned subagent runs.
 *
 * Lists all subagent runs for the current session, or shows details for a
 * specific run when a runId is provided.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { listSubagentRuns, getSubagentRun, getSubagentGroup } from "../subagent/registry.js";
import type { SubagentRunRecord } from "../subagent/types.js";

const SessionsListSchema = Type.Object({
  runId: Type.Optional(
    Type.String({ description: "Optional run ID to get details for a specific run. If omitted, lists all runs." }),
  ),
});

type SessionsListArgs = {
  runId?: string;
};

export type SessionsListResult = {
  runs: Array<{
    runId: string;
    label?: string | undefined;
    task: string;
    status: "running" | "ok" | "error" | "timeout" | "unknown";
    startedAt?: number | undefined;
    endedAt?: number | undefined;
    findings?: string | undefined;
  }>;
};

export interface CreateSessionsListToolOptions {
  /** Session ID of the current (requester) agent */
  sessionId?: string;
}

function resolveStatus(record: SubagentRunRecord): "running" | "ok" | "error" | "timeout" | "unknown" {
  if (!record.endedAt) return "running";
  return record.outcome?.status ?? "unknown";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function formatRunSummary(record: SubagentRunRecord, index: number, now: number): string {
  const status = resolveStatus(record);
  const displayName = record.label || record.task.slice(0, 60);
  const statusTag = `[${status}]`.padEnd(10);

  let timing = "";
  if (status === "running" && record.startedAt) {
    timing = `started ${formatElapsed(now - record.startedAt)} ago`;
  } else if (record.startedAt && record.endedAt) {
    timing = `completed in ${formatElapsed(record.endedAt - record.startedAt)}`;
  }

  const parts = [`#${index + 1} ${statusTag} "${displayName}"`];
  if (timing) parts.push(`(${record.runId.slice(0, 8)}…, ${timing})`);
  else parts.push(`(${record.runId.slice(0, 8)}…)`);

  return parts.join("  ");
}

function formatRunDetail(record: SubagentRunRecord, now: number): string {
  const status = resolveStatus(record);
  const lines: string[] = [
    `Run: ${record.runId}`,
  ];

  if (record.label) lines.push(`Label: ${record.label}`);
  if (record.groupId) {
    const group = getSubagentGroup(record.groupId);
    lines.push(`Group: ${record.groupId}${group?.label ? ` (${group.label})` : ""}`);
    if (group?.next) lines.push(`Continuation: ${group.next.slice(0, 120)}${group.next.length > 120 ? "…" : ""}`);
  }
  lines.push(`Task: ${record.task}`);
  lines.push(`Status: ${status}${record.outcome?.error ? ` — ${record.outcome.error}` : ""}`);
  lines.push(`Child Session: ${record.childSessionId}`);
  lines.push(`Created: ${new Date(record.createdAt).toISOString()} (${formatElapsed(now - record.createdAt)} ago)`);

  if (record.startedAt) {
    lines.push(`Started: ${new Date(record.startedAt).toISOString()} (${formatElapsed(now - record.startedAt)} ago)`);
  }
  if (record.endedAt) {
    lines.push(`Ended: ${new Date(record.endedAt).toISOString()}`);
    if (record.startedAt) {
      lines.push(`Duration: ${formatElapsed(record.endedAt - record.startedAt)}`);
    }
  }

  if (record.findingsCaptured) {
    lines.push(`Findings: ${record.findings || "(no output)"}`);
  } else if (record.endedAt) {
    lines.push("Findings: (not yet captured)");
  } else {
    lines.push("Findings: (still running)");
  }

  if (record.announced) lines.push("Announced: yes");

  return lines.join("\n");
}

function toResultRun(record: SubagentRunRecord) {
  return {
    runId: record.runId,
    label: record.label,
    task: record.task,
    status: resolveStatus(record),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    findings: record.findings,
  };
}

export function createSessionsListTool(
  options: CreateSessionsListToolOptions,
): AgentTool<typeof SessionsListSchema, SessionsListResult> {
  return {
    name: "sessions_list",
    label: "List Subagent Runs",
    description:
      "List all subagent runs spawned by this session and their current status. " +
      "Optionally pass a runId to get detailed information about a specific run. " +
      "Use this to check subagent progress or when the user asks about status.",
    parameters: SessionsListSchema,
    execute: async (_toolCallId, args) => {
      const { runId } = args as SessionsListArgs;
      const requesterSessionId = options.sessionId;

      if (!requesterSessionId) {
        return {
          content: [{ type: "text", text: "No session ID available. Cannot list subagent runs." }],
          details: { runs: [] },
        };
      }

      const now = Date.now();

      // Detail mode: specific run
      if (runId) {
        const record = getSubagentRun(runId);
        if (!record) {
          return {
            content: [{ type: "text", text: `Run not found: ${runId}` }],
            details: { runs: [] },
          };
        }
        if (record.requesterSessionId !== requesterSessionId) {
          return {
            content: [{ type: "text", text: `Run not found: ${runId}` }],
            details: { runs: [] },
          };
        }
        return {
          content: [{ type: "text", text: formatRunDetail(record, now) }],
          details: { runs: [toResultRun(record)] },
        };
      }

      // List mode: all runs for this session
      const runs = listSubagentRuns(requesterSessionId);

      if (runs.length === 0) {
        return {
          content: [{ type: "text", text: "No subagent runs for this session." }],
          details: { runs: [] },
        };
      }

      const someRunning = runs.some((r) => !r.endedAt);

      // Build status lines, grouping runs by groupId
      const statusLines: string[] = [];
      const groupedRuns = new Map<string, SubagentRunRecord[]>();
      const ungroupedRuns: SubagentRunRecord[] = [];

      for (const r of runs) {
        if (r.groupId) {
          const list = groupedRuns.get(r.groupId) ?? [];
          list.push(r);
          groupedRuns.set(r.groupId, list);
        } else {
          ungroupedRuns.push(r);
        }
      }

      let idx = 0;

      // Grouped runs
      for (const [gId, gRuns] of groupedRuns) {
        const group = getSubagentGroup(gId);
        const groupLabel = group?.label || `Group ${gId.slice(0, 8)}…`;
        const done = gRuns.filter(r => r.endedAt).length;
        const nextSnippet = group?.next ? ` → next: "${group.next.slice(0, 60)}${group.next.length > 60 ? "…" : ""}"` : "";
        statusLines.push(`\n  📦 ${groupLabel} (${done}/${gRuns.length} done${nextSnippet})`);

        for (const r of gRuns) {
          idx++;
          const displayName = r.label || r.task.slice(0, 60);
          const status = resolveStatus(r);
          if (status === "running") {
            const elapsed = r.startedAt ? formatElapsed(now - r.startedAt) : "just spawned";
            statusLines.push(`     ${idx}. [RUNNING] "${displayName}" (${elapsed})`);
          } else {
            const elapsed = r.startedAt && r.endedAt ? formatElapsed(r.endedAt - r.startedAt) : "";
            statusLines.push(`     ${idx}. [${status.toUpperCase()}] "${displayName}" (${elapsed})`);
          }
        }
      }

      // Ungrouped runs
      for (const r of ungroupedRuns) {
        idx++;
        const displayName = r.label || r.task.slice(0, 60);
        const status = resolveStatus(r);
        if (status === "running") {
          const elapsed = r.startedAt ? formatElapsed(now - r.startedAt) : "just spawned";
          statusLines.push(`  ${idx}. [RUNNING] "${displayName}" (${elapsed})`);
        } else {
          const elapsed = r.startedAt && r.endedAt ? formatElapsed(r.endedAt - r.startedAt) : "";
          const findings = r.findingsCaptured
            ? (r.findings ? r.findings.slice(0, 200) + (r.findings.length > 200 ? "…" : "") : "(no output)")
            : "(findings not yet captured)";
          statusLines.push(`  ${idx}. [${status.toUpperCase()}] "${displayName}" (${elapsed})\n      Findings: ${findings}`);
        }
      }

      const header = `Subagent runs for this session: ${runs.length} total`;
      const body = statusLines.join("\n");

      // If any subagents are still running, return status with wait instruction.
      // We do NOT use steer() here — steer would cancel unrelated tool calls
      // that the LLM may be processing in the same batch.
      if (someRunning) {
        const runningCount = runs.filter((r) => !r.endedAt).length;
        return {
          content: [
            {
              type: "text",
              text:
                header + "\n" + body + "\n\n" +
                `STATUS: ${runningCount} subagent(s) still running. This is normal — they need time to complete.\n` +
                "ACTION REQUIRED: Do NOT call sessions_list again. Results will be delivered into your context automatically when they finish.\n" +
                "Do NOT attempt to do this work yourself — the subagents are handling it.",
            },
          ],
          details: { runs: runs.map(toResultRun) },
        };
      }

      // All completed — normal response
      return {
        content: [{ type: "text", text: header + "\n" + body }],
        details: { runs: runs.map(toResultRun) },
      };
    },
  };
}
