import { getDefaultPostSignInRedirectTarget, getDashboardAccess, requiresPairedDeviceScope } from "@/lib/auth";
import { SsoCallbackClient } from "./SsoCallbackClient";

export default async function SsoCallbackPage() {
  const access = await getDashboardAccess();
  const defaultRedirectTarget = getDefaultPostSignInRedirectTarget(requiresPairedDeviceScope(access));

  return <SsoCallbackClient defaultRedirectTarget={defaultRedirectTarget} />;
}
