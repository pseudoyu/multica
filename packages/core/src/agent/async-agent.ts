import { v7 as uuidv7 } from "uuid";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent } from "./runner.js";
import { Channel } from "./channel.js";
import type { AgentOptions, Message } from "./types.js";
import type { MulticaEvent } from "./events.js";
import { injectMessageTimestamp } from "./message-timestamp.js";
import { isSilentReplyText } from "./tokens.js";
import { isHeartbeatAckEvent } from "../hub/heartbeat-filter.js";

const devNull = { write: () => true } as unknown as NodeJS.WritableStream;

/** Discriminated union of legacy Message, raw AgentEvent, and MulticaEvent */
export type ChannelItem = Message | AgentEvent | MulticaEvent;

export interface WriteInternalOptions {
  /** Forward assistant message_end events to realtime stream during internal runs */
  forwardAssistant?: boolean | undefined;
  /** After internal run completes, persist the LLM's summary as a non-internal assistant message */
  persistResponse?: boolean | undefined;
}

export interface WriteOptions {
  /** Disable automatic message timestamp injection */
  injectTimestamp?: boolean | undefined;
}

export class AsyncAgent {
  private readonly agent: Agent;
  private readonly channel = new Channel<ChannelItem>();
  private _closed = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private closeCallbacks: Array<() => void> = [];
  private forwardInternalAssistant = false;
  private _lastRunError: string | undefined;
  readonly sessionId: string;

  constructor(options?: AgentOptions) {
    this.agent = new Agent({
      ...options,
      logger: { stdout: devNull, stderr: devNull },
    });
    this.sessionId = this.agent.sessionId;

    // Forward raw AgentEvent and MulticaEvent into the channel.
    // Suppress forwarding during internal runs to avoid leaking
    // orchestration messages to the frontend/real-time stream.
    // Also suppresses pure heartbeat ACK messages (e.g. "HEARTBEAT_OK").
    this.agent.subscribeAll(
      this.createFilteredHandler((event) => this.channel.send(event)),
    );
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Write message to agent (non-blocking, serialized queue) */
  write(content: string, options?: WriteOptions): void {
    if (this._closed) throw new Error("Agent is closed");
    this.pendingWrites += 1;
    const message =
      options?.injectTimestamp === false
        ? content
        : injectMessageTimestamp(content);

    this.queue = this.queue
      .then(async () => {
        if (this._closed) {
          console.log(`[AsyncAgent:${this.sessionId.slice(0, 8)}] write() skipped — agent closed`);
          return;
        }
        console.log(`[AsyncAgent:${this.sessionId.slice(0, 8)}] run() starting for message: ${content.slice(0, 80)}`);
        const result = await this.agent.run(message, { displayPrompt: content });
        console.log(`[AsyncAgent:${this.sessionId.slice(0, 8)}] run() completed, error=${result.error ?? "none"}`);
        // Flush pending session writes so waitForIdle() callers
        // can safely read session data from disk.
        await this.agent.flushSession();
        // Normal text is delivered via message_end event; only handle errors here
        if (result.error) {
          this._lastRunError = result.error;
          console.error(`[AsyncAgent] Agent run error: ${result.error}`);
          this.channel.send({ id: uuidv7(), content: `[error] ${result.error}` });
          // Only emit agent_error for HTTP 401 from the LLM provider so the
          // UI shows the "Configure" banner. All other errors (400, tool errors,
          // etc.) should flow back to the agent for self-recovery.
          if (/\b401\b/.test(result.error)) {
            this.agent.emitError(result.error);
          }
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this._lastRunError = message;
        console.error(`[AsyncAgent] Agent run exception: ${message}`);
        this.channel.send({ id: uuidv7(), content: `[error] ${message}` });
        // Only emit agent_error for HTTP 401 from the LLM provider so the
        // UI shows the "Configure" banner. All other errors (400, tool errors,
        // etc.) should flow back to the agent for self-recovery.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/\b401\b/.test(errMsg)) {
          this.agent.emitError(message);
        }
      })
      .finally(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      });
  }

