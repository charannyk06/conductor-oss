"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { resolvePostSignInRedirectTarget } from "@/lib/authRedirect";

type SsoCallbackClientProps = {
  defaultRedirectTarget: string;
};

export function SsoCallbackClient({ defaultRedirectTarget }: SsoCallbackClientProps) {
  const searchParams = useSearchParams();
  const redirectTarget = resolvePostSignInRedirectTarget(
    searchParams.get("redirect_url"),
    typeof window === "undefined" ? null : window.location.origin,
    defaultRedirectTarget,
  );

  return (
    <AuthenticateWithRedirectCallback
      signInForceRedirectUrl={redirectTarget}
      signInFallbackRedirectUrl={redirectTarget}
      signUpForceRedirectUrl={redirectTarget}
      signUpFallbackRedirectUrl={redirectTarget}
    />
  );
}
