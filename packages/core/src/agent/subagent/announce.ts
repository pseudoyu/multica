/**
 * Subagent announcement flow.
 *
 * Handles result propagation from child → parent agent:
 * - Builds system prompts for child agents
 * - Reads child session output
 * - Formats and delivers announcement messages
 */

import { readEntries } from "../session/storage.js";
import { getHub } from "../../hub/hub-singleton.js";
import { buildSystemPrompt } from "../system-prompt/index.js";
import type {
  SubagentAnnounceParams,
  SubagentRunOutcome,
  SubagentRunRecord,
  SubagentSystemPromptParams,
} from "./types.js";
import { enqueueAnnounce, DEFAULT_ANNOUNCE_SETTINGS } from "./announce-queue.js";

/**
 * Build the system prompt injected into a subagent session.
 * Uses the structured prompt builder with "minimal" mode.
 */
export function buildSubagentSystemPrompt(params: SubagentSystemPromptParams): string {
  return buildSystemPrompt({
    mode: "minimal",
    subagent: {
      requesterSessionId: params.requesterSessionId,
      childSessionId: params.childSessionId,
      label: params.label,
      task: params.task,
    },
    tools: params.tools,
  });
}

/**
 * Read the latest assistant reply from a session's JSONL file.
 */
export function readLatestAssistantReply(sessionId: string): string | undefined {
  const entries = readEntries(sessionId);
  let latestToolResultText: string | undefined;

  // Walk backwards to find the last non-empty assistant reply.
  // If no assistant text exists (e.g. run ended after tool execution),
  // fall back to the latest non-empty toolResult content.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "assistant") {
      const text = extractAssistantText(message);
      if (text) return text;
      continue;
    }

    if (message.role === "toolResult" && !latestToolResultText) {
      const text = extractToolResultText(message);
      if (text) latestToolResultText = text;
    }
  }

  return latestToolResultText;
}

/**
 * Extract text content from an assistant message.
 * AgentMessage.content for assistant is (TextContent | ThinkingContent | ToolCall)[].
 */
function extractAssistantText(message: { role: string; content: unknown }): string {
  return extractTextLikeContent(message.content);
}

/**
 * Extract text content from a toolResult message.
 */
function extractToolResultText(message: { role: string; content: unknown }): string {
  return extractTextLikeContent(message.content);
}

function extractTextLikeContent(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeText(content);
  }

  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ("text" in block) {
      textParts.push(String((block as { text: unknown }).text));
    }
  }

  return sanitizeText(textParts.join("\n"));
}

/**
 * Strip thinking tags and tool markers from text.
 */
function sanitizeText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

/**
 * Format the duration between two timestamps as a human-readable string.
 */
