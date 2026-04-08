import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/shared/api";
import { issueKeys } from "./queries";
import { useWorkspaceId } from "@core/hooks";
import type { Issue, IssueReaction } from "@/shared/types";
import type {
  CreateIssueRequest,
  UpdateIssueRequest,
  ListIssuesResponse,
} from "@/shared/types";
import type { TimelineEntry, IssueSubscriber, Reaction } from "@/shared/types";

// ---------------------------------------------------------------------------
// Issue CRUD
// ---------------------------------------------------------------------------

export function useCreateIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateIssueRequest) => api.createIssue(data),
    onSuccess: (newIssue) => {
      qc.setQueryData<ListIssuesResponse>(issueKeys.list(wsId), (old) =>
        old
          ? { ...old, issues: [...old.issues, newIssue], total: old.total + 1 }
          : old,
      );
    },
  });
}

export function useUpdateIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateIssueRequest) =>
      api.updateIssue(id, data),
    onMutate: ({ id, ...data }) => {
      // Fire-and-forget cancelQueries — keeps onMutate synchronous so the
      // cache update happens in the same tick as mutate(). Awaiting would
      // yield to the event loop, letting @dnd-kit reset its visual state
      // before the optimistic update lands.
      qc.cancelQueries({ queryKey: issueKeys.list(wsId) });
      const prevList = qc.getQueryData<ListIssuesResponse>(issueKeys.list(wsId));
      const prevDetail = qc.getQueryData<Issue>(issueKeys.detail(wsId, id));

      qc.setQueryData<ListIssuesResponse>(issueKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              issues: old.issues.map((i) =>
                i.id === id ? { ...i, ...data } : i,
              ),
            }
          : old,
      );
      qc.setQueryData<Issue>(issueKeys.detail(wsId, id), (old) =>
        old ? { ...old, ...data } : old,
      );
      return { prevList, prevDetail, id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(issueKeys.list(wsId), ctx.prevList);
      if (ctx?.prevDetail)
        qc.setQueryData(issueKeys.detail(wsId, ctx.id), ctx.prevDetail);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: issueKeys.detail(wsId, vars.id) });
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
    },
  });
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.deleteIssue(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: issueKeys.list(wsId) });
      const prevList = qc.getQueryData<ListIssuesResponse>(issueKeys.list(wsId));
      qc.setQueryData<ListIssuesResponse>(issueKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              issues: old.issues.filter((i) => i.id !== id),
              total: old.total - 1,
            }
          : old,
      );
      qc.removeQueries({ queryKey: issueKeys.detail(wsId, id) });
      return { prevList };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prevList) qc.setQueryData(issueKeys.list(wsId), ctx.prevList);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
    },
  });
}

export function useBatchUpdateIssues() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      ids,
      updates,
    }: {
      ids: string[];
      updates: UpdateIssueRequest;
    }) => api.batchUpdateIssues(ids, updates),
    onMutate: async ({ ids, updates }) => {
      await qc.cancelQueries({ queryKey: issueKeys.list(wsId) });
      const prevList = qc.getQueryData<ListIssuesResponse>(issueKeys.list(wsId));
      qc.setQueryData<ListIssuesResponse>(issueKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              issues: old.issues.map((i) =>
                ids.includes(i.id) ? { ...i, ...updates } : i,
              ),
            }
          : old,
      );
      return { prevList };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(issueKeys.list(wsId), ctx.prevList);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
    },
  });
}

export function useBatchDeleteIssues() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (ids: string[]) => api.batchDeleteIssues(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: issueKeys.list(wsId) });
      const prevList = qc.getQueryData<ListIssuesResponse>(issueKeys.list(wsId));
      qc.setQueryData<ListIssuesResponse>(issueKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              issues: old.issues.filter((i) => !ids.includes(i.id)),
              total: old.total - ids.length,
            }
          : old,
      );
      return { prevList };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.prevList) qc.setQueryData(issueKeys.list(wsId), ctx.prevList);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Comments / Timeline
// ---------------------------------------------------------------------------

export function useCreateComment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      content,
      type,
      parentId,
      attachmentIds,
    }: {
      content: string;
      type?: string;
      parentId?: string;
      attachmentIds?: string[];
    }) => api.createComment(issueId, content, type, parentId, attachmentIds),
    onSuccess: (comment) => {
      qc.setQueryData<TimelineEntry[]>(
        issueKeys.timeline(issueId),
        (old) => {
          if (!old) return old;
          const entry: TimelineEntry = {
            type: "comment",
            id: comment.id,
            actor_type: comment.author_type,
            actor_id: comment.author_id,
            content: comment.content,
            parent_id: comment.parent_id,
            comment_type: comment.type,
            reactions: comment.reactions ?? [],
            attachments: comment.attachments ?? [],
            created_at: comment.created_at,
            updated_at: comment.updated_at,
          };
          if (old.some((e) => e.id === comment.id)) return old;
          return [...old, entry];
        },
      );
    },
  });
}