  /**
   * Write an internal message to agent (non-blocking, serialized queue).
   * Messages are persisted with `internal: true` and rolled back from
   * in-memory state. Events are suppressed from the real-time stream by default.
   */
  writeInternal(content: string, options?: WriteInternalOptions): void {
    if (this._closed) throw new Error("Agent is closed");
    const forwardAssistant = options?.forwardAssistant === true;
    const persistResponse = options?.persistResponse === true;

    this.queue = this.queue
      .then(async () => {
        if (this._closed) return;
        const prevForward = this.forwardInternalAssistant;
        this.forwardInternalAssistant = forwardAssistant;
        try {
          const result = await this.agent.runInternal(content);
          await this.agent.flushSession();
          if (result.error) {
            // Internal run errors are for diagnostics only; do not leak to user stream.
            console.error(`[AsyncAgent] Internal run error: ${result.error}`);
          }
          // Stop forwarding BEFORE persist to avoid double-emitting the same
          // assistant message (once from runInternal streaming, once from appendMessage).
          this.forwardInternalAssistant = prevForward;
          // Persist the LLM summary so it remains in parent context for future turns
          if (persistResponse && result.text?.trim() && !isSilentReplyText(result.text)) {
            this.agent.persistAssistantSummary(result.text.trim());
            await this.agent.flushSession();
          }
        } finally {
          this.forwardInternalAssistant = prevForward;
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Internal run exceptions are for diagnostics only; do not leak to user stream.
        console.error(`[AsyncAgent] Internal run failed: ${message}`);
      });
  }

  /**
   * Run an internal prompt and return the result.
   * Serialized through the write queue. Messages are persisted with
   * `internal: true` and rolled back from in-memory state, so they
   * won't appear in UI history or `getMessages()`.
   */
  runInternalForResult(content: string): Promise<{ text: string; error?: string }> {
    if (this._closed) return Promise.resolve({ text: "", error: "Agent is closed" });
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => {
          if (this._closed) {
            resolve({ text: "", error: "Agent is closed" });
            return;
          }
          const result = await this.agent.runInternal(content);
          await this.agent.flushSession();
          resolve({ text: result.text, error: result.error });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[AsyncAgent] runInternalForResult failed: ${message}`);
          resolve({ text: "", error: message });
        });
    });
  }

  /** Continuously read channel stream (AgentEvent + error Messages) */
  read(): AsyncIterable<ChannelItem> {
    return this.channel;
  }

  /**
   * Subscribe to agent events directly (supports multiple subscribers).
   * Unlike read(), this allows multiple consumers to receive the same events.
   * Receives both pi-agent-core AgentEvent and MulticaEvent (e.g. compaction).
   */
  subscribe(callback: (event: AgentEvent | MulticaEvent) => void): () => void {
    console.log(`[AsyncAgent] Adding subscriber for agent: ${this.sessionId}`);
    const unsubscribe = this.agent.subscribeAll(
      this.createFilteredHandler((event) => {
        console.log(`[AsyncAgent] Event received: ${event.type}`);
        callback(event);
      }),
    );
    return () => {
      console.log(`[AsyncAgent] Removing subscriber for agent: ${this.sessionId}`);
      unsubscribe();
    };
  }

  /** Returns a promise that resolves when the current message queue is drained */
  waitForIdle(): Promise<void> {
    return this.queue;
  }

  /** Error message from the last run, if it failed. */
  get lastRunError(): string | undefined {
    return this._lastRunError;
  }

  /** Whether the agent is currently executing a run (normal or internal). */
  get isRunning(): boolean {
    return this.agent.isRunning;
  }

  /** Whether the underlying LLM is currently streaming a response. */
  get isStreaming(): boolean {
    return this.agent.isStreaming;
  }

  /**
   * Steer the agent mid-run. Bypasses the serial queue and injects a message
   * directly into the PiAgentCore steering queue. The message is delivered
   * after the current tool execution completes, skipping remaining tool calls.
   */
  steer(content: string): void {
    this.agent.steer(content);
  }

  /**
   * Queue a follow-up message for after the current run finishes.
   * Delivered only when the agent has no more tool calls or steering messages.
   */
  followUp(content: string): void {
    this.agent.followUp(content);
  }

  /** Whether the underlying PiAgentCore has queued steer/followUp messages. */
  hasQueuedMessages(): boolean {
    return this.agent.hasQueuedMessages();
  }

  private shouldForwardEvent(event: AgentEvent | MulticaEvent): boolean {
    if (!this.agent.isInternalRun) return true;
    if (!this.forwardInternalAssistant) return false;
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
      return false;
    }

    const maybeMessage = (event as { message?: unknown }).message;
    if (!maybeMessage || typeof maybeMessage !== "object") return false;
    return (maybeMessage as { role?: unknown }).role === "assistant";
  }

  /**
   * Wrap a forwarding callback with shouldForwardEvent + heartbeat ACK suppression.
   *
   * Mirrors Hub's pattern: buffer `message_start` for assistant messages, then
   * check subsequent events with `isHeartbeatAckEvent()`. If the message is a
   * pure heartbeat ACK (e.g. "HEARTBEAT_OK"), suppress the entire sequence.
   * Otherwise flush the buffered start and forward normally.
   */
  private createFilteredHandler(
    forward: (event: AgentEvent | MulticaEvent) => void,
  ): (event: AgentEvent | MulticaEvent) => void {
    let pendingStart: (AgentEvent | MulticaEvent) | null = null;

    return (event: AgentEvent | MulticaEvent) => {
      if (!this.shouldForwardEvent(event)) return;

      const isAssistantMsg = this.isAssistantMessageEvent(event);

      if (!isAssistantMsg) {
        // Non-assistant event: flush any pending start, then forward
        if (pendingStart) {
          forward(pendingStart);
          pendingStart = null;
        }
        forward(event);
        return;
      }

      // Assistant message event — apply heartbeat ACK suppression
      if (event.type === "message_start") {
        pendingStart = event;
        return;
      }

      // Check if this is a heartbeat ACK on content/end events
      if (isHeartbeatAckEvent(event)) {
        if (event.type === "message_end") {
          // Entire message was a heartbeat ACK — suppress it
          pendingStart = null;
        }
        return;
      }

      // Not a heartbeat ACK — flush buffered start if present, then forward
      if (pendingStart) {
        forward(pendingStart);
        pendingStart = null;
      }
      forward(event);
    };
  }

  /** Check if an event is an assistant message event (message_start/update/end with role=assistant) */
  private isAssistantMessageEvent(event: AgentEvent | MulticaEvent): boolean {
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
      return false;
    }
    const maybeMessage = (event as { message?: unknown }).message;
    if (!maybeMessage || typeof maybeMessage !== "object") return false;
    return (maybeMessage as { role?: unknown }).role === "assistant";
  }

  /** Register a callback to be invoked when the agent is closed */
  onClose(callback: () => void): void {
    if (this._closed) {
      // Already closed, fire immediately
      callback();
      return;
    }
    this.closeCallbacks.push(callback);
  }

  /** Close agent, stop all reads, fire close callbacks */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.channel.close();
    for (const cb of this.closeCallbacks) {
      try {
        cb();
      } catch {
        // Don't let callback errors prevent other callbacks
      }
    }
    this.closeCallbacks = [];
  }

  /** Get current active tool names */
  getActiveTools(): string[] {
    return this.agent.getActiveTools();
  }

  /**
   * Reload tools from credentials config.
   * Call this after updating tool status to apply changes immediately.
   */
  reloadTools(): string[] {
    return this.agent.reloadTools();
  }

  /**
   * Get all skills with their eligibility status.
   */
  getSkillsWithStatus(): Array<{
    id: string;
    name: string;
    description: string;
    source: string;
    eligible: boolean;
    reasons?: string[] | undefined;
  }> {
    return this.agent.getSkillsWithStatus();
  }

  /**
   * Get eligible skills only.
   */
  getEligibleSkills(): Array<{
    id: string;
    name: string;
    description: string;
    source: string;
  }> {
    return this.agent.getEligibleSkills();
  }

  /**
   * Reload skills from disk.
   */
  reloadSkills(): void {
    this.agent.reloadSkills();
  }

  /**
   * Set a tool's enabled status and persist to profile config.
   * Returns the new tools config, or undefined if no profile is loaded.
   */
  setToolStatus(toolName: string, enabled: boolean): { allow?: string[]; deny?: string[] } | undefined {
    return this.agent.setToolStatus(toolName, enabled);
  }

  /**
   * Get current profile ID, if any.
   */
  getProfileId(): string | undefined {
    return this.agent.getProfileId();
  }

  /**
   * Get profile directory path, if profile is enabled.
   */
  getProfileDir(): string | undefined {
    return this.agent.getProfileDir();
  }

  /**
   * Get heartbeat configuration from profile config.
   */
  getHeartbeatConfig():
    | {
        enabled?: boolean | undefined;
        every?: string | undefined;
        prompt?: string | undefined;
        ackMaxChars?: number | undefined;
      }
    | undefined {
    return this.agent.getHeartbeatConfig();
  }

  /**
   * Number of queued/in-flight writes.
   */
  getPendingWrites(): number {
    return this.pendingWrites;
  }

  /**
   * Get agent display name from profile config.
   */
  getAgentName(): string | undefined {
    return this.agent.getAgentName();
  }

  /**
   * Update agent display name in profile config.
   */
  setAgentName(name: string): void {
    this.agent.setAgentName(name);
  }

  /**
   * Get user.md content from profile.
   */
  getUserContent(): string | undefined {
    return this.agent.getUserContent();
  }

  /**
   * Update user.md content in profile.
   */
  setUserContent(content: string): void {
    this.agent.setUserContent(content);
  }

  /**
   * Reload profile from disk and rebuild system prompt.
   * Call this after updating profile files to apply changes immediately.
   */
  reloadSystemPrompt(): void {
    this.agent.reloadSystemPrompt();
  }

  /** Ensure session messages are loaded from disk (idempotent) */
  async ensureInitialized(): Promise<void> {
    return this.agent.ensureInitialized();
  }

  /**
   * Get all messages from the current session (in-memory state).
   */
  getMessages(): AgentMessage[] {
    return this.agent.getMessages();
  }

  /**
   * Load messages from session storage with filtering.
   * By default, internal messages are excluded.
   */
  loadSessionMessages(options?: { includeInternal?: boolean }): AgentMessage[] {
    return this.agent.loadSessionMessages(options);
  }

  /**
   * Load session messages for UI rendering.
   * User messages prefer displayContent when present.
   */
  loadSessionMessagesForDisplay(options?: { includeInternal?: boolean }): AgentMessage[] {
    return this.agent.loadSessionMessagesForDisplay(options);
  }

  /**
   * Get current provider and model information.
   */
  getProviderInfo(): { provider: string; model: string | undefined } {
    return this.agent.getProviderInfo();
  }

  /**
   * Switch to a different provider and/or model.
   * This updates the agent's model without recreating the session.
   */
  setProvider(providerId: string, modelId?: string): { provider: string; model: string | undefined } {
    return this.agent.setProvider(providerId, modelId);
  }

  /**
   * Test a provider connection by temporarily switching, sending a minimal prompt,
   * and restoring the previous provider. Queued through the serialization queue.
   */
  async testProvider(providerId: string, modelId?: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => {
          const prev = this.agent.getProviderInfo();
          try {
            this.agent.setProvider(providerId, modelId);
            const result = await this.agent.runInternal('Reply with just the word "OK". No other text.');
            if (result.error) {
              resolve({ ok: false, error: result.error });
            } else {
              resolve({ ok: true });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve({ ok: false, error: message });
          } finally {
            try {
              this.agent.setProvider(prev.provider, prev.model);
            } catch { /* best effort */ }
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          resolve({ ok: false, error: message });
        });
    });
  }
}
