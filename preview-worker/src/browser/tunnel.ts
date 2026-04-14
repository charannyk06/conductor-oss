import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lookup } from "node:dns/promises";
import type { Readable } from "node:stream";
import { isLocalHost, normalizeNavigationHostname } from "../lib/security.js";
import { PreviewWorkerError } from "../lib/types.js";

const TRY_CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000;
const TUNNEL_DNS_POLL_INTERVAL_MS = 500;

export interface TunnelHandle {
  url: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  localOrigin: string;
}

function normalizeLocalOrigin(value: string): string {
  const parsed = new URL(value);
  if (!isLocalHost(parsed.hostname)) {
    throw new PreviewWorkerError(400, "Cloudflared tunnels only support localhost preview targets.");
  }

  if (parsed.hostname === "0.0.0.0") {
    parsed.hostname = "127.0.0.1";
  }

  parsed.hash = "";
  parsed.pathname = "";
  parsed.search = "";
  return parsed.toString();
}

function extractTunnelUrl(buffer: string): string | null {
  const matches = buffer.match(TRY_CLOUDFLARE_URL_PATTERN);
  if (!matches?.length) {
    return null;
  }
  const latest = matches[matches.length - 1];
  return latest ? latest.trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReachableTunnelUrl(
  tunnelUrl: string,
  timeoutMs = DEFAULT_TUNNEL_TIMEOUT_MS,
  lookupFn: typeof lookup = lookup,
): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(tunnelUrl).hostname;
  } catch {
    throw new PreviewWorkerError(500, `Invalid cloudflared tunnel URL: ${tunnelUrl}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const resolved = await lookupFn(hostname, { all: true });
      if (resolved.length > 0) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(TUNNEL_DNS_POLL_INTERVAL_MS);
  }

  const reason = lastError instanceof Error && lastError.message
    ? ` (${lastError.message})`
    : "";
  throw new PreviewWorkerError(408, `Timed out while waiting for a reachable cloudflared tunnel URL${reason}.`);
}

export async function startTunnel(
  value: string,
  cloudflaredBin: string,
  timeoutMs = DEFAULT_TUNNEL_TIMEOUT_MS,
): Promise<TunnelHandle> {
  const localOrigin = normalizeLocalOrigin(value);

  return await new Promise<TunnelHandle>((resolve, reject) => {
    let settled = false;
    let output = "";
    let verifyingTunnel = false;

    const child = spawn(cloudflaredBin, ["--url", localOrigin], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const inspectOutput = () => {
      if (verifyingTunnel) {
        return;
      }
      const tunnelUrl = extractTunnelUrl(output);
      if (!tunnelUrl) {
        return;
      }
      verifyingTunnel = true;

      void (async () => {
        try {
          await waitForReachableTunnelUrl(tunnelUrl, timeoutMs);
          finish(() => resolve({
            url: tunnelUrl,
            process: child,
            localOrigin,
          }));
        } catch (error) {
          finish(() => {
            child.kill("SIGTERM");
            reject(error instanceof PreviewWorkerError
              ? error
              : new PreviewWorkerError(500, error instanceof Error ? error.message : "Cloudflared tunnel failed"));
          });
        }
      })();
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 32_768) {
        output = output.slice(output.length - 32_768);
      }
      inspectOutput();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new PreviewWorkerError(408, "Timed out while waiting for cloudflared tunnel URL."));
      });
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      finish(() => reject(new PreviewWorkerError(500, `Failed to start cloudflared: ${error.message}`)));
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      finish(() => {
        reject(new PreviewWorkerError(
          500,
          `cloudflared exited before establishing a tunnel (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ));
      });
    });
  });
}

export async function stopTunnel(
  process: ChildProcessByStdio<null, Readable, Readable> | null,
): Promise<void> {
  if (!process || process.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once("exit", done);
    process.kill("SIGTERM");
    setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 3_000).unref();
  });
}

export function rewriteLoopbackUrl(url: string, tunnelUrl: string): string | null {
  try {
    const target = new URL(url);
    if (!isLocalHost(normalizeNavigationHostname(target.hostname))) {
      return null;
    }

    const tunnel = new URL(tunnelUrl);
    tunnel.pathname = target.pathname;
    tunnel.search = target.search;
    tunnel.hash = target.hash;
    return tunnel.toString();
  } catch {
    return null;
  }
}
