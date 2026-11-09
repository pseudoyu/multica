// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

type MemberRole = "owner" | "admin" | "member" | "guest";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as MemberRole }],
}));
const installationsRef = vi.hoisted(() => ({
  current: {
    installations: [] as unknown[],
    configured: true,
    install_supported: true,
  },
}));
const mockRegister = vi.hoisted(() => vi.fn());
const mockDeleteInstallation = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const lineQueryErrorRef = vi.hoisted(() => ({ current: false }));
const lineQueryLoadingRef = vi.hoisted(() => ({ current: false }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) return { data: undefined, isLoading: false };
    const key = JSON.stringify(opts.queryKey);
    if (key.includes("members")) return { data: membersRef.current, isLoading: false };
    if (key.includes("installations")) {
      return {
        data: lineQueryLoadingRef.current ? undefined : installationsRef.current,
        isLoading: lineQueryLoadingRef.current,
        isError: lineQueryErrorRef.current,
      };
    }
    return { data: undefined, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getAgentName: (agentId: string) => `Agent ${agentId}`,
    getMemberName: () => "Unknown",
    getSquadName: () => "Unknown Squad",
    getActorName: () => "Unknown",
    getActorInitials: () => "??",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar" data-actor-id={actorId} />
  ),
}));

vi.mock("@multica/core/line", () => ({
  lineInstallationsOptions: () => ({
    queryKey: ["line", "installations"],
    queryFn: vi.fn(),
  }),
  lineKeys: { installations: (wsId: string) => ["line", "installations", wsId] },
}));

vi.mock("@multica/core/api", () => ({
  api: {
    registerLineChannel: mockRegister,
    deleteLineInstallation: mockDeleteInstallation,
  },
}));

vi.mock("@multica/core/auth", () => {
  const useAuthStore = Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) =>
      sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  );
  return { useAuthStore };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mockToastError, message: vi.fn() },
}));

vi.mock("../../platform", () => ({ openExternal: mockOpenExternal }));

import { LineAgentBindButton, LineTab } from "./line-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function renderUI(children: ReactNode) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>,
  );
}

function resetFixtures() {
  vi.clearAllMocks();
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  installationsRef.current = { installations: [], configured: true, install_supported: true };
  lineQueryErrorRef.current = false;
  lineQueryLoadingRef.current = false;
}

