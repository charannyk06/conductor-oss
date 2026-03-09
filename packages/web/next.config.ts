import type { NextConfig } from "next";
import { resolve } from "node:path";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "1; mode=block" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  serverExternalPackages: [
    "@conductor-oss/core",
    "@puppeteer/browsers",
    "puppeteer-core",
    "proxy-agent",
  ],
  // Silence "multiple lockfiles" warning — pin workspace root to the monorepo
  outputFileTracingRoot: resolve(process.cwd(), "../../"),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
