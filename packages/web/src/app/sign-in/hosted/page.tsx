import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildHostedSignInRedirectUrl,
  buildSignInPath,
  getDashboardAccess,
  resolvePostSignInRedirectTarget,
} from "@/lib/auth";
import { isLoopbackHost } from "@/lib/accessControl";
import {
  resolveClerkConfiguration,
  resolveRequestBaseUrl,
  resolveRequestHostname,
} from "@/lib/clerkConfig";

type HostedSignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return value?.trim() || null;
}

export default async function HostedSignInPage({ searchParams }: HostedSignInPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const redirectTarget = resolvePostSignInRedirectTarget(firstQueryValue(resolvedSearchParams.redirect_url));
  const access = await getDashboardAccess();

  if (access.ok && access.authenticated) {
    redirect(redirectTarget);
  }

  const headerStore = await headers();
  const hostname = resolveRequestHostname(headerStore);
  const baseUrl = resolveRequestBaseUrl(headerStore);
  const clerkConfiguration = resolveClerkConfiguration(hostname, baseUrl);
  const hostedSignInUrl = isLoopbackHost(hostname)
    ? null
    : buildHostedSignInRedirectUrl(clerkConfiguration.signInUrl, baseUrl, redirectTarget);

  if (hostedSignInUrl) {
    redirect(hostedSignInUrl);
  }

  if (!clerkConfiguration.enabled || !clerkConfiguration.publishableKey) {
    redirect(buildSignInPath(redirectTarget));
  }

  const authState = await auth();

  if ("redirectToSignIn" in authState && typeof authState.redirectToSignIn === "function") {
    return authState.redirectToSignIn({ returnBackUrl: redirectTarget });
  }

  redirect(buildSignInPath(redirectTarget));
}
