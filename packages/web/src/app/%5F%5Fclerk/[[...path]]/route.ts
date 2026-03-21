import { resolveClerkFrontendApiUrl } from "@/lib/clerkConfig";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

const FORWARDED_REQUEST_HEADERS = [
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
] as const;

function resolveProxyBaseUrl(request: NextRequest): string {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const protocol = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim() || request.nextUrl.host;
  return `${protocol}://${host}/__clerk`;
}

function resolveClientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "";
}

function buildUpstreamUrl(request: NextRequest, pathSegments: string[] | undefined): string {
  const frontendApiUrl = resolveClerkFrontendApiUrl();
  if (!frontendApiUrl) {
    throw new Error("Missing Clerk frontend API URL");
  }

  const suffix = (pathSegments ?? []).join("/");
  const pathname = suffix ? `/${suffix}` : "";
  const search = request.nextUrl.search || "";
  return `${frontendApiUrl}${pathname}${search}`;
}

function rewriteRedirectLocation(location: string, proxyBaseUrl: string, frontendApiUrl: string): string {
  if (location.startsWith(frontendApiUrl)) {
    return `${proxyBaseUrl}${location.slice(frontendApiUrl.length)}`;
  }
  return location;
}

function buildUpstreamHeaders(request: NextRequest, secretKey: string): Headers {
  const headers = new Headers();
  for (const headerName of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  headers.set("Clerk-Secret-Key", secretKey);
  headers.set("User-Agent", "ConductorClerkProxy/1.0");
  if (!headers.has("Accept")) {
    headers.set("Accept", "*/*");
  }

  const clientIp = resolveClientIp(request);
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
  }

  return headers;
}

async function proxyClerkRequest(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    return Response.json(
      { error: "Clerk proxy is unavailable", reason: "Missing CLERK_SECRET_KEY" },
      { status: 500 },
    );
  }

  const { path } = await context.params;
  const proxyBaseUrl = resolveProxyBaseUrl(request);
  const frontendApiUrl = resolveClerkFrontendApiUrl();
  if (!frontendApiUrl) {
    return Response.json(
      { error: "Clerk proxy is unavailable", reason: "Missing Clerk frontend API URL" },
      { status: 500 },
    );
  }

  const upstreamUrl = buildUpstreamUrl(request, path);
  const headers = buildUpstreamHeaders(request, secretKey);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half",
  };

  const upstreamResponse = await fetch(upstreamUrl, init);
  const responseBody = await upstreamResponse.arrayBuffer();
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  const location = responseHeaders.get("location");
  if (location) {
    responseHeaders.set("location", rewriteRedirectLocation(location, proxyBaseUrl, frontendApiUrl));
  }

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyClerkRequest(request, context);
}
