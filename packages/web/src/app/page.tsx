import { redirect } from "next/navigation";
import { getDashboardAccess, requiresPairedDeviceScope, resolveDashboardPageRedirect } from "@/lib/auth";
import DashboardClient from "@/features/dashboard/DashboardClient";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function toSearchString(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        search.append(key, entry);
      }
      continue;
    }
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  const serialized = search.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

export default async function Page({ searchParams }: PageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const redirectPath = await resolveDashboardPageRedirect(`/${toSearchString(resolvedSearchParams)}`);
  if (redirectPath) {
    redirect(redirectPath);
  }

  const access = await getDashboardAccess();

  return <DashboardClient requiresPairedDeviceScope={requiresPairedDeviceScope(access)} />;
}
