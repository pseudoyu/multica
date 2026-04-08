import { describe, expect, it } from "vitest";
import type { Agent, Issue, MemberWithUser } from "@/shared/types";
import { filterIssuesBySearch, getSearchConstrainedStatuses, parseIssueSearch } from "./search";
import { serializeIssueTemplateDescription } from "./template";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-1",
    title: "Test issue",
    description: null,
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u-1",
    parent_issue_id: null,
    position: 0,
    due_date: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

const members: Pick<MemberWithUser, "user_id" | "name">[] = [
  { user_id: "u-1", name: "Alice Chen" },
  { user_id: "u-2", name: "Bob Wong" },
];

const agents: Pick<Agent, "id" | "name">[] = [
  { id: "a-1", name: "Fixer Bot" },
  { id: "a-2", name: "Review Agent" },
];

const context = {
  members,
  agents,
  now: new Date("2026-04-08T10:00:00Z"),
};

const issues: Issue[] = [
  makeIssue({
    id: "1",
    number: 11,
    identifier: "MUL-11",
    title: "Fix login redirect loop",
    description: serializeIssueTemplateDescription(
      {
        type: "bug",
        version: "v1.3.1",
        module: "Auth",
        labels: ["regression", "login"],
      },
      "Users bounce back to the sign-in page.",
    ),
    status: "todo",
    priority: "high",
    assignee_type: "member",
    assignee_id: "u-1",
  }),
  makeIssue({
    id: "2",
    number: 12,
    identifier: "MUL-12",
    title: "Improve issue search",
    description: "Search title, description, and actor names.",
    status: "in_progress",
    priority: "urgent",
    assignee_type: "agent",
    assignee_id: "a-1",
    creator_type: "agent",
    creator_id: "a-2",
    due_date: "2026-04-08T12:00:00Z",
  }),
  makeIssue({
    id: "3",
    number: 18,
    identifier: "MUL-18",
    title: "Archive old tickets",
    description: "",
    status: "done",
    priority: "low",
    creator_id: "u-2",
    due_date: "2026-04-07T09:00:00Z",
  }),
];

describe("parseIssueSearch", () => {
  it("extracts structured filters and quoted text", () => {
    const parsed = parseIssueSearch(
      'status:todo priority:high assignee:"Alice" "redirect loop"',
      context,
    );

    expect(parsed.statusFilters).toEqual(["todo"]);
    expect(parsed.priorityFilters).toEqual(["high"]);
    expect(parsed.assigneeFilters).toEqual([{ type: "member", id: "u-1" }]);
    expect(parsed.textTerms).toEqual(["redirect loop"]);
  });

  it("recognizes issue numbers and lifecycle shortcuts", () => {
    const parsed = parseIssueSearch("#18 is:closed", context);

    expect(parsed.issueNumber).toBe(18);
    expect(parsed.lifecycle).toBe("closed");
    expect(getSearchConstrainedStatuses(parsed)).toEqual(["done", "cancelled"]);
  });
});

describe("filterIssuesBySearch", () => {
  it("matches free text across title, description, identifier, and actor names", () => {
    const parsed = parseIssueSearch("Fixer review MUL-12", context);
    const result = filterIssuesBySearch(issues, parsed, context);

    expect(result.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("filters by assignee, creator, and explicit status tokens", () => {
    const parsed = parseIssueSearch("assignee:Fixer creator:Review status:in-progress", context);
    const result = filterIssuesBySearch(issues, parsed, context);

    expect(result.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("supports structured searches against template metadata", () => {
    const parsed = parseIssueSearch(
      "type:bug version:v1.3.1 module:auth label:regression",
      context,
    );
    const result = filterIssuesBySearch(issues, parsed, context);

    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  it("supports structured searches against custom types", () => {
    const customIssues = [
      ...issues,
      makeIssue({
        id: "4",
        number: 19,
        identifier: "MUL-19",
        title: "Track release blocker",
        description: serializeIssueTemplateDescription(
          {
            type: "Release blocker",
            version: "",
            module: "Release",
            labels: [],
          },
          "Body",
        ),
      }),
    ];
    const parsed = parseIssueSearch('type:"Release blocker"', context);
    const result = filterIssuesBySearch(customIssues, parsed, context);

    expect(result.map((issue) => issue.id)).toEqual(["4"]);
  });

  it("filters by due state and description presence", () => {
    const todayParsed = parseIssueSearch("due:today has:description", context);
    const overdueParsed = parseIssueSearch("due:overdue", context);

    expect(filterIssuesBySearch(issues, todayParsed, context).map((issue) => issue.id)).toEqual(["2"]);
    expect(filterIssuesBySearch(issues, overdueParsed, context).map((issue) => issue.id)).toEqual(["3"]);
  });

  it("supports unassigned and closed search flows", () => {
    const parsed = parseIssueSearch("is:closed is:unassigned", context);
    const result = filterIssuesBySearch(issues, parsed, context);

    expect(result.map((issue) => issue.id)).toEqual(["3"]);
  });
});
