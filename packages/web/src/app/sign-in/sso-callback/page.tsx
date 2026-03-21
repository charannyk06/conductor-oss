"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

export default function SsoCallbackPage() {
  return <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/sign-in" />;
}
