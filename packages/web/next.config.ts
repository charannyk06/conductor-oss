import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const isVercelDeployment = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "1; mode=block" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const developmentWebpackConfig: Pick<NextConfig, "webpack"> = {
  webpack(config) {
    config.watchOptions = {
      ...config.watchOptions,
      // Runtime sessions, restore snapshots, and detached worktrees live under .conductor.
      // Ignoring them prevents dashboard Fast Refresh churn while terminals are active.
      ignored: ["**/.conductor/**"],
    };
    return config;
  },
};

const nextConfig: NextConfig = {
  // Vercel's runtime loads the traced output directly. Forcing standalone there
  // produces CommonJS launcher -> ESM app module mismatches under this package's
  // `type: "module"` setting.
  output: isVercelDeployment ? undefined : "standalone",
  reactStrictMode: false,
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  ...(process.env.NODE_ENV === "development" ? developmentWebpackConfig : {}),
  serverExternalPackages: [
    "@conductor-oss/core",
    "@puppeteer/browsers",
    "puppeteer-core",
    "proxy-agent",
  ],
  // Silence "multiple lockfiles" warning — pin workspace root to the monorepo
  outputFileTracingRoot: workspaceRoot,
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
