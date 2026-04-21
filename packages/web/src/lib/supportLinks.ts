export const CONDUCTOR_APP_URL = "https://app.conductross.com";
export const CONDUCTOR_SUPPORT_DISCUSSIONS_URL = "https://github.com/charannyk06/conductor-oss/discussions";
export const CONDUCTOR_ISSUES_URL = "https://github.com/charannyk06/conductor-oss/issues";

export function getRemoteAccessSupportMessage(code: string | null | undefined): string | null {
  if (code !== "unavailable") {
    return null;
  }

  return "If you opened a raw forwarded dashboard URL from another machine, that is expected. Plain port forwarding still counts as remote access. Use the hosted paired-device flow at app.conductross.com, or put your self-hosted dashboard behind Cloudflare Access or Clerk.";
}