export function useUpdateComment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, content }: { commentId: string; content: string }) =>
      api.updateComment(commentId, content),
    onMutate: async ({ commentId, content }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId) });
      const prev = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId));
      qc.setQueryData<TimelineEntry[]>(
        issueKeys.timeline(issueId),
        (old) =>
          old?.map((e) => (e.id === commentId ? { ...e, content } : e)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.timeline(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

export function useDeleteComment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.deleteComment(commentId),
    onMutate: async (commentId) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId) });
      const prev = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId));

      // Cascade: collect all child comment IDs
      const toRemove = new Set<string>([commentId]);
      if (prev) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const e of prev) {
            if (e.parent_id && toRemove.has(e.parent_id) && !toRemove.has(e.id)) {
              toRemove.add(e.id);
              changed = true;
            }
          }
        }
      }

      qc.setQueryData<TimelineEntry[]>(
        issueKeys.timeline(issueId),
        (old) => old?.filter((e) => !toRemove.has(e.id)),
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.timeline(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

export function useToggleCommentReaction(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      commentId,
      emoji,
      existing,
    }: {
      commentId: string;
      emoji: string;
      existing: Reaction | undefined;
    }) => {
      if (existing) {
        await api.removeReaction(commentId, emoji);
        return null;
      }
      return api.addReaction(commentId, emoji);
    },
    onMutate: async ({ commentId, emoji, existing }) => {
      await qc.cancelQueries({ queryKey: issueKeys.timeline(issueId) });
      const prev = qc.getQueryData<TimelineEntry[]>(issueKeys.timeline(issueId));

      if (existing) {
        // Remove
        qc.setQueryData<TimelineEntry[]>(
          issueKeys.timeline(issueId),
          (old) =>
            old?.map((e) =>
              e.id === commentId
                ? {
                    ...e,
                    reactions: (e.reactions ?? []).filter(
                      (r) => r.id !== existing.id,
                    ),
                  }
                : e,
            ),
        );
      } else {
        // Add temp
        const tempReaction: Reaction = {
          id: `temp-${Date.now()}`,
          comment_id: commentId,
          actor_type: "",
          actor_id: "",
          emoji,
          created_at: new Date().toISOString(),
        };
        qc.setQueryData<TimelineEntry[]>(
          issueKeys.timeline(issueId),
          (old) =>
            old?.map((e) =>
              e.id === commentId
                ? { ...e, reactions: [...(e.reactions ?? []), tempReaction] }
                : e,
            ),
        );
      }
      return { prev };
    },
    onSuccess: (reaction, { commentId }) => {
      if (reaction) {
        // Replace temp with real
        qc.setQueryData<TimelineEntry[]>(
          issueKeys.timeline(issueId),
          (old) =>
            old?.map((e) =>
              e.id === commentId
                ? {
                    ...e,
                    reactions: (e.reactions ?? []).map((r) =>
                      r.id.startsWith("temp-") && r.emoji === reaction.emoji
                        ? reaction
                        : r,
                    ),
                  }
                : e,
            ),
        );
      }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.timeline(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Issue-level Reactions
// ---------------------------------------------------------------------------

export function useToggleIssueReaction(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      emoji,
      existing,
    }: {
      emoji: string;
      existing: IssueReaction | undefined;
    }) => {
      if (existing) {
        await api.removeIssueReaction(issueId, emoji);
        return null;
      }
      return api.addIssueReaction(issueId, emoji);
    },
    onMutate: async ({ emoji, existing }) => {
      await qc.cancelQueries({ queryKey: issueKeys.reactions(issueId) });
      const prev = qc.getQueryData<IssueReaction[]>(issueKeys.reactions(issueId));

      if (existing) {
        qc.setQueryData<IssueReaction[]>(
          issueKeys.reactions(issueId),
          (old) => old?.filter((r) => r.id !== existing.id),
        );
      } else {
        const temp: IssueReaction = {
          id: `temp-${Date.now()}`,
          issue_id: issueId,
          actor_type: "",
          actor_id: "",
          emoji,
          created_at: new Date().toISOString(),
        };
        qc.setQueryData<IssueReaction[]>(
          issueKeys.reactions(issueId),
          (old) => [...(old ?? []), temp],
        );
      }
      return { prev };
    },
    onSuccess: (reaction) => {
      if (reaction) {
        qc.setQueryData<IssueReaction[]>(
          issueKeys.reactions(issueId),
          (old) =>
            old?.map((r) =>
              r.id.startsWith("temp-") && r.emoji === reaction.emoji
                ? reaction
                : r,
            ),
        );
      }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.reactions(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.reactions(issueId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Issue Subscribers
// ---------------------------------------------------------------------------

export function useToggleIssueSubscriber(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      userType,
      subscribed,
    }: {
      userId: string;
      userType: "member" | "agent";
      subscribed: boolean;
    }) => {
      if (subscribed) {
        await api.unsubscribeFromIssue(issueId, userId, userType);
      } else {
        await api.subscribeToIssue(issueId, userId, userType);
      }
    },
    onMutate: async ({ userId, userType, subscribed }) => {
      await qc.cancelQueries({ queryKey: issueKeys.subscribers(issueId) });
      const prev = qc.getQueryData<IssueSubscriber[]>(
        issueKeys.subscribers(issueId),
      );

      if (subscribed) {
        qc.setQueryData<IssueSubscriber[]>(
          issueKeys.subscribers(issueId),
          (old) =>
            old?.filter(
              (s) => !(s.user_id === userId && s.user_type === userType),
            ),
        );
      } else {
        const temp: IssueSubscriber = {
          issue_id: issueId,
          user_type: userType,
          user_id: userId,
          reason: "manual",
          created_at: new Date().toISOString(),
        };
        qc.setQueryData<IssueSubscriber[]>(
          issueKeys.subscribers(issueId),
          (old) => {
            if (
              old?.some(
                (s) => s.user_id === userId && s.user_type === userType,
              )
            )
              return old;
            return [...(old ?? []), temp];
          },
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(issueKeys.subscribers(issueId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.subscribers(issueId) });
    },
  });
}
