const DEFAULT_LOCAL_RUST_BACKEND_URL = "http://127.0.0.1:4749";

function normalizeHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseConfiguredPort(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
}

export function resolveRustBackendUrl(): string | null {
  const explicitBackendUrl = normalizeHttpUrl(process.env.CONDUCTOR_BACKEND_URL);
  if (explicitBackendUrl) {
    return explicitBackendUrl;
  }

  const publicBackendUrl = normalizeHttpUrl(process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL);
  if (publicBackendUrl) {
    return publicBackendUrl;
  }

  const configuredPort = parseConfiguredPort(process.env.CONDUCTOR_BACKEND_PORT);
  if (configuredPort !== null) {
    return `http://127.0.0.1:${configuredPort}`;
  }

  const publicConfiguredPort = parseConfiguredPort(process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_PORT);
  if (publicConfiguredPort !== null) {
    return `http://127.0.0.1:${publicConfiguredPort}`;
  }

  if (process.env.NODE_ENV === "development") {
    return DEFAULT_LOCAL_RUST_BACKEND_URL;
  }

  return null;
}

export function requireRustBackendUrl(): string {
  const backendUrl = resolveRustBackendUrl();
  if (!backendUrl) {
    throw new Error("Rust backend URL is not configured");
  }
  return backendUrl;
}
