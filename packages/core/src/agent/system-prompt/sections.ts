/**
 * System Prompt Section Builders
 *
 * Each function returns string[] (lines to include) or [] to skip.
 */

import { SAFETY_CONSTITUTION } from "./constitution.js";
import { formatRuntimeLine } from "./runtime-info.js";
import { resolveHeartbeatPrompt } from "../../heartbeat/heartbeat-text.js";
import type {
  ProfileContent,
  RuntimeInfo,
  SubagentContext,
  SystemPromptMode,
} from "./types.js";

// ─── Core tool summaries ────────────────────────────────────────────────────

/** Brief descriptions of Super Multica's built-in tools */
const CORE_TOOL_SUMMARIES: Record<string, string> = {
  read: "Read file contents",
  write: "Create or overwrite files",
  edit: "Make precise edits to files",
  glob: "Find files by glob pattern",
  exec: "Run shell commands",
  process: "Manage background exec sessions",
  web_search: "Search the web via Devv Search",
  web_fetch: "Fetch and extract readable content from a URL",
  memory_search: "Search memory files by keyword",
  sessions_spawn: "Spawn a sub-agent session",
  data: "Query structured financial and market data",
};

/** Preferred display order for tools */
const TOOL_ORDER = [
  "read",
  "write",
  "edit",
  "glob",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "memory_search",
  "sessions_spawn",
  "data",
];

// ─── Section builders ───────────────────────────────────────────────────────

/**
 * Identity section — brief identity line only.
 * Full profile content (soul.md) is loaded on-demand by the agent.
 */
export function buildIdentitySection(
  profile: ProfileContent | undefined,
  mode: SystemPromptMode,
): string[] {
  const name = profile?.config?.name;
  if (mode === "none" || mode === "minimal") {
    return name
      ? [`You are ${name}, a Super Multica agent.`]
      : ["You are a Super Multica agent."];
  }
  // full mode - just identity line, agent reads soul.md on demand
  return name
    ? [`You are ${name}, a Super Multica agent.`]
    : ["You are a Super Multica agent."];
}

/**
 * User section — no longer injected into system prompt.
 * Agent reads user.md on demand from profile directory.
 */
export function buildUserSection(
  _profile: ProfileContent | undefined,
  _mode: SystemPromptMode,
): string[] {
  // Progressive disclosure: agent reads user.md on demand
  return [];
}

/**
 * Workspace section — workspace.md content with profile directory path.
 * This is the primary profile content injected into system prompt.
 * Other profile files (soul.md, user.md, memory.md) are read on demand.
 */
export function buildWorkspaceSection(
  profile: ProfileContent | undefined,
  mode: SystemPromptMode,
  profileDir?: string,
): string[] {
  if (mode !== "full") return [];

  const lines: string[] = [];

  // Add profile directory context first
  if (profileDir) {
    lines.push(
      "## Profile",
      "",
      `Your profile directory: \`${profileDir}\``,
      "Use this as the base path for profile files (soul.md, user.md, memory.md, heartbeat.md, memory/*.md).",
      "",
      "Profile files:",
      "- `soul.md` — Your identity and values",
      "- `user.md` — Information about your user",
      "- `workspace.md` — Guidelines and conventions (below)",
      "- `memory.md` — Persistent knowledge",
      "- `heartbeat.md` — Background heartbeat loop instructions",
      "",
    );
  }

  // Add workspace.md content
  if (profile?.workspace) {
    lines.push(profile.workspace);
  }

  return lines;
}

/**
 * Memory section — no longer injected into system prompt.
 * Agent reads memory.md on demand from profile directory.
 */
export function buildMemoryFileSection(
  _profile: ProfileContent | undefined,
  _mode: SystemPromptMode,
): string[] {
  // Progressive disclosure: agent reads memory.md on demand
  return [];
}

/**
 * Heartbeat section — full mode only.
 * Keeps heartbeat protocol explicit in the agent instructions.
 */
export function buildHeartbeatSection(
  profile: ProfileContent | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode !== "full") return [];
  const prompt = resolveHeartbeatPrompt(profile?.config?.heartbeat?.prompt);
  return [
    "## Heartbeats",
    `Heartbeat prompt: ${prompt}`,
    'If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:',
    "HEARTBEAT_OK",
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
  ];
}

/**
 * Safety constitution — always included.
 */
export function buildSafetySection(includeSafety: boolean): string[] {
  if (!includeSafety) return [];
  return [SAFETY_CONSTITUTION];
}

/**
 * Tooling summary — lists active tools with descriptions.
 * Included in full and minimal modes.
 * Preserves original tool casing while deduplicating by lowercase.
 */
