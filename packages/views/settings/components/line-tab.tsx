"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, ExternalLink, Trash2 } from "@multica/ui/icons";
import { LineMark } from "./line-mark";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import { lineInstallationsOptions, lineKeys } from "@multica/core/line";
import { api } from "@multica/core/api";
import type { LineInstallation, LineLanguage } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { docsLocalePrefix } from "../../common/docs-locale";
import { openExternal } from "../../platform";
import { useLocale, useT } from "../../i18n";
import { TooltipHint } from "@multica/ui/components/common/tooltip-hint";

// LineTab is the workspace settings panel for LINE Messaging API channel
// installations, mirroring TelegramTab: listing is member-visible; the
// disconnect action is admin-only (backend-enforced; the UI hides the button
// to match). Adding a new installation flows through the Agent detail page —
// one LINE channel per agent.
export function LineTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManage =
    currentMember?.role === "owner" || currentMember?.role === "admin";

  const { data, isLoading, isError } = useQuery({
    ...lineInstallationsOptions(wsId),
    enabled: !!wsId,
  });
  const installations = data?.installations ?? [];
  const configured = data?.configured === true;

  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!disconnectTarget || disconnecting) return;
    setDisconnecting(true);
    try {
      // Await the server before touching cache/UI (repo rule: no optimistic
      // removal on flows that confirm/destroy).
      await api.deleteLineInstallation(wsId, disconnectTarget);
      await qc.invalidateQueries({ queryKey: lineKeys.installations(wsId) });
      toast.success(t(($) => $.line.toast_disconnected));
      setDisconnectTarget(null);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.line.toast_disconnect_failed),
      );
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-8">
      {isError ? (
        <Card>
          <CardContent>
            <p className="text-body text-muted-foreground">
              {t(($) => $.line.load_failed)}
            </p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent>
            <p className="text-body text-muted-foreground">{t(($) => $.line.loading)}</p>
          </CardContent>
        </Card>
      ) : !configured ? (
        <Card>
          <CardContent className="space-y-2">
            <p className="text-body font-medium">{t(($) => $.line.not_enabled_title)}</p>
            <p className="text-caption text-muted-foreground">
              {t(($) => $.line.not_enabled_description_prefix)}{" "}
              <code className="rounded-xs bg-muted px-1 py-0.5 text-micro">
                MULTICA_LINE_SECRET_KEY
              </code>{" "}
              {t(($) => $.line.not_enabled_description_suffix)}{" "}
              {t(($) => $.line.not_enabled_self_host_hint)}
            </p>
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-3">
          <h2 className="text-body font-semibold">{t(($) => $.line.connected_bots)}</h2>
          {installations.length === 0 ? (
            <Card>
              <CardContent className="space-y-2">
                <p className="text-body font-medium">{t(($) => $.line.empty_title)}</p>
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.line.empty_description_prefix)}{" "}
                  <strong>{t(($) => $.line.empty_description_cta)}</strong>{" "}
                  {t(($) => $.line.empty_description_suffix)}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="divide-y">
                {installations.map((inst) => (
                  <InstallationRow
                    key={inst.id}
                    installation={inst}
                    canManage={canManage}
                    onDisconnect={() => setDisconnectTarget(inst.id)}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </section>
      )}

      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setDisconnectTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.line.disconnect_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.line.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.line.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.line.disconnecting)
                : t(($) => $.line.disconnect)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InstallationRow({
  installation,
  canManage,
  onDisconnect,
}: {
  installation: LineInstallation;
  canManage: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const { getAgentName } = useActorName();
  const isActive = installation.status === "active";
  const agentName = getAgentName(installation.agent_id);
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <ActorAvatar
          actorType="agent"
          actorId={installation.agent_id}
          size="lg"
          enableHoverCard
          profileLink
        />
        <div className="space-y-1">
          <p className="text-body font-medium">
            {agentName}
            {installation.basic_id ? (
              <span className="ml-2 text-caption text-muted-foreground">
                {installation.basic_id}
              </span>
            ) : null}
            {!isActive && (
              <span className="ml-2 rounded-xs bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                {t(($) => $.line.revoked_badge)}
              </span>
            )}
          </p>
          <p className="text-micro text-muted-foreground">
            {t(($) => $.line.installed_at_label, {
              when: new Date(installation.installed_at).toLocaleString(locale),
            })}
          </p>
          {isActive && <WebhookUrl url={installation.webhook_url} />}
        </div>
      </div>
      {canManage && isActive && (
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          <Trash2 className="h-3 w-3" />
          {t(($) => $.line.disconnect)}
        </Button>
      )}
    </div>
  );
}

// lineDocsUrl points at the LINE integration guide on the docs site,
// localized like the Slack docs link.
function lineDocsUrl(lang: string | undefined): string {
  return `https://multica.ai/docs${docsLocalePrefix(lang)}/line-bot-integration`;
}

// LineAgentBindButton is the per-agent CTA on the agent detail page. The
// admin pastes the Messaging API channel ID and secret; the backend mints a
// stateless token, reads the bot's identity and sets the webhook endpoint on
// LINE before persisting. Visibility mirrors TelegramAgentBindButton.
export function LineAgentBindButton({
  agentId,
  agentName,
  className,
  onShowConnectedDetails,
}: {
  agentId: string;
  agentName?: string;
  className?: string;
  /** Compact read-only connected row that invokes this instead of the full
   * badge — the agent inspector passes a "jump to the Integrations tab"
   * handler so management actions live in one place. */
  onShowConnectedDetails?: () => void;
}) {
  const { t, i18n } = useT("settings");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [channelSecret, setChannelSecret] = useState("");
  const [language, setLanguage] = useState<LineLanguage>("ja");
  const [submitting, setSubmitting] = useState(false);

  const { data: listing } = useQuery({
    ...lineInstallationsOptions(wsId),
    enabled: !!wsId,
  });
  const installSupported = listing?.install_supported === true;

  const { data: members = [] } = useQuery({
    ...memberListOptions(wsId),
    enabled: !!wsId,
  });
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManage =
    currentMember?.role === "owner" || currentMember?.role === "admin";

  if (!canManage) return null;

  const existing = listing?.installations.find(
    (inst) => inst.agent_id === agentId && inst.status === "active",
  );
  if (existing) {
    return onShowConnectedDetails ? (
      <LineAgentBotStatusRow
        onClick={onShowConnectedDetails}
        className={className}
      />
    ) : (
      <LineAgentBotConnectedBadge installation={existing} className={className} />
    );
  }

  if (!installSupported) return null;

  function closeDialog() {
    if (submitting) return;
    setDialogOpen(false);
    resetForm();
  }

  function resetForm() {
    setChannelId("");
    setChannelSecret("");
    setLanguage("ja");
  }

  async function handleSubmit() {
    const channel_id = channelId.trim();
    const channel_secret = channelSecret.trim();
    if (submitting || !agentId || !channel_id || !channel_secret) return;
    setSubmitting(true);
    try {
      const installation = await api.registerLineChannel(wsId, agentId, {
        channel_id,
        channel_secret,
        language,
      });
      if (!installation.id || installation.status !== "active") {
        throw new Error("LINE connection returned an invalid installation");
      }
      // The line_installation realtime event also refreshes this list, but
      // invalidate explicitly so the connected badge appears immediately.
      await qc.invalidateQueries({ queryKey: lineKeys.installations(wsId) });
      toast.success(t(($) => $.line.connect_success_toast));
      setDialogOpen(false);
      resetForm();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.line.connect_failed_toast),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = channelId.trim() !== "" && channelSecret.trim() !== "" && !submitting;
  const languageItems = LINE_LANGUAGES.map((value) => ({
    value,
    label: t(($) => $.line[LANGUAGE_LABEL_KEY[value]]),
  }));

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid="line-agent-bind-buttons"
    >
      <TooltipHint
        label={
          agentName
            ? t(($) => $.line.bind_button_title, { agent: agentName })
            : undefined
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          disabled={!agentId}
          data-testid="line-agent-connect"
        >
          <LineMark className="h-3 w-3" />
          {t(($) => $.line.bind_button)}
        </Button>
      </TooltipHint>

      <Dialog
        open={dialogOpen}
        onOpenChange={(v) => (v ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="sm:max-w-lg" data-testid="line-connect-dialog">
          <DialogHeader>
            <DialogTitle>{t(($) => $.line.connect_dialog_title)}</DialogTitle>
          </DialogHeader>

          <p className="text-caption text-muted-foreground">
            {t(($) => $.line.connect_dialog_description)}
          </p>
          <p className="text-caption text-muted-foreground">{t(($) => $.line.https_hint)}</p>

          <button
            type="button"
            onClick={() => openExternal(lineDocsUrl(i18n.language))}
            className="inline-flex w-fit items-center gap-2 text-body font-medium text-primary underline-offset-2 hover:underline"
            data-testid="line-docs-link"
          >
            <ExternalLink className="h-4 w-4" />
            {t(($) => $.line.connect_docs_link)}
          </button>

          <div className="space-y-1.5">
            <Label htmlFor="line-channel-id">{t(($) => $.line.channel_id_label)}</Label>
            <Input
              id="line-channel-id"
              data-testid="line-channel-id"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="line-channel-secret">{t(($) => $.line.channel_secret_label)}</Label>
            <Input
              id="line-channel-secret"
              data-testid="line-channel-secret"
              type="password"
              value={channelSecret}
              onChange={(e) => setChannelSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="line-language">{t(($) => $.line.language_label)}</Label>
            <Select
              items={languageItems}
              value={language}
              onValueChange={(value) => setLanguage(value as LineLanguage)}
              disabled={submitting}
            >
              <SelectTrigger id="line-language" className="w-full" data-testid="line-language">
                <SelectValue>
                  {() => languageItems.find((item) => item.value === language)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {languageItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={closeDialog}
              disabled={submitting}
            >
              {t(($) => $.line.connect_cancel)}
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="line-connect-submit"
            >
              {submitting
                ? t(($) => $.line.connect_submitting)
                : t(($) => $.line.connect_submit)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// LineAgentBotStatusRow is the compact, read-only connected affordance the
// agent inspector renders; it deep-links into the Integrations tab.
function LineAgentBotStatusRow({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  const { t } = useT("settings");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      data-testid="line-agent-bot-status"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{t(($) => $.line.agent_bot_connected_label)}</span>
      <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

// LineAgentBotConnectedBadge is the full "already connected" affordance:
// status + Disconnect, the registered webhook URL, then an "Open in LINE"
// link that adds the bot as a friend.
function LineAgentBotConnectedBadge({
  installation,
  className,
}: {
  installation: LineInstallation;
  className?: string;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await api.deleteLineInstallation(wsId, installation.id);
      await qc.invalidateQueries({ queryKey: lineKeys.installations(wsId) });
      toast.success(t(($) => $.line.toast_disconnected));
      setConfirmOpen(false);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t(($) => $.line.toast_disconnect_failed),
      );
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="line-agent-bot-connected"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate">
            {t(($) => $.line.agent_bot_connected_label)}
            {installation.basic_id ? ` · ${installation.basic_id}` : ""}
          </span>
        </span>
        <TooltipHint label={t(($) => $.line.agent_bot_disconnect_tooltip)}>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={disconnecting}
            aria-label={t(($) => $.line.disconnect)}
            data-testid="line-agent-bot-disconnect"
          >
            <Trash2 className="h-3 w-3" />
            {disconnecting
              ? t(($) => $.line.disconnecting)
              : t(($) => $.line.disconnect)}
          </Button>
        </TooltipHint>
      </div>

      <WebhookUrl url={installation.webhook_url} />

      {installation.basic_id && (
        <TooltipHint label={t(($) => $.line.agent_bot_manage_tooltip)}>
          <button
            type="button"
            onClick={() =>
              openExternal(`https://line.me/R/ti/p/${encodeURIComponent(installation.basic_id)}`)
            }
            className="inline-flex items-center gap-1 text-caption text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {t(($) => $.line.agent_bot_manage_link)}
          </button>
        </TooltipHint>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.line.disconnect_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.line.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.line.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.line.disconnecting)
                : t(($) => $.line.disconnect)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const LINE_LANGUAGES: LineLanguage[] = ["ja", "en", "zh-Hant"];

// Language names stay in their own language in every UI locale.
const LANGUAGE_LABEL_KEY = {
  ja: "language_ja",
  en: "language_en",
  "zh-Hant": "language_zh_hant",
} as const satisfies Record<LineLanguage, string>;

// WebhookUrl shows the endpoint Multica registered on LINE at install, so an
// admin can match it against the LINE Developers Console.
function WebhookUrl({ url }: { url: string }) {
  const { t } = useT("settings");
  if (!url) return null;
  return (
    <div className="space-y-0.5" data-testid="line-webhook-url">
      <p className="text-micro text-muted-foreground">{t(($) => $.line.webhook_url_label)}</p>
      <code className="block break-all rounded-xs bg-muted px-1 py-0.5 text-micro">{url}</code>
      <p className="text-micro text-muted-foreground">{t(($) => $.line.webhook_url_note)}</p>
    </div>
  );
}
