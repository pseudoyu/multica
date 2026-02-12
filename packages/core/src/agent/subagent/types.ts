/**
 * Subagent orchestration types.
 *
 * Models the lifecycle of spawned child agents:
 * created → started → ended → cleanup
 */

/** Final outcome of a subagent run */
export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string | undefined;
};

/**
 * A logical group of subagent runs that are tracked together.
 * Groups enable "collect all, then act" workflows:
 * all runs in a group must complete before the combined results
 * (plus an optional `next` continuation) are announced to the parent.
 */
export type SubagentGroup = {
  /** Unique group identifier (UUIDv7) */
  groupId: string;
  /** Session ID of the parent (requester) agent */
  requesterSessionId: string;
  /** Optional human-readable label for the group */
  label?: string | undefined;
  /** Continuation prompt executed after all runs in the group complete.
   *  Injected into the announcement so the parent agent acts on the combined findings. */
  next?: string | undefined;
  /** Timestamp when the group was created */
  createdAt: number;
};

/** Persistent record tracking a single subagent run */
export type SubagentRunRecord = {
  /** Unique run identifier (UUIDv7) */
  runId: string;
  /** Session ID of the child agent */
  childSessionId: string;
  /** Session ID of the parent (requester) agent */
  requesterSessionId: string;
  /** The task description / prompt given to the child */
  task: string;
  /** Optional human-readable label */
  label?: string | undefined;
  /** Session cleanup strategy after completion */
  cleanup: "delete" | "keep";
  /** Timestamp when the run was created */
  createdAt: number;
  /** Timestamp when the child agent started execution */
  startedAt?: number | undefined;
  /** Timestamp when the child agent finished */
  endedAt?: number | undefined;
  /** Final status of the run */
  outcome?: SubagentRunOutcome | undefined;
  /** Scheduled auto-archive time (ms since epoch) */
  archiveAtMs?: number | undefined;
  /** Whether the cleanup/announce flow has been initiated */
  cleanupHandled?: boolean | undefined;
  /** Timestamp when cleanup completed */
  cleanupCompletedAt?: number | undefined;
  /** Captured findings from the child session's last assistant reply */
  findings?: string | undefined;
  /** Whether findings have been captured (safe to delete session after this) */
  findingsCaptured?: boolean | undefined;
  /** Whether the coalesced announcement has been sent to parent */
  announced?: boolean | undefined;
  /** Announcement mode: "immediate" (default) announces per-completion,
   *  "silent" defers until all silent runs from the same requester complete. */
  announce?: "immediate" | "silent" | undefined;
  /** Group ID this run belongs to (if any). Runs in a group are announced
   *  together when all complete, regardless of the `announce` field. */
  groupId?: string | undefined;
};

/** Parameters for registering a new subagent run */
export type RegisterSubagentRunParams = {
  runId: string;
  childSessionId: string;
  requesterSessionId: string;
  task: string;
  label?: string | undefined;
  cleanup?: "delete" | "keep" | undefined;
  timeoutSeconds?: number | undefined;
  /** Callback invoked when the queue slot is acquired (used to defer childAgent.write). */
  start?: (() => void) | undefined;
  /** Announcement mode: "immediate" (default) or "silent" (defer until all silent runs complete). */
  announce?: "immediate" | "silent" | undefined;
  /** Group ID to join. Runs in a group are announced together when all complete. */
  groupId?: string | undefined;
  /** Continuation prompt for the group. Only used on group creation (first spawn).
   *  After all runs in the group complete, this prompt is included in the announcement
   *  so the parent agent can act on the combined findings (e.g. summarize, write PDF). */
  next?: string | undefined;
};

/** Parameters for the announce flow */
export type SubagentAnnounceParams = {
  runId: string;
  childSessionId: string;
  requesterSessionId: string;
  task: string;
  label?: string | undefined;
  cleanup: "delete" | "keep";
  outcome?: SubagentRunOutcome | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
};

/** Parameters for building the subagent system prompt */
export type SubagentSystemPromptParams = {
  requesterSessionId: string;
  childSessionId: string;
  label?: string | undefined;
  task: string;
  /** Tool names available to the subagent (for tooling summary in system prompt) */
  tools?: string[] | undefined;
};
