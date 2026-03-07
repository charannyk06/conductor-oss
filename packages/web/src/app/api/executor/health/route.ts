import { NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { getExecutionBackend } from "@/lib/executionBackend";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const payload = await getExecutionBackend().health();
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load executor health";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
