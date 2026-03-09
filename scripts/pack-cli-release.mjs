import { packCliReleasePackage } from "./cli-release-stage.mjs";

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--pack-destination") {
      options.packDestination = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--stage-dir") {
      options.stageDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--root-dir") {
      options.rootDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--published-name") {
      options.publishedName = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--publish-registry") {
      options.publishRegistry = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const { tarballPath } = packCliReleasePackage(parseArgs(process.argv.slice(2)));
console.log(tarballPath);
