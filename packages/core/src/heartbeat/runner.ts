import fs from "node:fs/promises";
import path from "node:path";
import type { AsyncAgent } from "../agent/async-agent.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
} from "./heartbeat-text.js";
import {
  emitHeartbeatEvent,
  resolveIndicatorType,
  type HeartbeatEventPayload,
} from "./heartbeat-events.js";
import {
  setHeartbeatWakeHandler,
  requestHeartbeatNow,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { drainSystemEvents } from "./system-events.js";

export type HeartbeatConfig = {
  enabled?: boolean;
  every?: string;
  prompt?: string;
  ackMaxChars?: number;
};

export type HeartbeatRunner = {
  stop: () => void;
  updateConfig: () => void;
};

type RunnerDeps = {
  getAgent: () => AsyncAgent | null;
  nowMs?: () => number;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

const HEARTBEAT_FILENAME = "heartbeat.md";
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
let heartbeatsEnabled = true;

function resolveDurationMs(raw: string | undefined): number | null {
  if (!raw) return DEFAULT_INTERVAL_MS;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_INTERVAL_MS;

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (match) {
    const num = Number.parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    const ms = unitMs[unit];
    if (!Number.isFinite(num) || !ms) return null;
    const value = Math.floor(num * ms);
    return value > 0 ? value : null;
  }

  if (/^\d+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    return value > 0 ? value : null;
  }

  return null;
}


function getHeartbeatConfig(agent: AsyncAgent | null): HeartbeatConfig {
  const cfg = agent?.getHeartbeatConfig();
  if (!cfg) return {};

  const out: HeartbeatConfig = {};
  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
  if (typeof cfg.every === "string") out.every = cfg.every;
  if (typeof cfg.prompt === "string") out.prompt = cfg.prompt;
  if (typeof cfg.ackMaxChars === "number" && Number.isFinite(cfg.ackMaxChars)) {
    out.ackMaxChars = cfg.ackMaxChars;
  }
  return out;
}

function resolveHeartbeatIntervalMs(agent: AsyncAgent | null): number {
  const cfg = getHeartbeatConfig(agent);
  return resolveDurationMs(cfg.every ?? DEFAULT_HEARTBEAT_EVERY) ?? DEFAULT_INTERVAL_MS;
}

function resolveSessionKey(agent: AsyncAgent): string {
  return agent.sessionId;
}

async function isHeartbeatFileEmpty(agent: AsyncAgent): Promise<boolean> {
  const profileDir = agent.getProfileDir();
  if (!profileDir) return false;
  const heartbeatPath = path.join(profileDir, HEARTBEAT_FILENAME);

  try {
    const content = await fs.readFile(heartbeatPath, "utf-8");
    return isHeartbeatContentEffectivelyEmpty(content);
  } catch {
    return false;
  }
}

export function setHeartbeatsEnabled(enabled: boolean): void {
  heartbeatsEnabled = enabled;
}

export async function runHeartbeatOnce(opts: {
  agent: AsyncAgent | null;
  reason?: string;
  nowMs?: () => number;
}): Promise<HeartbeatRunResult> {
  const startedAt = opts.nowMs?.() ?? Date.now();
  const agent = opts.agent;

  if (!heartbeatsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }

  if (!agent || agent.closed) {
    return { status: "skipped", reason: "disabled" };
  }

  const cfg = getHeartbeatConfig(agent);
  if (cfg.enabled === false) {
    return { status: "skipped", reason: "disabled" };
  }

  if (agent.getPendingWrites() > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  try {
    const isForcedWake = opts.reason === "exec-event" || opts.reason?.startsWith("cron:");
    if (!isForcedWake && (await isHeartbeatFileEmpty(agent))) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: "empty-heartbeat-file",
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: "empty-heartbeat-file" };
    }

    await agent.ensureInitialized();
    const sessionKey = resolveSessionKey(agent);
    const pendingEvents = drainSystemEvents(sessionKey);

    const basePrompt = resolveHeartbeatPrompt(cfg.prompt);
    const prompt = pendingEvents.length
      ? `${basePrompt}\n\nSystem events:\n${pendingEvents.map((line) => `- ${line}`).join("\n")}`
      : basePrompt;

    const result = await agent.runInternalForResult(prompt);
    if (result.error) {
      throw new Error(result.error);
    }
    const text = result.text;

    if (!text.trim()) {
      const okEmptyEvent: Omit<HeartbeatEventPayload, "ts"> = {
        status: "ok-empty",
        durationMs: Date.now() - startedAt,
      };
      if (opts.reason) okEmptyEvent.reason = opts.reason;
      const indicator = resolveIndicatorType("ok-empty");
      if (indicator) okEmptyEvent.indicatorType = indicator;
      emitHeartbeatEvent(okEmptyEvent);
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const stripped = stripHeartbeatToken(text, {
      mode: "heartbeat",
      maxAckChars: cfg.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    });

    if (stripped.shouldSkip) {
      const okTokenEvent: Omit<HeartbeatEventPayload, "ts"> = {
        status: "ok-token",
        durationMs: Date.now() - startedAt,
      };
      if (opts.reason) okTokenEvent.reason = opts.reason;
      const indicator = resolveIndicatorType("ok-token");
      if (indicator) okTokenEvent.indicatorType = indicator;
      emitHeartbeatEvent(okTokenEvent);
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const sentEvent: Omit<HeartbeatEventPayload, "ts"> = {
      status: "sent",
      preview: stripped.text.slice(0, 200),
      durationMs: Date.now() - startedAt,
    };
    if (opts.reason) sentEvent.reason = opts.reason;
    const sentIndicator = resolveIndicatorType("sent");
    if (sentIndicator) sentEvent.indicatorType = sentIndicator;
    emitHeartbeatEvent(sentEvent);
    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failedEvent: Omit<HeartbeatEventPayload, "ts"> = {
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
    };
    const failedIndicator = resolveIndicatorType("failed");
    if (failedIndicator) failedEvent.indicatorType = failedIndicator;
    emitHeartbeatEvent(failedEvent);
    return { status: "failed", reason };
  }
}

export function startHeartbeatRunner(deps: RunnerDeps): HeartbeatRunner {
  const logger = deps.logger ?? console;
  const nowMs = deps.nowMs ?? (() => Date.now());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let intervalMs = resolveHeartbeatIntervalMs(deps.getAgent());
  let nextDueAtMs = nowMs() + intervalMs;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    clearTimer();

    const delay = Math.max(0, nextDueAtMs - nowMs());
    timer = setTimeout(() => {
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, delay);
    timer.unref?.();
  };

  const run: HeartbeatWakeHandler = async (params) => {
    const reason = params.reason;
    const agent = deps.getAgent();

    if (reason === "interval") {
      const now = nowMs();
      if (now < nextDueAtMs) {
        return { status: "skipped", reason: "not-due" };
      }
    }

    const result = await runHeartbeatOnce(
      reason
        ? {
            agent,
            reason,
            nowMs,
          }
        : {
            agent,
            nowMs,
          },
    );

    const activeAgent = deps.getAgent();
    intervalMs = resolveHeartbeatIntervalMs(activeAgent);
    nextDueAtMs = nowMs() + intervalMs;
    scheduleNext();

    return result;
  };

  setHeartbeatWakeHandler(run);
  scheduleNext();
  logger.info?.("[Heartbeat] runner started");

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimer();
      setHeartbeatWakeHandler(null);
      logger.info?.("[Heartbeat] runner stopped");
    },
    updateConfig: () => {
      const agent = deps.getAgent();
      intervalMs = resolveHeartbeatIntervalMs(agent);
      nextDueAtMs = nowMs() + intervalMs;
      scheduleNext();
    },
  };
}

export type { HeartbeatEventPayload };