export function buildToolingSummary(
  tools: string[] | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode === "none" || !tools || tools.length === 0) return [];

  // Preserve original casing: first occurrence wins per normalized name
  const canonicalByNormalized = new Map<string, string>();
  for (const name of tools) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = new Set(canonicalByNormalized.keys());

  // Build ordered tool lines
  const toolLines: string[] = [];
  const seen = new Set<string>();

  // Core tools in preferred order
  for (const tool of TOOL_ORDER) {
    if (normalizedTools.has(tool) && !seen.has(tool)) {
      seen.add(tool);
      const displayName = resolveToolName(tool);
      const summary = CORE_TOOL_SUMMARIES[tool];
      toolLines.push(
        summary ? `- ${displayName}: ${summary}` : `- ${displayName}`,
      );
    }
  }

  // External/unknown tools alphabetically
  const extraTools = [...normalizedTools].filter((t) => !seen.has(t)).sort();
  for (const tool of extraTools) {
    const displayName = resolveToolName(tool);
    toolLines.push(`- ${displayName}`);
  }

  return [
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.join("\n"),
    "",
  ];
}

/**
 * Tool call style guidance — full and minimal modes.
 */
export function buildToolCallStyleSection(mode: SystemPromptMode): string[] {
  if (mode === "none") return [];
  return [
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "",
  ];
}

/**
 * Conditional tool sections — inject usage hints based on which tools are active.
 */
export function buildConditionalToolSections(
  tools: string[] | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode === "none" || !tools || tools.length === 0) return [];

  const toolSet = new Set(tools.map((t) => t.toLowerCase()));
  const lines: string[] = [];

  // Memory tools
  if (toolSet.has("memory_search")) {
    lines.push(
      "## Memory Recall",
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos:",
      "1. Run `memory_search` to find relevant entries in memory files",
      "2. Use `read` to pull needed context",
      "",
      "To update memory, use `edit` on the appropriate file:",
      "- `memory.md` — Long-term knowledge (decisions, preferences, important context)",
      "- `memory/YYYY-MM-DD.md` — Daily logs and session notes",
      "",
    );
  }

  // Subagent tools (full mode only — minimal agents cannot spawn)
  if (mode === "full" && toolSet.has("sessions_spawn")) {
    lines.push(
      "## Sub-Agents",
      "If a task is complex or long-running, spawn a sub-agent. It will do the work and report back when done.",
      "",
      "### Critical Rules",
      "- **NEVER fabricate, guess, or make up data that a sub-agent has not yet returned.** " +
        "This includes completion status — do NOT claim tasks are done until you receive actual results.",
      "- After spawning, do NOT proceed with work that depends on the sub-agent results. " +
        "You can still chat with the user, do unrelated tasks, or explain what the sub-agents are working on.",
      "- Sub-agents cannot spawn nested sub-agents.",
      "- You can use `sessions_list` to check sub-agent status if needed.",
      "",
      "### Groups and Continuation (`next`) — ALWAYS use for multi-agent tasks",
      "When spawning multiple sub-agents, **always** use `next` to define the follow-up work. " +
        "This is the standard pattern — do NOT use bare `announce: \"silent\"` for multi-agent collect-then-act workflows.",
      "",
      "```",
      "// First spawn — creates a group automatically, returns groupId",
      'sessions_spawn({ task: "Get AAPL financials", next: "Summarize all data and write a PDF report", label: "AAPL" })',
      "// → { groupId: \"grp-abc\", runId: \"...\" }",
      "",
      "// Subsequent spawns — join the same group",
      'sessions_spawn({ task: "Get MSFT financials", groupId: "grp-abc", label: "MSFT" })',
      'sessions_spawn({ task: "Get GOOG financials", groupId: "grp-abc", label: "GOOG" })',
      "```",
      "",
      "The system waits for ALL runs in the group to complete, then delivers the combined findings " +
        "plus the `next` continuation prompt back to you. You can then use tools (write files, call APIs, etc.) " +
        "to complete the follow-up work. The user is NOT blocked during this process — they can keep chatting.",
      "",
      "Use `next` whenever the user's request involves: collect data → then act on it (summarize, analyze, generate files).",
      "Without `next`, findings are summarized but no further action is taken.",
      "",
      "### Announce Modes (when not using groups)",
      "- `announce: \"immediate\"` (default): findings delivered per sub-agent as each completes.",
      "- `announce: \"silent\"`: all findings held until every silent sub-agent finishes, then delivered together.",
      "Groups always use silent collection internally — you don't need to set announce when using groupId.",
      "",
      "### Timeout Guidelines",
      "Set timeoutSeconds generously — a sub-agent that times out loses all its work.",
      "- Simple tasks (search, read, summarize): 600 (10 min, the default)",
      "- Moderate tasks (multi-step research, file downloads + analysis): 900–1200 (15–20 min)",
      "- Complex tasks (code generation, PDF creation, multi-file operations): 1200–1800 (20–30 min)",
      "When in doubt, use a longer timeout.",
      "",
    );
  }

  // Data tools
  if (toolSet.has("data")) {
    lines.push(
      "## Data Access",
      "You have access to structured financial and market data via the `data` tool.",
      'Use domain="finance" with specific actions to retrieve stock prices, financial statements, SEC filings, metrics, and more.',
      "Always specify dates in YYYY-MM-DD format. Use period='annual' or 'quarterly' or 'ttm' for financial statements.",
      "When both data and web tools are available, make a dynamic evidence decision: start from structured data, and use web tools only when external validation is needed (for example: event-driven, time-sensitive, or conflicting/incomplete evidence).",
      "Make this evidence decision internally. In final answers, present concise user-facing research rationale instead of technical decision labels unless the user asks for methodology details.",
      "",
    );
  }

  // Web tools
  if (toolSet.has("web_search") || toolSet.has("web_fetch")) {
    lines.push(
      "## Web Access",
      "You have web access. Use it when the user asks about current events, needs up-to-date information, or requests content from URLs.",
      "Prefer web_search for discovery and web_fetch for specific URLs.",
      "Web usage is conditional, not mandatory: call web tools when they materially improve evidence quality.",
      "",
    );
  }

  return lines;
}