function formatDuration(startMs: number, endMs: number): string {
  const totalSeconds = Math.round((endMs - startMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format a status label from an outcome.
 */
function formatStatusLabel(outcome: SubagentRunOutcome | undefined): string {
  if (!outcome) return "completed with unknown status";
  switch (outcome.status) {
    case "ok":
      return "completed successfully";
    case "error":
      return outcome.error ? `failed: ${outcome.error}` : "failed";
    case "timeout":
      return "timed out";
    default:
      return "completed with unknown status";
  }
}

/** Parameters for formatAnnouncementMessage */
export interface FormatAnnouncementParams {
  runId: string;
  childSessionId: string;
  requesterSessionId: string;
  task: string;
  label?: string | undefined;
  cleanup: "delete" | "keep";
  outcome?: SubagentRunOutcome | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  findings?: string | undefined;
}

/**
 * Format the announcement message sent to the parent agent.
 */
export function formatAnnouncementMessage(params: FormatAnnouncementParams): string {
  const { task, label, outcome, findings, startedAt, endedAt, childSessionId } = params;
  const displayName = label || task.slice(0, 60);
  const statusLabel = formatStatusLabel(outcome);

  const parts: string[] = [
    `A background task "${displayName}" just ${statusLabel}.`,
    "",
    "Findings:",
    findings || "(no output)",
  ];

  // Stats line
  const stats: string[] = [];
  if (startedAt && endedAt) {
    stats.push(`runtime ${formatDuration(startedAt, endedAt)}`);
  }
  stats.push(`session ${childSessionId}`);

  parts.push("", `Stats: ${stats.join(" • ")}`);

  parts.push(
    "",
    "Summarize this naturally for the user. Keep it brief (1-2 sentences).",
    "Flow it into the conversation naturally.",
    "Do not mention technical details like session IDs or that this was a background task.",
    "You can respond with NO_REPLY if no announcement is needed (e.g., internal task with no user-facing result).",
  );

  return parts.join("\n");
}

/**
 * Format a coalesced announcement message from multiple completed subagent runs.
 * When only one record is provided, delegates to formatAnnouncementMessage.
 *
 * @param next — Optional continuation prompt from a SubagentGroup. When present,
 *   the parent agent is instructed to execute the continuation using the combined
 *   findings, rather than just summarizing.
 */
export function formatCoalescedAnnouncementMessage(
  records: SubagentRunRecord[],
  next?: string,
): string {
  // Single record without continuation: delegate to existing format
  if (records.length === 1 && !next) {
    const r = records[0]!;
    return formatAnnouncementMessage({
      runId: r.runId,
      childSessionId: r.childSessionId,
      requesterSessionId: r.requesterSessionId,
      task: r.task,
      label: r.label,
      cleanup: r.cleanup,
      outcome: r.outcome,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      findings: r.findings,
    });
  }

  // Multiple records (or single with continuation): build combined message.
  const parts: string[] = [
    `All ${records.length} background task(s) have completed. Here are the combined results:`,
    "",
  ];

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const displayName = r.label || r.task.slice(0, 60);
    const statusLabel = formatStatusLabel(r.outcome);
    const durationStr = (r.startedAt && r.endedAt)
      ? ` (${formatDuration(r.startedAt, r.endedAt)})`
      : "";

    parts.push(
      `### Task ${i + 1}: "${displayName}"`,
      `Status: ${statusLabel}${durationStr}`,
      "",
      "Findings:",
      r.findings || "(no output)",
      "",
    );
  }

  // Overall stats
  const allStartTimes = records.map(r => r.startedAt).filter(Boolean) as number[];
  const allEndTimes = records.map(r => r.endedAt).filter(Boolean) as number[];
  if (allStartTimes.length > 0 && allEndTimes.length > 0) {
    const wallTime = formatDuration(Math.min(...allStartTimes), Math.max(...allEndTimes));
    parts.push(`Total wall time: ${wallTime}`);
  }

  const okCount = records.filter(r => r.outcome?.status === "ok").length;
  const failCount = records.length - okCount;
  parts.push(`Results: ${okCount} succeeded, ${failCount} failed/timed out`);

  parts.push("", "Raw findings from each task (MUST cover all items):", "");
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const displayName = r.label || r.task.slice(0, 60);
    parts.push(
      `[${i + 1}] ${displayName}:`,
      r.findings || "(no output)",
      "",
    );
  }

  // Continuation vs. summarization
  if (next) {
    parts.push(
      "",
      "---",
      "",
      "CONTINUATION TASK: The user's original request requires further work using the findings above.",
      "Execute the following task now, using ALL the collected data:",
      "",
      next,
      "",
      "Use the raw findings above as your data source. Call tools as needed to complete this task.",
      "Do not mention technical details like session IDs or that these were background tasks.",
    );
  } else {
    parts.push(
      "",
      "Summarize these results naturally for the user.",
      "You MUST include findings from every task item above, without omission.",
      "Keep it concise, but preserve concrete findings from each task.",
      "Do not mention technical details like session IDs or that these were background tasks.",
      "You can respond with NO_REPLY if no announcement is needed.",
    );
  }

  return parts.join("\n");
}

/**
 * Run the coalesced announcement flow for all completed runs of a requester.
 * Uses two-tier delivery:
 *   1. Queue — if parent is busy (running or has pending writes), queue for
 *      later drain via writeInternal (with debounce to batch nearby completions)
 *   2. Direct — if parent is idle, send immediately via writeInternal
 *
 * All delivery uses writeInternal() which marks the announcement prompt as
 * `internal: true` (hidden from UI). The assistant's summary response is
 * forwarded to the real-time stream (`forwardAssistant: true`) so the user
 * sees the result, and persisted to JSONL for future session loads.
 */
export function runCoalescedAnnounceFlow(
  requesterSessionId: string,
  records: SubagentRunRecord[],
  next?: string,
): boolean {
  const message = formatCoalescedAnnouncementMessage(records, next);

  try {
    const hub = getHub();
    const parentAgent = hub.getAgent(requesterSessionId);
    if (!parentAgent || parentAgent.closed) {
      console.warn(
        `[SubagentAnnounce] Parent agent not found or closed: ${requesterSessionId}`,
      );
      return false;
    }

    // Tier 1: BUSY — parent is running or has pending writes
    // Queue the announcement for delivery via writeInternal() after the parent
    // finishes its current work. We do NOT use steer() (cancels unrelated tool
    // calls) or followUp() (doesn't mark entries as internal, polluting the UI).
    if (parentAgent.isRunning || parentAgent.getPendingWrites() > 0) {
      enqueueAnnounce({
        key: requesterSessionId,
        item: {
          prompt: message,
          summaryLine: `${records.length} subagent(s) completed`,
          enqueuedAt: Date.now(),
          requesterSessionId,
        },
        settings: DEFAULT_ANNOUNCE_SETTINGS,
        send: async (item) => sendAnnounceDirect(requesterSessionId, item.prompt),
      });
      console.log(`[SubagentAnnounce] Queued announcement for parent: ${requesterSessionId}`);
      return true;
    }

    // Tier 2: IDLE — parent is idle, send directly via writeInternal
    sendAnnounceDirect(requesterSessionId, message);
    return true;
  } catch (err) {
    console.error(`[SubagentAnnounce] Failed to coalesced-announce to parent:`, err);
    return false;
  }
}

/**
 * Send announcement directly to parent via writeInternal.
 * Used as Tier 3 (idle) and as the queue drain callback.
 */
function sendAnnounceDirect(requesterSessionId: string, message: string): void {
  try {
    const hub = getHub();
    const parentAgent = hub.getAgent(requesterSessionId);
    if (!parentAgent || parentAgent.closed) {
      console.warn(
        `[SubagentAnnounce] Parent agent not found or closed for direct send: ${requesterSessionId}`,
      );
      return;
    }
    parentAgent.writeInternal(message, { forwardAssistant: true, persistResponse: true });
  } catch (err) {
    console.error(`[SubagentAnnounce] Failed direct announce to parent:`, err);
  }
}

/**
 * Run the full subagent announcement flow:
 * 1. Read child's last assistant reply
 * 2. Format announcement message
 * 3. Send to parent agent via Hub
 *
 * @deprecated Use runCoalescedAnnounceFlow instead, which supports
 * batching multiple completed runs into a single announcement.
 */
export function runSubagentAnnounceFlow(params: SubagentAnnounceParams): boolean {
  const { requesterSessionId, childSessionId } = params;

  // Read child's final output
  const findings = readLatestAssistantReply(childSessionId);

  // Format the announcement
  const message = formatAnnouncementMessage({
    runId: params.runId,
    childSessionId: params.childSessionId,
    requesterSessionId: params.requesterSessionId,
    task: params.task,
    label: params.label,
    cleanup: params.cleanup,
    outcome: params.outcome,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    findings,
  });

  // Deliver to parent agent via Hub
  try {
    const hub = getHub();
    const parentAgent = hub.getAgent(requesterSessionId);
    if (!parentAgent || parentAgent.closed) {
      console.warn(
        `[SubagentAnnounce] Parent agent not found or closed: ${requesterSessionId}`,
      );
      return false;
    }

    parentAgent.writeInternal(message, { forwardAssistant: true, persistResponse: true });
    return true;
  } catch (err) {
    console.error(`[SubagentAnnounce] Failed to announce to parent:`, err);
    return false;
  }
}
