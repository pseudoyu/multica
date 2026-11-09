/** Bot copy language, chosen per installation at install time. */
export type LineLanguage = "ja" | "en" | "zh-Hant";

/** A LINE Messaging API channel installation bound to a single Multica agent.
 *
 * Wire shape mirrors `LineInstallationResponse` in
 * `server/internal/handler/line.go`. New fields the backend adds in the
 * future MUST default to optional so older desktop builds keep parsing the
 * response — see CLAUDE.md → API Compatibility. */
export interface LineInstallation {
  id: string;
  workspace_id: string;
  agent_id: string;
  /** The bot's LINE user id (the webhook `destination`). */
  bot_user_id: string;
  /** The Messaging API channel id the admin pasted. */
  channel_id: string;
  /** The Official Account's basic id, such as `@123abcde`. */
  basic_id: string;
  display_name: string;
  language: LineLanguage | string;
  /** The webhook endpoint Multica set on LINE at install time. */
  webhook_url: string;
  installer_user_id: string;
  status: "active" | "revoked" | string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListLineInstallationsResponse {
  installations: LineInstallation[];
  /** Whether the deployment has the at-rest secret key configured. */
  configured: boolean;
  /** Whether the install path is available. Optional so an older desktop
   * build that predates it treats it as off. */
  install_supported?: boolean;
}

/** Request body for an install: the channel credentials from the LINE
 * Developers Console. The backend mints a stateless token from them and sets
 * the webhook endpoint before persisting. */
export interface RegisterLineRequest {
  channel_id: string;
  channel_secret: string;
  language: LineLanguage;
}

/** Post-redemption echo: the LINE user id the token carried is now bound to
 * the logged-in Multica user in this workspace/installation. */
export interface RedeemLineBindingTokenResponse {
  workspace_id: string;
  installation_id: string;
  line_user_id: string;
}
