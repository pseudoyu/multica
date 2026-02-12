/**
 * sessions_spawn tool — allows a parent agent to spawn subagent runs.
 *
 * Subagents run in isolated sessions with restricted tools.
 * Results are announced back to the parent when the child completes.
 */

import { v7 as uuidv7 } from "uuid";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getHub } from "../../hub/hub-singleton.js";
import { buildSubagentSystemPrompt } from "../subagent/announce.js";
import { registerSubagentRun, createSubagentGroup, getSubagentGroup } from "../subagent/registry.js";
import { resolveTools } from "../tools.js";

const SessionsSpawnSchema = Type.Object({
  task: Type.String({ description: "The task for the subagent to perform.", minLength: 1 }),
  label: Type.Optional(
    Type.String({ description: "Human-readable label for this background task." }),
  ),
  model: Type.Optional(
    Type.String({ description: "Override the LLM model for the subagent (e.g. 'gpt-4o', 'claude-sonnet')." }),
  ),
  cleanup: Type.Optional(
    Type.Union([Type.Literal("delete"), Type.Literal("keep")], {
      description: "Session cleanup after completion. 'delete' removes session files, 'keep' preserves for audit. Default: 'delete'.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Execution timeout in seconds. Default: 600 (10 min). " +
        "Set to 0 for no timeout (useful for complex, long-running tasks). " +
        "The subagent will be terminated if it exceeds this limit.",
      minimum: 0,
    }),
  ),
  announce: Type.Optional(
    Type.Union([Type.Literal("immediate"), Type.Literal("silent")], {
      description:
        "Announcement mode. 'immediate' (default): findings delivered as each subagent completes. " +
        "'silent': defer all announcements until every silent subagent from this session finishes, " +
        "then deliver one combined report. Use 'silent' when spawning multiple subagents to collect " +
        "data in parallel and you want to summarize everything at once. " +
        "Ignored when groupId is provided (groups always collect all results before announcing).",
    }),
  ),
  groupId: Type.Optional(
    Type.String({
      description:
        "Join an existing group. Pass the groupId returned by a previous sessions_spawn call " +
        "to add this subagent to the same group. All runs in a group are announced together " +
        "when the last one completes. If omitted AND 'next' is provided, a new group is created automatically.",
    }),
  ),
  next: Type.Optional(
    Type.String({
      description:
        "Continuation task to execute after ALL subagents in the group complete. " +
        "Only used when creating a new group (first spawn without groupId). " +
        "When set, the combined findings from all subagents plus this 'next' prompt " +
        "are delivered to you so you can perform follow-up work (e.g. summarize, generate reports, write files). " +
        "Setting 'next' automatically creates a group and implies silent collection.",
    }),
  ),
});

type SessionsSpawnArgs = {
  task: string;
  label?: string;
  model?: string;
  cleanup?: "delete" | "keep";
  timeoutSeconds?: number;
  announce?: "immediate" | "silent";
  groupId?: string;
  next?: string;
};

export type SessionsSpawnResult = {
  status: "accepted" | "error";
  childSessionId?: string;
  runId?: string;
  groupId?: string;
  error?: string;
};

export interface CreateSessionsSpawnToolOptions {
  /** Whether the current agent is itself a subagent */
  isSubagent?: boolean;
  /** Session ID of the current (requester) agent */
  sessionId?: string;
  /** Resolved provider ID of the parent agent (inherited by subagents) */
  provider?: string;
}

export function createSessionsSpawnTool(
  options: CreateSessionsSpawnToolOptions,
): AgentTool<typeof SessionsSpawnSchema, SessionsSpawnResult> {
  return {
    name: "sessions_spawn",
    label: "Spawn Subagent",
    description:
      "Spawn a background subagent to handle a specific task. The subagent runs in an isolated session with its own tool set. " +
      "When it completes, its findings are delivered directly into your context automatically. " +
      "After spawning, do NOT proceed with work that depends on the results — but you can still chat or do unrelated tasks. " +
      "When spawning multiple subagents for a collect-then-act workflow, ALWAYS use the `next` parameter " +
      "on the first spawn to define follow-up work, then pass the returned groupId to subsequent spawns. " +
      "Use this for parallelizable work, long-running analysis, or tasks that benefit from isolation.",
    parameters: SessionsSpawnSchema,
    execute: async (_toolCallId, args) => {
      const { task, label, model, cleanup = "delete", timeoutSeconds, announce, next } = args as SessionsSpawnArgs;
      let { groupId } = args as SessionsSpawnArgs;

      // Guard: subagents cannot spawn subagents
      if (options.isSubagent) {
        return {
          content: [{ type: "text", text: "Error: sessions_spawn is not allowed from sub-agent sessions." }],
          details: {
            status: "error",
            error: "sessions_spawn is not allowed from sub-agent sessions",
          },
        };
      }

      const requesterSessionId = options.sessionId ?? "unknown";
      const runId = uuidv7();
      const childSessionId = uuidv7();

      // Validate groupId if provided
      if (groupId) {
        const existingGroup = getSubagentGroup(groupId);
        if (!existingGroup) {
          return {
            content: [{ type: "text", text: `Error: group not found: ${groupId}. Use the groupId returned by a previous sessions_spawn call.` }],
            details: { status: "error", error: `group not found: ${groupId}` },
          };
        }
      }

      // Auto-create group when `next` is provided without an existing groupId
      if (!groupId && next) {
        groupId = uuidv7();
        createSubagentGroup({
          groupId,
          requesterSessionId,
          label: label ? `Group: ${label}` : undefined,
          next,
        });
      }

      // Resolve tools for the subagent (with isSubagent=true for policy filtering)
      const subagentTools = resolveTools({ isSubagent: true });
      const toolNames = subagentTools.map((t) => t.name);

      // Build system prompt for the child
      const systemPrompt = buildSubagentSystemPrompt({
        requesterSessionId,
        childSessionId,
        label,
        task,
        tools: toolNames,
      });

      // Spawn child agent via Hub
      try {
        const hub = getHub();
        const childAgent = hub.createSubagent(childSessionId, {
          systemPrompt,
          model,
          provider: options.provider,
        });

        // Register the run for lifecycle tracking.
        // The write is deferred via the start callback so the child only
        // begins work once a concurrency slot is available in the queue.
        registerSubagentRun({
          runId,
          childSessionId,
          requesterSessionId,
          task,
          label,
          cleanup,
          timeoutSeconds,
          announce: groupId ? "silent" : announce,
          groupId,
          start: () => childAgent.write(task),
        });

        // Build response text
        const groupInfo = groupId ? `\nGroup: ${groupId}` : "";
        const nextInfo = next ? `\nContinuation: "${next.slice(0, 100)}${next.length > 100 ? "…" : ""}"` : "";
        const responseText =
          `Subagent spawned: ${label || task.slice(0, 80)}\n` +
          `Run: ${runId}${groupInfo}${nextInfo}\n\n` +
          `⏳ WAITING FOR RESULTS — do NOT proceed with work that depends on these results.\n` +
          `Do NOT fabricate data or completion status. Results will arrive in your context automatically.`;

        return {
          content: [{ type: "text", text: responseText }],
          details: {
            status: "accepted",
            childSessionId,
            runId,
            groupId,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error spawning subagent: ${message}` }],
          details: {
            status: "error",
            error: message,
          },
        };
      }
    },
  };
}
