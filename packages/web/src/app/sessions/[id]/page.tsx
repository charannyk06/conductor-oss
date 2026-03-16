import { redirect } from "next/navigation";
import { resolveDashboardPageRedirect } from "@/lib/auth";
import { SessionPageClient } from "@/features/sessions/SessionPageClient";

export const dynamic = "force-dynamic";

type SessionPageProps = {
  params: Promise<{ id: string }>;
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

export default async function SessionPage({ params, searchParams }: SessionPageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const redirectPath = await resolveDashboardPageRedirect(
    `/sessions/${encodeURIComponent(id)}${toSearchString(resolvedSearchParams)}`,
  );
  if (redirectPath) {
    redirect(redirectPath);
  }

  return <SessionPageClient />;
}
