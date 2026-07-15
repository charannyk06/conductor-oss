#!/usr/bin/env node

import { assertCliReleaseTarballEquivalence } from "./release-workflow-lib.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--public-tarball") {
      options.publicTarball = argv[++index];
    } else if (argument === "--github-tarball") {
      options.githubTarball = argv[++index];
    } else if (argument === "--version") {
      options.version = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  for (const name of ["publicTarball", "githubTarball", "version"]) {
    if (!options[name]) {
      throw new Error(`missing required ${name}`);
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
assertCliReleaseTarballEquivalence(options);
console.log(`Verified equivalent public and GitHub CLI artifacts for ${options.version}.`);
