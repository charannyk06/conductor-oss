throw new Error(
  [
    "Manual `scripts/publish-cli-package.mjs` publishing is disabled.",
    "The CLI release now requires platform-specific native packages plus the main npm package.",
    "Use the GitHub Actions release workflow to publish a complete release.",
  ].join(" "),
);
