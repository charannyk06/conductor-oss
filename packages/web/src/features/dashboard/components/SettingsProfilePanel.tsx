"use client";

import { SignOutButton } from "@clerk/nextjs";
import { MarkGithubIcon } from "@primer/octicons-react";
import { Loader2, LogOut, RefreshCcw } from "lucide-react";
import type { DashboardProfile } from "@/lib/dashboardProfile";

type SettingsProfilePanelProps = {
  profile: DashboardProfile | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

function formatProviderLabel(provider: string | null): string {
  switch (provider) {
    case "clerk":
      return "Clerk";
    case "cloudflare-access":
      return "Cloudflare Access";
    case "trusted-header":
      return "Verified Header";
    case "local":
      return "Local";
    default:
      return "Unknown";
  }
}

function formatRoleLabel(role: DashboardProfile["role"]): string {
  if (!role) return "No access";
  return role
    .split("-")
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatSessionLabel(profile: DashboardProfile | null): string {
  if (!profile) return "Unknown";
  if (profile.provider === "local") return "Local admin session";
  if (profile.authenticated) return "Authenticated";
  return "Anonymous";
}

function ProfileDetailCard({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string | null;
}) {
  return (
    <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
      <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block break-all text-[14px] text-[var(--vk-orange)] hover:underline"
        >
          {value}
        </a>
      ) : (
        <p className="mt-2 break-all text-[14px] text-[var(--vk-text-normal)]">{value}</p>
      )}
    </div>
  );
}

function ProfileAvatar({ profile }: { profile: DashboardProfile | null }) {
  const initialsSource = profile?.displayName ?? profile?.email ?? "User";
  const initials = initialsSource
    .split(/[\s@._-]+/g)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);

  if (profile?.avatarUrl) {
    return (
      <img
        src={profile.avatarUrl}
        alt={profile.displayName ?? profile.email ?? "Profile avatar"}
        className="h-20 w-20 rounded-full border border-[var(--vk-border)] object-cover shadow-[0_10px_30px_rgba(0,0,0,0.28)]"
      />
    );
  }

  return (
    <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[rgba(234,122,42,0.12)] text-[26px] font-semibold text-[var(--vk-orange)]">
      {initials || "U"}
    </div>
  );
}

export function SettingsProfilePanel({
  profile,
  loading,
  error,
  onRefresh,
}: SettingsProfilePanelProps) {
  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] px-4 py-4 text-[13px] text-[var(--vk-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading profile details...
      </section>
    );
  }

  if (error && !profile) {
    return (
      <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
        <div>
          <h4 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">Profile Unavailable</h4>
          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
            Conductor could not load the active user profile for this session.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-9 items-center gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Retry
        </button>
      </section>
    );
  }

  const displayName = profile?.displayName ?? "Unknown user";
  const email = profile?.email ?? "Not available";
  const githubValue = profile?.githubUsername ? `@${profile.githubUsername}` : "Not linked";

  return (
    <div className="space-y-5">
      <section className="rounded-[6px] border border-[var(--vk-border)] px-5 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <ProfileAvatar profile={profile} />
            <div className="min-w-0">
              <h4 className="truncate text-[24px] leading-[26px] text-[var(--vk-text-strong)]">{displayName}</h4>
              <p className="mt-1 truncate text-[14px] text-[var(--vk-text-muted)]">{email}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1 text-[var(--vk-text-normal)]">
                  {formatRoleLabel(profile?.role ?? null)}
                </span>
                <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1 text-[var(--vk-text-normal)]">
                  {formatProviderLabel(profile?.provider ?? null)}
                </span>
                <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1 text-[var(--vk-text-normal)]">
                  {formatSessionLabel(profile)}
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-9 items-center gap-2 self-start rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <ProfileDetailCard label="Display Name" value={displayName} />
        <ProfileDetailCard label="Email" value={email} />
        <ProfileDetailCard label="GitHub" value={githubValue} href={profile?.githubProfileUrl ?? null} />
        <ProfileDetailCard label="Username" value={profile?.username ?? "Not available"} />
        <ProfileDetailCard label="Auth Provider" value={formatProviderLabel(profile?.provider ?? null)} />
        <ProfileDetailCard label="Access Role" value={formatRoleLabel(profile?.role ?? null)} />
      </section>

      <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
        <div className="space-y-1">
          <h5 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">Session Actions</h5>
          <p className="text-[12px] text-[var(--vk-text-muted)]">
            Review how this browser session is authenticated and sign out when Conductor owns the session lifecycle.
          </p>
        </div>

        {profile?.canLogout && profile.logoutMode === "clerk" ? (
          <SignOutButton redirectUrl="/sign-in">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)]"
            >
              <LogOut className="h-3.5 w-3.5" />
              Log Out
            </button>
          </SignOutButton>
        ) : (
          <div className="rounded-[6px] border border-[var(--vk-border)] bg-[rgba(80,80,80,0.18)] px-3 py-3 text-[12px] leading-5 text-[var(--vk-text-muted)]">
            {profile?.provider === "local"
              ? "This is a local recovery session on the current machine, so there is nothing to sign out of."
              : `This session is managed by ${formatProviderLabel(profile?.provider ?? null)}. Sign out from that provider if you need to end access.`}
          </div>
        )}

        {profile?.githubProfileUrl && (
          <a
            href={profile.githubProfileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-[13px] text-[var(--vk-orange)] hover:underline"
          >
            <MarkGithubIcon size={14} />
            Open GitHub Profile
          </a>
        )}
      </section>
    </div>
  );
}
