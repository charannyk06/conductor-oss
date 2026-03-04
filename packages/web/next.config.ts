import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@conductor-oss/core"],
  // Silence "multiple lockfiles" warning — pin workspace root to the monorepo
  outputFileTracingRoot: resolve(process.cwd(), "../../"),
};

export default nextConfig;
