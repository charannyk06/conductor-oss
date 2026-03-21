"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { resolvePostSignInRedirectTarget } from "@/lib/authRedirect";

export default function SsoCallbackPage() {
  const searchParams = useSearchParams();
  const redirectTarget = resolvePostSignInRedirectTarget(
    searchParams.get("redirect_url"),
    typeof window === "undefined" ? null : window.location.origin,
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
