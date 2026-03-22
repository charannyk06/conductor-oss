import type { DashboardRole } from "@conductor-oss/core/types";

export type DashboardProfileLogoutMode = "clerk" | "none";

export type DashboardProfile = {
  authenticated: boolean;
  role: DashboardRole | null;
  email: string | null;
  provider: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
  githubProfileUrl: string | null;
  canLogout: boolean;
  logoutMode: DashboardProfileLogoutMode;
};
