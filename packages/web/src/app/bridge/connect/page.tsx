import Link from "next/link";
import { Button } from "@/components/ui/Button";
import BridgeConnectClient from "@/features/bridge/BridgeConnectClient";
import { getDashboardAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function BridgeConnectPage() {
  const access = await getDashboardAccess();
  const requiresSignIn = access.provider === "clerk" && !access.authenticated;

  if (requiresSignIn) {
    return (
      <main className="min-h-dvh bg-[var(--vk-bg-main)] px-6 py-8 text-[var(--vk-text-normal)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-8 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
              Conductor Bridge
            </p>
            <h1 className="mt-4 text-3xl font-semibold text-[var(--vk-text-strong)]">Sign in to pair a laptop</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--vk-text-muted)]">
              Pairing codes are scoped to your authenticated dashboard session. Sign in first, then generate the one-time code for the laptop you want to connect.
            </p>
            <div className="mt-8">
              <Button asChild variant="primary" size="lg">
                <Link href="/sign-in?redirect_url=%2Fbridge%2Fconnect">Sign in with GitHub</Link>
              </Button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (!access.ok) {
    return (
      <main className="min-h-dvh bg-[var(--vk-bg-main)] px-6 py-8 text-[var(--vk-text-normal)]">
        <div className="mx-auto w-full max-w-3xl rounded-[24px] border border-[color:color-mix(in_srgb,var(--vk-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] p-8 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
            Conductor Bridge
          </p>
          <h1 className="mt-4 text-3xl font-semibold text-[var(--vk-text-strong)]">Bridge pairing is unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--vk-text-muted)]">
            {access.reason ?? "The dashboard access policy denied this request."}
          </p>
        </div>
      </main>
    );
  }

  return <BridgeConnectClient />;
}
