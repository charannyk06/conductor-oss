import type {
  DashboardAccessConfig,
  DashboardRole,
  DashboardRoleBindings,
} from "@conductor-oss/core/types";

export type RoleRequirement = DashboardRole;

const ROLE_WEIGHT: Record<DashboardRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function roleBindingsConfigured(bindings?: DashboardRoleBindings | null): boolean {
  if (!bindings) return false;
  return (
    normalizeList(bindings.viewers).length > 0 ||
    normalizeList(bindings.operators).length > 0 ||
    normalizeList(bindings.admins).length > 0 ||
    normalizeList(bindings.viewerDomains).length > 0 ||
    normalizeList(bindings.operatorDomains).length > 0 ||
    normalizeList(bindings.adminDomains).length > 0
  );
}

function matchesDomain(email: string, domains: string[]): boolean {
  return domains.some((domain) => email.endsWith(`@${domain}`));
}

function matchesEmailOrDomain(email: string, emails: string[], domains: string[]): boolean {
  return emails.includes(email) || matchesDomain(email, domains);
}

export function isLoopbackHost(hostname: string | null | undefined): boolean {
  const normalized = (hostname ?? "").trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || normalized === "[::1]";
}

export function roleMeetsRequirement(
  actualRole: DashboardRole,
  requiredRole: RoleRequirement,
): boolean {
  return ROLE_WEIGHT[actualRole] >= ROLE_WEIGHT[requiredRole];
}

export function resolveRoleForEmail(
  email: string,
  access: DashboardAccessConfig | null | undefined,
  envFallback?: {
    allowedEmails?: string[];
    allowedDomains?: string[];
    adminEmails?: string[];
  },
): {
  role: DashboardRole | null;
  matchedBinding: boolean;
  explicitBindingsConfigured: boolean;
} {
  const normalizedEmail = email.trim().toLowerCase();
  const bindings = access?.roles;

  const adminEmails = [
    ...normalizeList(bindings?.admins),
    ...normalizeList(envFallback?.adminEmails),
  ];
  const operatorEmails = [
    ...normalizeList(bindings?.operators),
    ...normalizeList(envFallback?.allowedEmails),
  ];
  const viewerEmails = normalizeList(bindings?.viewers);

  const adminDomains = normalizeList(bindings?.adminDomains);
  const operatorDomains = [
    ...normalizeList(bindings?.operatorDomains),
    ...normalizeList(envFallback?.allowedDomains),
  ];
  const viewerDomains = normalizeList(bindings?.viewerDomains);

  const explicitBindingsConfigured =
    roleBindingsConfigured(bindings) ||
    adminEmails.length > 0 ||
    operatorEmails.length > 0 ||
    operatorDomains.length > 0;

  if (matchesEmailOrDomain(normalizedEmail, adminEmails, adminDomains)) {
    return { role: "admin", matchedBinding: true, explicitBindingsConfigured };
  }
  if (matchesEmailOrDomain(normalizedEmail, operatorEmails, operatorDomains)) {
    return { role: "operator", matchedBinding: true, explicitBindingsConfigured };
  }
  if (matchesEmailOrDomain(normalizedEmail, viewerEmails, viewerDomains)) {
    return { role: "viewer", matchedBinding: true, explicitBindingsConfigured };
  }

  if (access?.defaultRole) {
    return { role: access.defaultRole, matchedBinding: false, explicitBindingsConfigured };
  }

  if (explicitBindingsConfigured) {
    return { role: null, matchedBinding: false, explicitBindingsConfigured };
  }

  return { role: "operator", matchedBinding: false, explicitBindingsConfigured };
}
