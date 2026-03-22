import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import type { DashboardProfile } from "@/lib/dashboardProfile";

export const dynamic = "force-dynamic";

type ClerkEmailAddressLike = {
  id?: string | null;
  emailAddress?: string | null;
};

type ClerkExternalAccountLike = {
  provider?: string | null;
  username?: string | null;
  identificationId?: string | null;
  imageUrl?: string | null;
};

type ClerkUserLike = {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: ClerkEmailAddressLike[] | null;
  externalAccounts?: ClerkExternalAccountLike[] | null;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePrimaryEmail(user: ClerkUserLike | null): string | null {
  if (!user) return null;
  const emailAddresses = Array.isArray(user.emailAddresses) ? user.emailAddresses : [];
  const primaryEmailAddressId = normalizeString(user.primaryEmailAddressId);
  const primary = primaryEmailAddressId
    ? emailAddresses.find((entry) => normalizeString(entry.id) === primaryEmailAddressId)
    : null;

  return normalizeString(primary?.emailAddress) ?? normalizeString(emailAddresses[0]?.emailAddress);
}

function findGitHubAccount(user: ClerkUserLike | null): ClerkExternalAccountLike | null {
  if (!user || !Array.isArray(user.externalAccounts)) return null;
  return user.externalAccounts.find((account) => {
    const provider = normalizeString(account.provider)?.toLowerCase() ?? "";
    return provider.includes("github");
  }) ?? null;
}

function resolveGitHubUsername(account: ClerkExternalAccountLike | null): string | null {
  if (!account) return null;

  const directUsername = normalizeString(account.username);
  if (directUsername) return directUsername;

  const identificationId = normalizeString(account.identificationId);
  if (!identificationId || identificationId.includes("@")) return null;

  const githubProfileMatch = identificationId.match(/^https?:\/\/github\.com\/([^/?#]+)\/?$/i);
  if (githubProfileMatch?.[1]) {
    return githubProfileMatch[1];
  }

  return /^[a-z0-9-]+$/i.test(identificationId) ? identificationId : null;
}

function resolveDisplayName(
  firstName: string | null,
  lastName: string | null,
  githubUsername: string | null,
  username: string | null,
  email: string | null,
  provider: string | null,
): string | null {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName.length > 0) return fullName;
  if (githubUsername) return githubUsername;
  if (username) return username;
  if (email) return email;
  if (provider === "local") return "Local Admin Session";
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const access = await getDashboardAccess(request);
  const accessEmail = access.provider === "local" && access.email === "local"
    ? null
    : access.email ?? null;

  let profile: DashboardProfile = {
    authenticated: access.authenticated,
    role: access.role ?? null,
    email: accessEmail,
    provider: access.provider ?? null,
    displayName: resolveDisplayName(null, null, null, null, accessEmail, access.provider ?? null),
    firstName: null,
    lastName: null,
    username: null,
    avatarUrl: null,
    githubUsername: null,
    githubProfileUrl: null,
    canLogout: access.provider === "clerk" && access.authenticated,
    logoutMode: access.provider === "clerk" && access.authenticated ? "clerk" : "none",
  };

  if (access.provider === "clerk" && access.authenticated) {
    try {
      const user = await currentUser() as ClerkUserLike | null;
      const githubAccount = findGitHubAccount(user);
      const githubUsername = resolveGitHubUsername(githubAccount);
      const email = resolvePrimaryEmail(user) ?? accessEmail;
      const firstName = normalizeString(user?.firstName);
      const lastName = normalizeString(user?.lastName);
      const username = normalizeString(user?.username);
      const avatarUrl =
        normalizeString(githubAccount?.imageUrl)
        ?? normalizeString(user?.imageUrl)
        ?? (githubUsername ? `https://github.com/${githubUsername}.png?size=160` : null);

      profile = {
        ...profile,
        email,
        displayName: resolveDisplayName(firstName, lastName, githubUsername, username, email, access.provider),
        firstName,
        lastName,
        username,
        avatarUrl,
        githubUsername,
        githubProfileUrl: githubUsername ? `https://github.com/${githubUsername}` : null,
      };
    } catch {
      // Fall back to access-derived identity details when Clerk user hydration is unavailable.
    }
  }

  return NextResponse.json(profile, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
