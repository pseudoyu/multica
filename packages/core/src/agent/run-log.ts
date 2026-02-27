/**
 * Structured Run Log
 *
 * Records agent execution events to `{sessionDir}/run-log.jsonl`.
 * Each line is a JSON object with `ts` (epoch ms) and `event` (type string).
 *
 * Enable via `MULTICA_RUN_LOG=1` env var or `enableRunLog: true` in AgentOptions.
 * CLI: `pnpm multica run --run-log "prompt"`
 *
 * ## Event Reference
 *
 * ### Lifecycle
 * - `run_start`   — Agent run begins.
 *     Fields: prompt (first 200 chars), internal, provider, model, messages (count)
 * - `run_end`     — Agent run completes.
 *     Fields: duration_ms, error (string|null), text (first 200 chars), aborted?
 *
 * ### LLM Interaction
 * - `llm_call`    — LLM API request sent.
 *     Fields: provider, model, profile, messages (count)
 * - `llm_result`  — LLM API response received.
 *     Fields: duration_ms
 *
 * ### Tool Execution
 * - `tool_start`  — Tool execution begins.
 *     Fields: tool (name), args (first 500 chars of JSON)
 * - `tool_end`    — Tool execution completes.
 *     Fields: tool (name), duration_ms, is_error, result_chars, result_summary?, error_type?
 *     result_chars: total character count of result content (survives session compaction)
 *     result_summary: short tool-specific summary (e.g. "10 results", "12.5KB", "finance/get_financial_metrics")
 *     error_type: error category when tool returned an error (e.g. "fetch_failed", "ssrf_blocked")
 *
 * ### Context Management — Preflight (before LLM call)
 * - `preflight_compact_start` — Preflight compaction triggered.
 *     Fields: utilization, trigger, messages (count), est_tokens
 * - `preflight_compact_end`   — Preflight compaction completed.
 *     Fields: messages_before, messages_after, pruned (count removed)
 * - `tool_result_pruning`     — Tool result pruning applied (Phase 1).
 *     Fields: soft_trimmed, hard_cleared, chars_saved, phase ("preflight"|"compaction"),
 *             tokens_before?, tokens_after? (present when phase="compaction")
 *
 * ### Context Management — Compaction (during session)
 * - `compaction`        — Summary compaction completed (Phase 2).
 *     Fields: removed, kept, tokens_removed, tokens_kept, reason, pruning_stats?
 * - `compaction_detail` — Detailed compaction breakdown.
 *     Fields: pre_pruning_tokens, post_compaction_tokens, messages_removed, reason, pruning_applied
 *
 * ### Delegation (Sub-Agents)
 * - `delegate_start`      — Delegate tool invoked.
 *     Fields: task_count, timeout_seconds, labels[]
 * - `delegate_task_start`  — Individual sub-agent task begins.
 *     Fields: index, label, task (first 200 chars)
 * - `delegate_task_end`    — Individual sub-agent task completes.
 *     Fields: index, label, status (ok|error|timeout), duration_ms, findings_chars, error?
 * - `delegate_end`         — All delegated tasks complete.
 *     Fields: task_count, ok, errors, timeouts, total_duration_ms
 *
 * ### Error Recovery
 * - `context_overflow`           — Context window overflow detected.
 *     Fields: attempt, messages_before
 * - `context_overflow_compacted` — Overflow recovered via compaction.
 *     Fields: messages_after, tokens_removed
 * - `context_overflow_forced`    — Overflow recovered via forced message drop.
 *     Fields: messages_before, messages_after
 * - `error_classify`             — Error classified for auth rotation.
 *     Fields: error (first 200 chars), reason, rotatable
 * - `auth_rotate`                — Auth profile rotated after error.
 *     Fields: from, to, reason
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { ensureSessionDir, resolveSessionDir, type SessionStorageOptions } from "./session/storage.js";

export interface RunLog {
  log(event: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

class FileRunLog implements RunLog {
  private readonly filePath: string;
  private buffer: string[] = [];
  private flushPromise: Promise<void> = Promise.resolve();
  private flushScheduled = false;

  constructor(sessionId: string, options?: SessionStorageOptions) {
    ensureSessionDir(sessionId, options);
    const sessionDir = resolveSessionDir(sessionId, options);
    // keep an extra guard for run-log-only writes when session dir is cleaned externally
    mkdirSync(sessionDir, { recursive: true });
    this.filePath = join(sessionDir, "run-log.jsonl");
  }

  log(event: string, data?: Record<string, unknown>): void {
    const entry = { ts: Date.now(), event, ...data };
    this.buffer.push(JSON.stringify(entry));
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.drainBuffer();
    await this.flushPromise;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Microtask flush — batches synchronous log() calls into one write
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.drainBuffer();
    });
  }

  private drainBuffer(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.join("\n") + "\n";
    this.buffer = [];
    this.flushPromise = this.flushPromise
      .then(() => appendFile(this.filePath, lines, "utf8"))
      .catch((err) => {
        console.error(`[RunLog] Write failed: ${err}`);
      });
  }
}

class NoopRunLog implements RunLog {
  log(): void {}
  async flush(): Promise<void> {}
}

export function createRunLog(
  enabled: boolean,
  sessionId: string,
  options?: SessionStorageOptions,
): RunLog {
  if (enabled) {
    return new FileRunLog(sessionId, options);
  }
  return new NoopRunLog();
}