/**
 * Skills section — wraps SkillManager output with mandatory scan instructions.
 * Full mode only.
 */
export function buildSkillsSection(
  skillsPrompt: string | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode !== "full") return [];
  const trimmed = skillsPrompt?.trim();
  if (!trimmed) return [];

  return [
    "## Skills (mandatory)",
    "Before replying: scan the available skills below.",
    "- If exactly one skill clearly applies: follow its instructions.",
    "- If multiple could apply: choose the most specific one.",
    "- If none clearly apply: skip skill invocation.",
    "",
    trimmed,
    "",
  ];
}

/**
 * Runtime info line — full and minimal modes.
 */
export function buildRuntimeSection(
  runtime: RuntimeInfo | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode === "none" || !runtime) return [];
  return ["## Runtime", formatRuntimeLine(runtime)];
}

/**
 * Time awareness section — helps the agent reason about "now" safely.
 * Included in full and minimal modes.
 */
export function buildTimeAwarenessSection(
  tools: string[] | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode === "none") return [];

  const hasExecTool = (tools ?? []).some((tool) => tool.toLowerCase() === "exec");
  const fallbackLine = hasExecTool
    ? "If a turn lacks a timestamp and exact current time matters, use `exec` with `date`."
    : "If a turn lacks a timestamp and exact current time matters, ask for clarification.";

  return [
    "## Time Awareness",
    "Incoming user messages may include a prefix like `[Wed 2026-02-09 21:15 PST]`.",
    "Treat the latest prefixed timestamp as your reference for relative time requests (today, recent, last month).",
    fallbackLine,
    "",
  ];
}

/**
 * Profile directory section — now merged into buildWorkspaceSection.
 * Kept for backwards compatibility but returns empty.
 */
export function buildProfileDirSection(
  _profileDir: string | undefined,
  _mode: SystemPromptMode,
): string[] {
  // Profile directory info is now part of workspace section
  return [];
}

/**
 * Subagent context — rules and task for child agents.
 * Minimal and none modes only.
 */
export function buildSubagentSection(
  subagent: SubagentContext | undefined,
  mode: SystemPromptMode,
): string[] {
  if (mode === "full" || !subagent) return [];

  const lines: string[] = [
    "## Subagent Rules",
    "- Stay focused on the assigned task below.",
    "- Complete the task thoroughly and report your findings.",
    "- If you encounter errors (missing API keys, permission denied, tool failures, etc.), " +
      "you MUST explicitly report them in your final message. " +
      "State exactly what failed and what is needed to fix it — " +
      "the parent agent relies on your final message to understand what happened.",
    "- Do NOT initiate side actions unrelated to the task.",
    "- Do NOT attempt to communicate with the user directly.",
    "- Do NOT spawn nested subagents.",
    "- Your session is ephemeral and will be cleaned up after completion.",
    "",
    "## Context",
    `Requester session: ${subagent.requesterSessionId}`,
    `Child session: ${subagent.childSessionId}`,
  ];

  if (subagent.label) {
    lines.push(`Label: "${subagent.label}"`);
  }

  lines.push("", "## Task", subagent.task);

  return lines;
}

/**
 * Extra system prompt — appended at the end if provided.
 */
export function buildExtraPromptSection(
  extraSystemPrompt: string | undefined,
  mode: SystemPromptMode,
): string[] {
  const trimmed = extraSystemPrompt?.trim();
  if (!trimmed) return [];

  const header =
    mode === "minimal" ? "## Subagent Context" : "## Additional Context";
  return [header, trimmed];
}
