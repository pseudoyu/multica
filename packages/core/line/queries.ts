import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/** Query key namespace for everything LINE-installation-related. Realtime
 * sync invalidates `installations(wsId)` on `line_installation:*` events so
 * the Settings panel updates without a manual refetch. */
export const lineKeys = {
  all: (wsId: string) => ["line", wsId] as const,
  installations: (wsId: string) => [...lineKeys.all(wsId), "installations"] as const,
};

export const lineInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: lineKeys.installations(wsId),
    queryFn: () => api.listLineInstallations(wsId),
    enabled: !!wsId,
  });
