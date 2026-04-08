import type {
  Agent,
  Issue,
  IssuePriority,
  IssueStatus,
  MemberWithUser,
} from "@/shared/types";
import { PRIORITY_CONFIG, STATUS_CONFIG, ALL_STATUSES } from "@/features/issues/config";
import type { ActorFilterValue } from "@/features/issues/stores/view-store";
import {
  getIssueTemplateSearchTerms,
  normalizeIssueTemplateType,
  parseIssueTemplateDescription,
} from "@/features/issues/utils/template";

const CLOSED_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

const TOKEN_REGEX = /(?:\S+:"[^"]+"|\S+:'[^']+'|"[^"]+"|'[^']+'|\S+)/g;

const STATUS_ALIASES: Record<string, IssueStatus> = {
  backlog: "backlog",
  todo: "todo",
  "to do": "todo",
  "in progress": "in_progress",
  inprogress: "in_progress",
  progress: "in_progress",
  "in review": "in_review",
  inreview: "in_review",
  review: "in_review",
  done: "done",
  blocked: "blocked",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const PRIORITY_ALIASES: Record<string, IssuePriority> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
  none: "none",
  "no priority": "none",
};

export type IssueSearchLifecycle = "all" | "open" | "closed";
export type IssueSearchDueState = "any" | "overdue" | "today" | "none" | "upcoming";
export type IssueSearchAssigneeState = "any" | "assigned" | "unassigned";

export interface IssueSearchContext {
  members: Pick<MemberWithUser, "user_id" | "name">[];
  agents: Pick<Agent, "id" | "name">[];
  now?: Date;
}

