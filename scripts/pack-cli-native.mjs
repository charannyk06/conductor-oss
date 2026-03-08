import { packCliNativeReleasePackage } from "./cli-native-packages.mjs";

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

    if (arg === "--target") {
      options.targetId = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--binary-path") {
      options.binaryPath = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.targetId) {
    throw new Error("Missing required --target argument.");
  }
  if (!options.binaryPath) {
    throw new Error("Missing required --binary-path argument.");
  }

  return options;
}

const { tarballPath } = packCliNativeReleasePackage(parseArgs(process.argv.slice(2)));
console.log(tarballPath);
