"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Columns3,
  List,
  Plus,
  Bot,
  Circle,
  CircleDashed,
  CircleDot,
  CircleCheck,
  CircleX,
  CircleAlert,
  Eye,
  Minus,
  MessageSquare,
} from "lucide-react";
import type { IssueStatus, IssuePriority } from "@multica/types";
import {
  MOCK_ISSUES,
  STATUS_CONFIG,
  PRIORITY_CONFIG,
  type MockIssue,
  type MockAssignee,
} from "./_data/mock";

// ---------------------------------------------------------------------------
// Shared icon components
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<IssueStatus, typeof Circle> = {
  backlog: CircleDashed,
  todo: Circle,
  in_progress: CircleDot,
  in_review: Eye,
  done: CircleCheck,
  blocked: CircleAlert,
  cancelled: CircleX,
};

export function StatusIcon({
  status,
  className = "h-4 w-4",
}: {
  status: IssueStatus;
  className?: string;
}) {
  const Icon = STATUS_ICONS[status];
  const cfg = STATUS_CONFIG[status];
  return <Icon className={`${className} ${cfg.iconColor}`} />;
}

export function PriorityIcon({
  priority,
  className = "",
}: {
  priority: IssuePriority;
  className?: string;
}) {
  const cfg = PRIORITY_CONFIG[priority];
  if (cfg.bars === 0) {
    return <Minus className={`h-3.5 w-3.5 text-muted-foreground ${className}`} />;
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 ${cfg.color} ${className}`}
      fill="currentColor"
    >
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1 + i * 4}
          y={12 - (i + 1) * 3}
          width="3"
          height={(i + 1) * 3}
          rx="0.5"
          opacity={i < cfg.bars ? 1 : 0.2}
        />
      ))}
    </svg>
  );
}

function AssigneeAvatar({
  assignee,
  size = "sm",
}: {
  assignee: MockAssignee | null;
  size?: "sm" | "md";
}) {
  if (!assignee) return null;
  const sizeClass = size === "sm" ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-xs";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${sizeClass} ${
        assignee.type === "agent"
          ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
          : "bg-muted text-muted-foreground"
      }`}
      title={assignee.name}
    >
      {assignee.type === "agent" ? (
        <Bot className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
      ) : (
        assignee.avatar.charAt(0)
      )}
    </div>
  );
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Board View
// ---------------------------------------------------------------------------

function BoardCard({ issue }: { issue: MockIssue }) {
  return (
    <Link
      href={`/issues/${issue.id}`}
      className="block rounded-lg border bg-background p-3 transition-colors hover:border-border/80 hover:bg-accent/30"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <PriorityIcon priority={issue.priority} />
        <span>{issue.key}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug">{issue.title}</p>
      <div className="mt-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AssigneeAvatar assignee={issue.assignee} />
          {issue.comments.length > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {issue.comments.length}
            </span>
          )}
        </div>
        {issue.dueDate && (
          <span className="text-xs text-muted-foreground">
            {formatDate(issue.dueDate)}
          </span>
        )}
      </div>
    </Link>
  );
}

function BoardView() {
  const visibleStatuses: IssueStatus[] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
  ];

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {visibleStatuses.map((status) => {
        const cfg = STATUS_CONFIG[status];
        const issues = MOCK_ISSUES.filter((i) => i.status === status);
        return (
          <div key={status} className="flex w-64 shrink-0 flex-col">
            <div className="mb-2 flex items-center gap-2 px-1">
              <StatusIcon status={status} className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">{cfg.label}</span>
              <span className="text-xs text-muted-foreground">{issues.length}</span>
            </div>
            <div className="flex-1 space-y-1.5 overflow-y-auto">
              {issues.map((issue) => (
                <BoardCard key={issue.id} issue={issue} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List View
// ---------------------------------------------------------------------------

function ListRow({ issue }: { issue: MockIssue }) {
  return (
    <Link
      href={`/issues/${issue.id}`}
      className="flex h-9 items-center gap-2 px-4 text-[13px] transition-colors hover:bg-accent/50"
    >
      <PriorityIcon priority={issue.priority} />
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{issue.key}</span>
      <StatusIcon status={issue.status} className="h-3.5 w-3.5" />
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      {issue.dueDate && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDate(issue.dueDate)}
        </span>
      )}
      <AssigneeAvatar assignee={issue.assignee} />
    </Link>
  );
}

function ListView() {
  const groupOrder: IssueStatus[] = [
    "in_review",
    "in_progress",
    "todo",
    "backlog",
    "done",
  ];

  return (
    <div className="overflow-y-auto">
      {groupOrder.map((status) => {
        const cfg = STATUS_CONFIG[status];
        const issues = MOCK_ISSUES.filter((i) => i.status === status);
        if (issues.length === 0) return null;
        return (
          <div key={status}>
            <div className="flex h-8 items-center gap-2 border-b px-4">
              <StatusIcon status={status} className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">{cfg.label}</span>
              <span className="text-xs text-muted-foreground">{issues.length}</span>
            </div>
            {issues.map((issue) => (
              <ListRow key={issue.id} issue={issue} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ViewMode = "board" | "list";

export default function IssuesPage() {
  const [view, setView] = useState<ViewMode>("board");

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">All Issues</h1>
          <div className="ml-2 flex items-center rounded-md border p-0.5">
            <button
              onClick={() => setView("board")}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
                view === "board"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Columns3 className="h-3 w-3" />
              Board
            </button>
            <button
              onClick={() => setView("list")}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
                view === "list"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="h-3 w-3" />
              List
            </button>
          </div>
        </div>
        <button className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5" />
          New Issue
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {view === "board" ? <BoardView /> : <ListView />}
      </div>
    </div>
  );
}
