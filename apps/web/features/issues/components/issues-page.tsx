"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, ListTodo } from "lucide-react";
import type { Issue, IssueStatus } from "@/shared/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useIssueViewStore, initFilterWorkspaceSync } from "@/features/issues/stores/view-store";
import { useIssuesScopeStore } from "@/features/issues/stores/issues-scope-store";
import { ViewStoreProvider } from "@/features/issues/stores/view-store-context";
import { filterIssues } from "@/features/issues/utils/filter";
import {
  filterIssuesBySearch,
  getSearchConstrainedStatuses,
  parseIssueSearch,
} from "@/features/issues/utils/search";
import { ALL_STATUSES, BOARD_STATUSES } from "@/features/issues/config";
import { useWorkspaceStore } from "@/features/workspace";
import { WorkspaceAvatar } from "@/features/workspace";
import { useWorkspaceId } from "@core/hooks";
import { issueListOptions } from "@core/issues/queries";
import { useUpdateIssue } from "@core/issues/mutations";
import { api } from "@/shared/api";
import { useIssueSelectionStore } from "@/features/issues/stores/selection-store";
import { IssuesHeader } from "./issues-header";
import { BoardView } from "./board-view";
import { ListView } from "./list-view";
import { BatchActionToolbar } from "./batch-action-toolbar";

function mergeIssuesById(base: Issue[] | null, live: Issue[]): Issue[] {
  const byId = new Map<string, Issue>();

  for (const issue of base ?? []) {
    byId.set(issue.id, issue);
  }

  for (const issue of live) {
    byId.set(issue.id, issue);
  }

  return Array.from(byId.values());
}