describe("LineAgentBindButton", () => {
  beforeEach(resetFixtures);

  it("submits the channel ID, secret and the default Japanese bot language", async () => {
    mockRegister.mockResolvedValue({ id: "i1", agent_id: "agent-1", status: "active" });
    renderUI(<LineAgentBindButton agentId="agent-1" agentName="Bot" />);
    await userEvent.click(screen.getByTestId("line-agent-connect"));
    const submit = await screen.findByTestId("line-connect-submit");
    const secretInput = screen.getByTestId("line-channel-secret");
    expect(secretInput).toHaveAttribute("type", "password");
    await userEvent.type(screen.getByTestId("line-channel-id"), " 1650000000 ");
    expect(submit).toBeDisabled();
    await userEvent.type(secretInput, "s3cret");
    expect(screen.getByTestId("line-language")).toHaveTextContent("日本語");
    await userEvent.click(submit);
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith("workspace-1", "agent-1", {
        channel_id: "1650000000",
        channel_secret: "s3cret",
        language: "ja",
      }),
    );
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("states the HTTPS requirement in the connect dialog", async () => {
    renderUI(<LineAgentBindButton agentId="agent-1" agentName="Bot" />);
    await userEvent.click(screen.getByTestId("line-agent-connect"));
    expect(await screen.findByText(/must use HTTPS/i)).toBeTruthy();
  });

  it("opens the localized LINE setup guide", async () => {
    renderUI(<LineAgentBindButton agentId="agent-1" agentName="Bot" />);
    await userEvent.click(screen.getByTestId("line-agent-connect"));
    await userEvent.click(await screen.findByTestId("line-docs-link"));
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://multica.ai/docs/line-bot-integration",
    );
  });

  it("does not report success for a malformed install response", async () => {
    mockRegister.mockResolvedValue({});
    renderUI(<LineAgentBindButton agentId="agent-1" agentName="Bot" />);
    await userEvent.click(screen.getByTestId("line-agent-connect"));
    await userEvent.type(await screen.findByTestId("line-channel-id"), "1650000000");
    await userEvent.type(screen.getByTestId("line-channel-secret"), "s3cret");
    await userEvent.click(screen.getByTestId("line-connect-submit"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("shows the connected badge (not the CTA) when the agent already has an active install", () => {
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-1", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineAgentBindButton agentId="agent-1" />);
    expect(screen.getByTestId("line-agent-bot-connected")).toBeTruthy();
    expect(screen.getByTestId("line-agent-bot-disconnect")).toBeTruthy();
    expect(screen.getByTestId("line-webhook-url")).toHaveTextContent(
      "https://multica.example/api/webhooks/line/i1",
    );
    expect(screen.queryByTestId("line-agent-connect")).toBeNull();
  });

  it("opens the connected bot in LINE", async () => {
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-1", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineAgentBindButton agentId="agent-1" />);

    await userEvent.click(screen.getByRole("button", { name: /Open in LINE/i }));

    expect(mockOpenExternal).toHaveBeenCalledWith("https://line.me/R/ti/p/%40123abcde");
  });

  it("disconnects an agent bot only after confirmation", async () => {
    mockDeleteInstallation.mockResolvedValue(undefined);
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-1", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineAgentBindButton agentId="agent-1" />);

    await userEvent.click(screen.getByTestId("line-agent-bot-disconnect"));
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    const actions = await screen.findAllByRole("button", { name: /^Disconnect$/i });
    await userEvent.click(actions.at(-1)!);

    await waitFor(() =>
      expect(mockDeleteInstallation).toHaveBeenCalledWith("workspace-1", "i1"),
    );
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("keeps an agent bot connected when disconnect fails", async () => {
    mockDeleteInstallation.mockRejectedValue(new Error("network failed"));
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-1", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineAgentBindButton agentId="agent-1" />);

    await userEvent.click(screen.getByTestId("line-agent-bot-disconnect"));
    const actions = await screen.findAllByRole("button", { name: /^Disconnect$/i });
    await userEvent.click(actions.at(-1)!);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("network failed"));
    expect(screen.getByTestId("line-agent-bot-connected")).toBeTruthy();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("renders nothing for a non-manager", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    const { container } = renderUI(<LineAgentBindButton agentId="agent-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when install is unavailable and the agent is unbound", () => {
    installationsRef.current = { installations: [], configured: true, install_supported: false };
    const { container } = renderUI(<LineAgentBindButton agentId="agent-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("LineTab", () => {
  beforeEach(resetFixtures);

  it("shows a loading state without claiming LINE is disabled", () => {
    lineQueryLoadingRef.current = true;
    renderUI(<LineTab />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText(/LINE integration not enabled/i)).toBeNull();
  });

  it("surfaces the not-enabled notice when the deployment has no LINE key", () => {
    installationsRef.current = { installations: [], configured: false, install_supported: false };
    renderUI(<LineTab />);
    expect(screen.getByText(/LINE integration not enabled/i)).toBeTruthy();
  });

  it("shows the empty state when configured but nothing is connected", () => {
    renderUI(<LineTab />);
    expect(screen.getByText(/No bots connected yet/i)).toBeTruthy();
  });

  it("lists a connected installation with its agent name and a disconnect control", () => {
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-7", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineTab />);
    expect(screen.getByText("Agent agent-7")).toBeTruthy();
    expect(screen.getByText("@123abcde")).toBeTruthy();
    expect(screen.getByText(/Disconnect/i)).toBeTruthy();
  });

  it("disconnects only after confirmation and refreshes the installation list", async () => {
    mockDeleteInstallation.mockResolvedValue(undefined);
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-7", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineTab />);
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    const actions = await screen.findAllByRole("button", { name: /^Disconnect$/i });
    await userEvent.click(actions.at(-1)!);
    await waitFor(() =>
      expect(mockDeleteInstallation).toHaveBeenCalledWith("workspace-1", "i1"),
    );
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("keeps the installation visible when disconnect fails", async () => {
    mockDeleteInstallation.mockRejectedValue(new Error("network failed"));
    installationsRef.current = {
      installations: [
        { id: "i1", agent_id: "agent-7", status: "active", basic_id: "@123abcde", webhook_url: "https://multica.example/api/webhooks/line/i1" },
      ],
      configured: true,
      install_supported: true,
    };
    renderUI(<LineTab />);
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    const actions = await screen.findAllByRole("button", { name: /^Disconnect$/i });
    await userEvent.click(actions.at(-1)!);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("network failed"));
    expect(screen.getByText("@123abcde")).toBeTruthy();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  // Malformed-response defense (CLAUDE.md → API Compatibility): a response
  // missing `installations` must not crash the panel.
  it("tolerates a malformed installations response", () => {
    installationsRef.current = { configured: true } as never;
    renderUI(<LineTab />);
    expect(screen.getByText(/No bots connected yet/i)).toBeTruthy();
  });

  it("shows a load error instead of pretending LINE is disabled", () => {
    lineQueryErrorRef.current = true;
    renderUI(<LineTab />);
    expect(screen.getByText(/Failed to load LINE installations/i)).toBeTruthy();
    expect(screen.queryByText(/LINE integration not enabled/i)).toBeNull();
  });
});
