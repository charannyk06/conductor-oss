import type { NextConfig } from "next";
import { resolve } from "node:path";

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
};

export default nextConfig;
