import Link from "next/link";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { Button } from "@/components/ui/Button";
import BridgeConnectClient from "@/features/bridge/BridgeConnectClient";
import { getDashboardAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type BridgeConnectPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return value?.trim() || null;
}

export default async function BridgeConnectPage({ searchParams }: BridgeConnectPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const claimToken = firstQueryValue(resolvedSearchParams.claim);
  const access = await getDashboardAccess();
  const requiresSignIn = access.provider === "clerk" && !access.authenticated;

  if (requiresSignIn) {
    const redirectTarget = claimToken
      ? `/bridge/connect?claim=${encodeURIComponent(claimToken)}`
      : "/bridge/connect";

    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <PublicPanel className="p-6 sm:p-8">
            <PublicSection
              eyebrow="Conductor Bridge"
              title="Sign in to pair a laptop"
              description={claimToken
                ? "This browser was opened by a local Conductor bridge command. Sign in so the currently-running machine can be paired to your account without a copy-paste code."
                : "Pairing codes are scoped to your authenticated dashboard session. Sign in first, then generate the one-time code for the laptop you want to connect."}
            />
            <div className="mt-8">
              <Button asChild variant="primary" size="lg">
                <Link href={`/sign-in?redirect_url=${encodeURIComponent(redirectTarget)}`}>Sign in with GitHub</Link>
              </Button>
            </div>
          </PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  if (!access.ok) {
    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto w-full max-w-3xl">
          <PublicPanel className="border-[color:color-mix(in_srgb,var(--vk-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] p-6 sm:p-8">
            <PublicSection
              eyebrow="Conductor Bridge"
              title="Bridge pairing is unavailable"
              description={access.reason ?? "The dashboard access policy denied this request."}
            />
          </PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  return <BridgeConnectClient initialClaimToken={claimToken} />;
}