export function IssuesPage() {
  const wsId = useWorkspaceId();
  const { data: allIssues = [], isLoading: loading } = useQuery(issueListOptions(wsId));
  const searchParams = useSearchParams();
  const urlSearchQuery = searchParams.get("q") ?? "";
  const workspace = useWorkspaceStore((s) => s.workspace);
  const members = useWorkspaceStore((s) => s.members);
  const agents = useWorkspaceStore((s) => s.agents);
  const scope = useIssuesScopeStore((s) => s.scope);
  const viewMode = useIssueViewStore((s) => s.viewMode);
  const statusFilters = useIssueViewStore((s) => s.statusFilters);
  const priorityFilters = useIssueViewStore((s) => s.priorityFilters);
  const assigneeFilters = useIssueViewStore((s) => s.assigneeFilters);
  const includeNoAssignee = useIssueViewStore((s) => s.includeNoAssignee);
  const creatorFilters = useIssueViewStore((s) => s.creatorFilters);
  const [searchInputValue, setSearchInputValue] = useState(urlSearchQuery);
  const [searchQuery, setSearchQueryState] = useState(urlSearchQuery);
  const isSearchComposingRef = useRef(false);
  const [searchPool, setSearchPool] = useState<Issue[] | null>(null);
  const [searchPoolWorkspaceId, setSearchPoolWorkspaceId] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const hasActiveSearch = deferredSearchQuery.trim().length > 0;
  const hasActiveFilters =
    statusFilters.length > 0 ||
    priorityFilters.length > 0 ||
    assigneeFilters.length > 0 ||
    includeNoAssignee ||
    creatorFilters.length > 0;

  const replaceSearchUrl = useCallback((nextQuery: string) => {
    const params = new URLSearchParams(window.location.search);
    if (nextQuery.trim()) {
      params.set("q", nextQuery);
    } else {
      params.delete("q");
    }

    const next = params.toString();
    window.history.replaceState(null, "", next ? `/issues?${next}` : "/issues");
  }, []);

  const applySearchQuery = useCallback((nextQuery: string) => {
    setSearchQueryState(nextQuery);
    replaceSearchUrl(nextQuery);
  }, [replaceSearchUrl]);

  const handleSearchInputChange = useCallback((nextQuery: string) => {
    setSearchInputValue(nextQuery);
    if (!isSearchComposingRef.current) {
      applySearchQuery(nextQuery);
    }
  }, [applySearchQuery]);

  const handleSearchCompositionStart = useCallback(() => {
    isSearchComposingRef.current = true;
  }, []);

  const handleSearchCompositionEnd = useCallback((nextQuery: string) => {
    isSearchComposingRef.current = false;
    setSearchInputValue(nextQuery);
    applySearchQuery(nextQuery);
  }, [applySearchQuery]);

  useEffect(() => {
    initFilterWorkspaceSync();
  }, []);

  useEffect(() => {
    setSearchInputValue(urlSearchQuery);
    setSearchQueryState(urlSearchQuery);
  }, [urlSearchQuery]);

  useEffect(() => {
    setSearchPool(null);
    setSearchPoolWorkspaceId(null);
  }, [workspace?.id]);

  useEffect(() => {
    if (!hasActiveSearch || !workspace?.id) return;
    if (searchPool && searchPoolWorkspaceId === workspace.id) return;

    let cancelled = false;
    setSearchLoading(true);

    api.listIssues({ all: true })
      .then((res) => {
        if (cancelled) return;
        setSearchPool(res.issues);
        setSearchPoolWorkspaceId(workspace.id);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        toast.error("Failed to search all issues");
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasActiveSearch, searchPool, searchPoolWorkspaceId, workspace?.id]);

  useEffect(() => {
    useIssueSelectionStore.getState().clear();
  }, [viewMode, scope, deferredSearchQuery]);

  const parsedSearch = useMemo(
    () => parseIssueSearch(deferredSearchQuery, { members, agents }),
    [agents, deferredSearchQuery, members],
  );

  const searchableIssues = useMemo(() => {
    if (!hasActiveSearch) return allIssues;
    if (searchPoolWorkspaceId !== workspace?.id) return allIssues;
    return mergeIssuesById(searchPool, allIssues);
  }, [allIssues, hasActiveSearch, searchPool, searchPoolWorkspaceId, workspace?.id]);

  // Scope pre-filter: narrow by assignee type
  const scopedIssues = useMemo(() => {
    if (scope === "members")
      return searchableIssues.filter((i) => i.assignee_type === "member");
    if (scope === "agents")
      return searchableIssues.filter((i) => i.assignee_type === "agent");
    return searchableIssues;
  }, [scope, searchableIssues]);

  const filteredIssues = useMemo(
    () =>
      filterIssues(scopedIssues, {
        statusFilters,
        priorityFilters,
        assigneeFilters,
        includeNoAssignee,
        creatorFilters,
      }),
    [
      assigneeFilters,
      creatorFilters,
      includeNoAssignee,
      priorityFilters,
      scopedIssues,
      statusFilters,
    ],
  );

  const issues = useMemo(
    () => filterIssuesBySearch(filteredIssues, parsedSearch, { members, agents }),
    [agents, filteredIssues, members, parsedSearch],
  );

  const visibleStatuses = useMemo(() => {
    const explicitSearchStatuses = getSearchConstrainedStatuses(parsedSearch);
    const explicitStatuses =
      statusFilters.length > 0 || explicitSearchStatuses
        ? ALL_STATUSES.filter((status) => {
            if (statusFilters.length > 0 && !statusFilters.includes(status)) {
              return false;
            }
            if (explicitSearchStatuses && !explicitSearchStatuses.includes(status)) {
              return false;
            }
            return true;
          })
        : null;

    if (explicitStatuses) return explicitStatuses;
    if (hasActiveSearch) {
      const resultStatuses = new Set(issues.map((issue) => issue.status));
      return ALL_STATUSES.filter((status) => resultStatuses.has(status));
    }
    return BOARD_STATUSES;
  }, [hasActiveSearch, issues, parsedSearch, statusFilters]);

  const hiddenStatuses = useMemo(() => {
    if (hasActiveSearch) return [];
    return BOARD_STATUSES.filter((s) => !visibleStatuses.includes(s));
  }, [hasActiveSearch, visibleStatuses]);

  const updateIssueMutation = useUpdateIssue();
  const handleMoveIssue = useCallback(
    (issueId: string, newStatus: IssueStatus, newPosition?: number) => {
      // Auto-switch to manual sort so drag ordering is preserved
      const viewState = useIssueViewStore.getState();
      if (viewState.sortBy !== "position") {
        viewState.setSortBy("position");
        viewState.setSortDirection("asc");
      }

      const updates: Partial<{ status: IssueStatus; position: number }> = {
        status: newStatus,
      };
      if (newPosition !== undefined) updates.position = newPosition;

      updateIssueMutation.mutate(
        { id: issueId, ...updates },
        { onError: () => toast.error("Failed to move issue") },
      );
    },
    [updateIssueMutation],
  );

  if (loading) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex min-w-52 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header 1: Workspace breadcrumb */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b px-4">
        <WorkspaceAvatar name={workspace?.name ?? "W"} size="sm" />
        <span className="text-sm text-muted-foreground">
          {workspace?.name ?? "Workspace"}
        </span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm font-medium">Issues</span>
      </div>

      {/* Header 2: Scope tabs + filters */}
      <IssuesHeader
        scopedIssues={scopedIssues}
        searchQuery={searchInputValue}
        searchLoading={searchLoading}
        resultCount={issues.length}
        onSearchQueryChange={handleSearchInputChange}
        onSearchCompositionStart={handleSearchCompositionStart}
        onSearchCompositionEnd={handleSearchCompositionEnd}
      />

      {/* Content: scrollable */}
      <ViewStoreProvider store={useIssueViewStore}>
        {scopedIssues.length === 0 && !hasActiveSearch && !hasActiveFilters ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListTodo className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm">No issues yet</p>
            <p className="text-xs">Create an issue to get started.</p>
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListTodo className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm">No issues match this search</p>
            <p className="text-xs">
              Try `#123`, `type:bug`, `module:auth`, `label:regression`, or looser keywords.
            </p>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {viewMode === "board" ? (
              <BoardView
                issues={issues}
                allIssues={issues}
                visibleStatuses={visibleStatuses}
                hiddenStatuses={hiddenStatuses}
                onMoveIssue={handleMoveIssue}
              />
            ) : (
              <ListView issues={issues} visibleStatuses={visibleStatuses} />
            )}
          </div>
        )}
        {viewMode === "list" && <BatchActionToolbar />}
      </ViewStoreProvider>
    </div>
  );
}