export interface ParsedIssueSearch {
  raw: string;
  textTerms: string[];
  issueNumber: number | null;
  statusFilters: IssueStatus[];
  priorityFilters: IssuePriority[];
  typeFilters: string[];
  versionTerms: string[];
  moduleTerms: string[];
  labelTerms: string[];
  assigneeFilters: ActorFilterValue[];
  creatorFilters: ActorFilterValue[];
  assigneeState: IssueSearchAssigneeState;
  lifecycle: IssueSearchLifecycle;
  dueState: IssueSearchDueState;
  hasDescription: boolean | null;
  forceEmpty: boolean;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function addUniqueValue<T>(items: T[], value: T) {
  if (!items.includes(value)) items.push(value);
}

function addUniqueActorFilters(target: ActorFilterValue[], next: ActorFilterValue[]) {
  for (const actor of next) {
    const exists = target.some(
      (item) => item.type === actor.type && item.id === actor.id,
    );
    if (!exists) target.push(actor);
  }
}

function parseIssueNumberToken(token: string): number | null {
  const hashMatch = token.match(/^#(\d+)$/);
  if (hashMatch) return Number(hashMatch[1]);

  const identifierMatch = token.match(/^[a-z][a-z0-9]*-(\d+)$/i);
  if (identifierMatch) return Number(identifierMatch[1]);

  return null;
}

function resolveStatus(value: string): IssueStatus | null {
  return STATUS_ALIASES[normalizeSearchText(value)] ?? null;
}

function resolvePriority(value: string): IssuePriority | null {
  return PRIORITY_ALIASES[normalizeSearchText(value)] ?? null;
}

function resolveTemplateType(value: string): string | null {
  const normalized = normalizeIssueTemplateType(value);
  return normalized ? normalizeSearchText(normalized) : null;
}

function resolveActors(
  value: string,
  context: IssueSearchContext,
): ActorFilterValue[] {
  const query = normalizeSearchText(value);
  if (!query) return [];

  const matches: ActorFilterValue[] = [];

  for (const member of context.members) {
    if (normalizeSearchText(member.name).includes(query)) {
      matches.push({ type: "member", id: member.user_id });
    }
  }

  for (const agent of context.agents) {
    if (normalizeSearchText(agent.name).includes(query)) {
      matches.push({ type: "agent", id: agent.id });
    }
  }

  return matches;
}

function getActorName(
  type: Issue["creator_type"] | Issue["assignee_type"],
  id: string | null,
  context: IssueSearchContext,
): string {
  if (!type || !id) return "";
  if (type === "member") {
    return context.members.find((member) => member.user_id === id)?.name ?? "";
  }
  return context.agents.find((agent) => agent.id === id)?.name ?? "";
}

function buildIssueHaystack(issue: Issue, context: IssueSearchContext): string {
  const parsedTemplate = parseIssueTemplateDescription(issue.description);
  const assigneeName = getActorName(issue.assignee_type, issue.assignee_id, context);
  const creatorName = getActorName(issue.creator_type, issue.creator_id, context);

  return normalizeSearchText(
    [
      issue.identifier,
      `#${issue.number}`,
      String(issue.number),
      issue.title,
      parsedTemplate.body,
      issue.status,
      STATUS_CONFIG[issue.status].label,
      issue.priority,
      PRIORITY_CONFIG[issue.priority].label,
      assigneeName,
      creatorName,
      ...getIssueTemplateSearchTerms(parsedTemplate.metadata),
    ].join(" "),
  );
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function tokenizeIssueSearch(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(TOKEN_REGEX)) {
    const rawValue = (match[0] ?? "").trim();
    const value = rawValue.includes(":") ? rawValue : unwrapQuotedValue(rawValue);
    if (value) tokens.push(value);
  }
  return tokens;
}

export function parseIssueSearch(
  query: string,
  context: IssueSearchContext,
): ParsedIssueSearch {
  const parsed: ParsedIssueSearch = {
    raw: query,
    textTerms: [],
    issueNumber: null,
    statusFilters: [],
    priorityFilters: [],
    typeFilters: [],
    versionTerms: [],
    moduleTerms: [],
    labelTerms: [],
    assigneeFilters: [],
    creatorFilters: [],
    assigneeState: "any",
    lifecycle: "all",
    dueState: "any",
    hasDescription: null,
    forceEmpty: false,
  };

  for (const token of tokenizeIssueSearch(query)) {
    const issueNumber = parseIssueNumberToken(token);
    if (issueNumber !== null) {
      if (parsed.issueNumber !== null && parsed.issueNumber !== issueNumber) {
        parsed.forceEmpty = true;
      } else {
        parsed.issueNumber = issueNumber;
      }
      continue;
    }

    if (token.startsWith("@")) {
      const matches = resolveActors(token.slice(1), context);
      if (matches.length === 0) {
        parsed.forceEmpty = true;
      } else {
        addUniqueActorFilters(parsed.assigneeFilters, matches);
      }
      continue;
    }

    const separatorIndex = token.indexOf(":");
    if (separatorIndex <= 0) {
      parsed.textTerms.push(token);
      continue;
    }

    const key = token.slice(0, separatorIndex).toLowerCase();
    const rawValue = unwrapQuotedValue(token.slice(separatorIndex + 1));
    if (!rawValue) {
      parsed.textTerms.push(token);
      continue;
    }

    switch (key) {
      case "status":
      case "state": {
        const status = resolveStatus(rawValue);
        if (!status) {
          parsed.forceEmpty = true;
          break;
        }
        addUniqueValue(parsed.statusFilters, status);
        break;
      }
      case "priority":
      case "p": {
        const priority = resolvePriority(rawValue);
        if (!priority) {
          parsed.forceEmpty = true;
          break;
        }
        addUniqueValue(parsed.priorityFilters, priority);
        break;
      }
      case "type": {
        const type = resolveTemplateType(rawValue);
        if (!type) {
          parsed.forceEmpty = true;
          break;
        }
        addUniqueValue(parsed.typeFilters, type);
        break;
      }
      case "version":
        addUniqueValue(parsed.versionTerms, normalizeSearchText(rawValue));
        break;
      case "module":
        addUniqueValue(parsed.moduleTerms, normalizeSearchText(rawValue));
        break;
      case "label":
      case "labels":
        addUniqueValue(parsed.labelTerms, normalizeSearchText(rawValue));
        break;
      case "assignee":
      case "assigned": {
        const normalizedValue = normalizeSearchText(rawValue);
        if (normalizedValue === "none" || normalizedValue === "unassigned") {
          parsed.assigneeState = "unassigned";
          break;
        }
        const matches = resolveActors(rawValue, context);
        if (matches.length === 0) {
          parsed.forceEmpty = true;
          break;
        }
        addUniqueActorFilters(parsed.assigneeFilters, matches);
        break;
      }
      case "creator":
      case "author":
      case "by": {
        const matches = resolveActors(rawValue, context);
        if (matches.length === 0) {
          parsed.forceEmpty = true;
          break;
        }
        addUniqueActorFilters(parsed.creatorFilters, matches);
        break;
      }
      case "is": {
        const normalizedValue = normalizeSearchText(rawValue);
        if (normalizedValue === "open") {
          parsed.lifecycle = "open";
        } else if (normalizedValue === "closed") {
          parsed.lifecycle = "closed";
        } else if (normalizedValue === "assigned") {
          parsed.assigneeState = "assigned";
        } else if (normalizedValue === "unassigned") {
          parsed.assigneeState = "unassigned";
        } else {
          parsed.forceEmpty = true;
        }
        break;
      }
      case "has": {
        const normalizedValue = normalizeSearchText(rawValue);
        if (normalizedValue === "description" || normalizedValue === "desc") {
          parsed.hasDescription = true;
        } else {
          parsed.forceEmpty = true;
        }
        break;
      }
      case "due": {
        const normalizedValue = normalizeSearchText(rawValue);
        if (
          normalizedValue === "today" ||
          normalizedValue === "overdue" ||
          normalizedValue === "none" ||
          normalizedValue === "upcoming"
        ) {
          parsed.dueState = normalizedValue;
        } else {
          parsed.forceEmpty = true;
        }
        break;
      }
      default:
        parsed.textTerms.push(token);
        break;
    }
  }

  return parsed;
}

export function getSearchConstrainedStatuses(
  parsed: ParsedIssueSearch,
): IssueStatus[] | null {
  if (parsed.statusFilters.length > 0) {
    return ALL_STATUSES.filter((status) => parsed.statusFilters.includes(status));
  }
  if (parsed.lifecycle === "open") {
    return ALL_STATUSES.filter((status) => !CLOSED_STATUSES.has(status));
  }
  if (parsed.lifecycle === "closed") {
    return ALL_STATUSES.filter((status) => CLOSED_STATUSES.has(status));
  }
  return null;
}

export function filterIssuesBySearch(
  issues: Issue[],
  parsed: ParsedIssueSearch,
  context: IssueSearchContext,
): Issue[] {
  if (parsed.forceEmpty) return [];

  return issues.filter((issue) => {
    const parsedTemplate = parseIssueTemplateDescription(issue.description);

    if (parsed.issueNumber !== null && issue.number !== parsed.issueNumber) {
      return false;
    }

    if (parsed.lifecycle === "open" && CLOSED_STATUSES.has(issue.status)) {
      return false;
    }

    if (parsed.lifecycle === "closed" && !CLOSED_STATUSES.has(issue.status)) {
      return false;
    }

    if (
      parsed.statusFilters.length > 0 &&
      !parsed.statusFilters.includes(issue.status)
    ) {
      return false;
    }

    if (
      parsed.priorityFilters.length > 0 &&
      !parsed.priorityFilters.includes(issue.priority)
    ) {
      return false;
    }

    if (parsed.typeFilters.length > 0) {
      if (!parsedTemplate.metadata) return false;
      const normalizedType = normalizeSearchText(parsedTemplate.metadata.type);
      if (!parsed.typeFilters.includes(normalizedType)) {
        return false;
      }
    }

    if (parsed.versionTerms.length > 0) {
      const version = normalizeSearchText(parsedTemplate.metadata?.version ?? "");
      if (!version) return false;
      if (!parsed.versionTerms.every((term) => version.includes(term))) {
        return false;
      }
    }

    if (parsed.moduleTerms.length > 0) {
      const module = normalizeSearchText(parsedTemplate.metadata?.module ?? "");
      if (!module) return false;
      if (!parsed.moduleTerms.every((term) => module.includes(term))) {
        return false;
      }
    }

    if (parsed.labelTerms.length > 0) {
      const labels = (parsedTemplate.metadata?.labels ?? []).map((label) =>
        normalizeSearchText(label),
      );
      if (labels.length === 0) return false;
      if (!parsed.labelTerms.every((term) => labels.some((label) => label.includes(term)))) {
        return false;
      }
    }

    if (parsed.assigneeState === "assigned" && !issue.assignee_id) {
      return false;
    }

    if (parsed.assigneeState === "unassigned" && issue.assignee_id) {
      return false;
    }

    if (parsed.assigneeFilters.length > 0) {
      if (!issue.assignee_type || !issue.assignee_id) return false;
      const matchesAssignee = parsed.assigneeFilters.some(
        (assignee) =>
          assignee.type === issue.assignee_type &&
          assignee.id === issue.assignee_id,
      );
      if (!matchesAssignee) return false;
    }

    if (parsed.creatorFilters.length > 0) {
      const matchesCreator = parsed.creatorFilters.some(
        (creator) =>
          creator.type === issue.creator_type && creator.id === issue.creator_id,
      );
      if (!matchesCreator) return false;
    }

    if (
      parsed.hasDescription === true &&
      (!parsedTemplate.body || parsedTemplate.body.trim().length === 0)
    ) {
      return false;
    }

    if (parsed.dueState === "none" && issue.due_date) {
      return false;
    }

    if (parsed.dueState !== "any" && parsed.dueState !== "none") {
      if (!issue.due_date) return false;
      const dueDate = new Date(issue.due_date);
      const now = parsedDateNow(context);

      if (parsed.dueState === "today" && !isSameLocalDay(dueDate, now)) {
        return false;
      }

      if (parsed.dueState === "overdue" && dueDate.getTime() >= now.getTime()) {
        return false;
      }

      if (parsed.dueState === "upcoming") {
        if (dueDate.getTime() <= now.getTime() || isSameLocalDay(dueDate, now)) {
          return false;
        }
      }
    }

    if (parsed.textTerms.length === 0) return true;

    const haystack = buildIssueHaystack(issue, context);
    return parsed.textTerms.every((term) =>
      haystack.includes(normalizeSearchText(term)),
    );
  });
}

function parsedDateNow(context: IssueSearchContext): Date {
  return context.now ? new Date(context.now) : new Date();
}
