/** Account tokens never cross this frontend API boundary. */
export interface AiCodexAuthSession {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}
export interface AiCodexAuthPollResult {
  status: "pending" | "authorized" | "expired";
  oauthAccountId?: string;
}
export interface AiCodexAuthStatus {
  authenticated: boolean;
  accountLabel?: string;
}
