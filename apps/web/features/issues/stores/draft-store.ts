import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { IssueStatus, IssuePriority, IssueAssigneeType } from "@/shared/types";
import type { IssueTemplateDraft } from "@/features/issues/utils/template";
import { createEmptyIssueTemplateDraft } from "@/features/issues/utils/template";

interface IssueDraft extends IssueTemplateDraft {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  dueDate: string | null;
}

const EMPTY_DRAFT: IssueDraft = {
  title: "",
  description: "",
  status: "todo",
  priority: "none",
  assigneeType: undefined,
  assigneeId: undefined,
  dueDate: null,
  ...createEmptyIssueTemplateDraft(),
};

interface IssueDraftStore {
  currentWorkspaceId: string | null;
  draftsByWorkspace: Record<string, IssueDraft>;
  draft: IssueDraft;
  setWorkspaceContext: (workspaceId: string | null) => void;
  setDraft: (patch: Partial<IssueDraft>) => void;
  clearDraft: () => void;
  hasDraft: () => boolean;
}

export const useIssueDraftStore = create<IssueDraftStore>()(
  persist(
    (set, get) => ({
      currentWorkspaceId: null,
      draftsByWorkspace: {},
      draft: { ...EMPTY_DRAFT },
      setWorkspaceContext: (workspaceId) =>
        set((state) => ({
          currentWorkspaceId: workspaceId,
          draft: workspaceId
            ? { ...(state.draftsByWorkspace[workspaceId] ?? EMPTY_DRAFT) }
            : { ...EMPTY_DRAFT },
        })),
      setDraft: (patch) =>
        set((state) => {
          const nextDraft = { ...state.draft, ...patch };
          if (!state.currentWorkspaceId) {
            return { draft: nextDraft };
          }
          return {
            draft: nextDraft,
            draftsByWorkspace: {
              ...state.draftsByWorkspace,
              [state.currentWorkspaceId]: nextDraft,
            },
          };
        }),
      clearDraft: () =>
        set((state) => {
          if (!state.currentWorkspaceId) {
            return { draft: { ...EMPTY_DRAFT } };
          }
          const nextDrafts = { ...state.draftsByWorkspace };
          delete nextDrafts[state.currentWorkspaceId];
          return {
            draft: { ...EMPTY_DRAFT },
            draftsByWorkspace: nextDrafts,
          };
        }),
      hasDraft: () => {
        const { draft } = get();
        return !!(
          draft.title ||
          draft.description ||
          draft.type ||
          draft.version ||
          draft.module ||
          draft.labels.length > 0
        );
      },
    }),
    {
      name: "multica_issue_draft",
      partialize: (state) => ({
        currentWorkspaceId: state.currentWorkspaceId,
        draftsByWorkspace: state.draftsByWorkspace,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const workspaceId = state.currentWorkspaceId;
        state.draft = workspaceId
          ? { ...(state.draftsByWorkspace[workspaceId] ?? EMPTY_DRAFT) }
          : { ...EMPTY_DRAFT };
      },
    },
  ),
);

let _workspaceDraftSyncInitialized = false;

export function initIssueDraftWorkspaceSync() {
  if (_workspaceDraftSyncInitialized) return;
  _workspaceDraftSyncInitialized = true;

  import("@/features/workspace").then(({ useWorkspaceStore }) => {
    useIssueDraftStore.getState().setWorkspaceContext(
      useWorkspaceStore.getState().workspace?.id ?? null,
    );

    useWorkspaceStore.subscribe((state) => {
      useIssueDraftStore.getState().setWorkspaceContext(state.workspace?.id ?? null);
    });
  });
}
